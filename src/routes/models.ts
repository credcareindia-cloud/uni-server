import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Helper function to check if user has access to a project
 */
const checkProjectAccess = async (projectId: number, userId: string, userRole: string) => {
  // ADMIN users have access to all projects in their organization
  if (userRole === 'ADMIN') {
    return true;
  }
  
  // Check if user is a member of the project
  const membership = await prisma.projectMember.findFirst({
    where: {
      projectId,
      userId
    }
  });
  
  return !!membership;
};

const router = Router();

// Validation schemas
const querySchema = z.object({
  page: z.string().transform(val => parseInt(val) || 1).optional(),
  limit: z.string().transform(val => Math.min(parseInt(val) || 10, 100)).optional(),
  type: z.enum(['IFC', 'FRAG']).optional(),
  status: z.enum(['UPLOADED', 'PROCESSING', 'READY', 'FAILED']).optional(),
});

const elementQuerySchema = z.object({
  page: z.string().transform(val => parseInt(val) || 1).optional(),
  limit: z.string().transform(val => Math.min(parseInt(val) || 50, 1000)).optional(),
  ifcType: z.string().optional(),
  storey: z.string().optional(),
  search: z.string().optional(),
});

/**
 * GET /api/models/:id/metadata
 * Get model metadata with storeys and panels
 */
router.get('/:id/metadata', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;

  const model = await prisma.model.findFirst({
    where: {
      id
    },
    select: {
      id: true,
      projectId: true,
      elementCount: true,
      spatialStructure: true,
      originalFilename: true,
      type: true,
      status: true
    }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  // Check project access
  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  res.json({
    success: true,
    model: {
      id: model.id,
      filename: model.originalFilename,
      type: model.type,
      status: model.status,
      totalElements: model.elementCount || 0,
      spatialStructure: model.spatialStructure || []
    }
  });
}));

/**
 * GET /api/models/:id/color-map
 * Revit system/material colours captured at publish (e.g. DCW = #0000FF).
 */
router.get('/:id/color-map', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const model = await prisma.model.findFirst({
    where: { id },
    select: {
      id: true,
      projectId: true,
      spatialStructure: true,
    },
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  const spatial = model.spatialStructure as any;
  const colorMap =
    spatial && typeof spatial === 'object' && !Array.isArray(spatial) && spatial.colorMap
      ? spatial.colorMap
      : null;

  const byGlobalId: Record<string, string> = {
    ...((colorMap && colorMap.byIfcGuid) || {}),
  };
  const byElementId: Record<string, string> = {
    ...((colorMap && colorMap.byElementId) || {}),
  };

  // Bridge Revit ElementId → real IFC GlobalId.
  // Our UniqueId→IfcGuid conversion often differs from Revit's IFC export GUIDs,
  // but IFC Name usually ends with ":ElementId" (e.g. Pipe Types:Standard:1473931).
  try {
    const elements = await prisma.modelElement.findMany({
      where: { modelId: id },
      select: { expressId: true, globalId: true, properties: true },
      take: 100000,
    });
    let remapped = 0;
    for (const el of elements) {
      const props = (el.properties as Record<string, unknown> | null) || {};
      const storedColor = typeof props.Color === 'string' ? props.Color : null;
      const tag = typeof props.Tag === 'string' ? props.Tag : null;
      const name = typeof props.Name === 'string' ? props.Name : null;
      const idFromName = name ? name.match(/:(\d+)\s*$/)?.[1] : null;
      const revitId = (tag && /^\d+$/.test(tag) ? tag : null) || idFromName;

      let color = storedColor;
      if (!color && revitId && byElementId[revitId]) color = byElementId[revitId];

      if (!color) continue;
      if (el.globalId) {
        byGlobalId[el.globalId] = color;
        remapped++;
      }
      if (revitId) byElementId[revitId] = color;
      if (tag) byElementId[tag] = color;
    }
    if (remapped > 0) {
      logger.info(`color-map ${id}: remapped ${remapped} colours onto IFC GlobalIds via Name/Tag`);
    }
  } catch (err) {
    logger.warn(`color-map element scan failed for ${id}:`, err);
  }

  res.json({
    success: true,
    modelId: id,
    colorMap,
    byGlobalId,
    byElementId,
    count: Object.keys(byGlobalId).length || Object.keys(byElementId).length,
  });
}));

/**
 * GET /api/models/:id/bimsf-map
 * Revit BIMSF_Container (panel id) map captured at publish.
 */
router.get('/:id/bimsf-map', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const model = await prisma.model.findFirst({
    where: { id },
    select: {
      id: true,
      projectId: true,
      category: true,
      displayName: true,
      originalFilename: true,
      spatialStructure: true,
    },
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  const spatial = model.spatialStructure as any;
  const bimsfMap =
    spatial && typeof spatial === 'object' && !Array.isArray(spatial) && spatial.bimsfMap
      ? spatial.bimsfMap
      : null;

  const byGlobalId: Record<string, string> = {
    ...((bimsfMap && bimsfMap.byIfcGuid) || {}),
  };
  const byElementId: Record<string, string> = {
    ...((bimsfMap && bimsfMap.byElementId) || {}),
  };

  // Bridge ElementId → real IFC GlobalId via Name "...:12345" (same as color remap)
  try {
    const elements = await prisma.modelElement.findMany({
      where: { modelId: id },
      select: { globalId: true, properties: true },
      take: 100000,
    });
    for (const el of elements) {
      const props = (el.properties as Record<string, unknown> | null) || {};
      const stored = typeof props.BIMSF_Container === 'string' ? props.BIMSF_Container : null;
      const tag = typeof props.Tag === 'string' ? props.Tag : null;
      const name = typeof props.Name === 'string' ? props.Name : null;
      const idFromName = name ? name.match(/:(\d+)\s*$/)?.[1] : null;
      const revitId = (tag && /^\d+$/.test(tag) ? tag : null) || idFromName;

      let bimsf = stored;
      if (!bimsf && revitId && byElementId[revitId]) bimsf = byElementId[revitId];
      if (!bimsf) continue;

      if (el.globalId) byGlobalId[el.globalId] = bimsf;
      if (revitId) byElementId[revitId] = bimsf;
    }
  } catch (err) {
    logger.warn(`bimsf-map element scan failed for ${id}:`, err);
  }

  const normalize = (v: string) => String(v || '').replace(/^\*/, '').trim();
  const panelsMap = new Map<string, { id: string; displayName: string; bimsf: string; count: number }>();
  for (const raw of Object.values(byGlobalId)) {
    const display = normalize(raw) || raw;
    const key = display.toLowerCase();
    const existing = panelsMap.get(key);
    if (existing) existing.count += 1;
    else panelsMap.set(key, { id: display, displayName: display, bimsf: raw, count: 1 });
  }
  // Always include publish-sidecar panels (e.g. FT assemblies) even if GlobalId remap missed some
  if (bimsfMap?.byPanel && typeof bimsfMap.byPanel === 'object') {
    for (const [panelId, info] of Object.entries(bimsfMap.byPanel as Record<string, any>)) {
      const display = normalize((info as any)?.displayName || panelId) || panelId;
      const key = display.toLowerCase();
      if (!panelsMap.has(key)) {
        panelsMap.set(key, {
          id: display,
          displayName: display,
          bimsf: (info as any)?.bimsf || panelId,
          count: Number((info as any)?.count) || ((info as any)?.elementIds?.length) || 0,
        });
      }
    }
  } else if (bimsfMap?.panels && Array.isArray(bimsfMap.panels)) {
    for (const p of bimsfMap.panels) {
      const display = normalize(p.displayName || p.id || p.bimsf) || p.id;
      const key = String(display || '').toLowerCase();
      if (!key || panelsMap.has(key)) continue;
      panelsMap.set(key, {
        id: display,
        displayName: display,
        bimsf: p.bimsf || p.id,
        count: p.count || 0,
      });
    }
  }

  res.json({
    success: true,
    modelId: id,
    category: model.category,
    displayName: model.displayName || model.originalFilename,
    bimsfMap,
    byGlobalId,
    byElementId,
    panels: [...panelsMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    count: Object.keys(byGlobalId).length || Object.keys(byElementId).length,
  });
}));

/**
 * GET /api/models/:id
 * Get model details and metadata
 */
router.get('/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;

  const model = await prisma.model.findFirst({
    where: {
      id
    },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          createdBy: true
        }
      },
      _count: {
        select: {
          elements: true
        }
      }
    }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  // Check project access
  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  // Generate download URL if model is ready
  let downloadUrl = null;
  if (model.status === 'READY') {
    try {
      downloadUrl = await storageService.getDownloadUrl(model.storageKey, 3600); // 1 hour expiry
    } catch (error) {
      logger.warn(`Failed to generate download URL for model ${id}:`, error);
    }
  }

  // Get element type summary
  const elementTypeSummary = await prisma.modelElement.groupBy({
    by: ['ifcType'],
    where: { modelId: id },
    _count: { ifcType: true },
    orderBy: { _count: { ifcType: 'desc' } }
  });

  // Get storey summary
  const storeySummary = await prisma.modelElement.groupBy({
    by: ['storey'],
    where: { 
      modelId: id,
      storey: { not: null }
    },
    _count: { storey: true },
    orderBy: { _count: { storey: 'desc' } }
  });

  const transformedModel = {
    id: model.id,
    projectId: model.projectId,
    originalFilename: model.originalFilename,
    type: model.type.toLowerCase(),
    status: model.status.toLowerCase(),
    sizeBytes: Number(model.sizeBytes),
    processingProgress: model.processingProgress,
    errorMessage: model.errorMessage,
    elementCount: model.elementCount,
    spatialStructure: model.spatialStructure,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    downloadUrl,
    project: model.project,
    summary: {
      totalElements: model.elementCount || 0,
      elementTypes: elementTypeSummary.map(item => ({
        type: item.ifcType,
        count: item._count.ifcType
      })),
      storeys: storeySummary.map(item => ({
        storey: item.storey,
        count: item._count.storey
      }))
    }
  };

  res.json({ model: transformedModel });
}));

/**
 * GET /api/models/:id/download-url
 * Return a pre-signed URL for direct download from S3/CloudFront
 * Allows viewers and managers of the project to download
 */
router.get('/:id/download-url', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  // Optional expiry override, default 3600s, clamp between 60s and 86400s (24h)
  const rawExpires = Number((req.query?.expires as string) || 3600);
  const expiresIn = Math.min(Math.max(isNaN(rawExpires) ? 3600 : rawExpires, 60), 86400);

  // Get model and its project info
  const model = await prisma.model.findFirst({
    where: {
      id
    },
    select: {
      projectId: true,
      status: true,
      storageKey: true,
      originalFilename: true
    }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  // Check project access
  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  if (model.status !== 'READY') {
    throw createApiError('Model is not ready for download', 409);
  }

  try {
    const url = await storageService.getDownloadUrl(model.storageKey, expiresIn);
    return res.json({
      url,
      // Same-origin stream — works through Vite/Cloudflare when MinIO is only on localhost
      proxyUrl: `/api/models/${id}/download`,
      expiresIn,
      filename: model.originalFilename
    });
  } catch (error) {
    logger.error(`Failed to generate download URL for model ${id}:`, error);
    throw createApiError('Failed to generate download URL', 500);
  }
}));

/**
 * GET /api/models/:id/download
 * Stream the .frag file through the API (auth + project access).
 * Used when MinIO is not reachable from the browser (LAN / Cloudflare tunnel).
 */
router.get('/:id/download', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const model = await prisma.model.findFirst({
    where: { id },
    select: {
      projectId: true,
      status: true,
      storageKey: true,
      originalFilename: true,
    },
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  if (model.status !== 'READY') {
    throw createApiError('Model is not ready for download', 409);
  }

  try {
    const fileBuffer = await storageService.downloadFile(model.storageKey);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${model.originalFilename || `${id}.frag`}"`
    );
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(fileBuffer);
  } catch (error) {
    logger.error(
      `Failed to stream model ${id}: ${(error as any)?.name || 'Error'} ${(error as any)?.message || error}`
    );
    throw createApiError('Failed to download model', 500);
  }
}));

/**
 * GET /api/models/:id/elements
 * Get model elements with filtering and pagination
 */
router.get('/:id/elements', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const { page = 1, limit = 50, ifcType, storey, search } = elementQuerySchema.parse(req.query);
  const skip = (page - 1) * limit;

  // Verify model access
  const model = await prisma.model.findFirst({
    where: {
      id
    },
    select: { id: true, projectId: true }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  // Check project access
  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  // Build where clause
  const where: any = { modelId: id };

  if (ifcType) {
    where.ifcType = ifcType;
  }

  if (storey) {
    where.storey = storey;
  }

  if (search) {
    where.OR = [
      { globalId: { contains: search, mode: 'insensitive' } },
      { ifcType: { contains: search, mode: 'insensitive' } },
      { properties: { path: ['Name'], string_contains: search } }
    ];
  }

  // Get elements
  const [elements, total] = await Promise.all([
    prisma.modelElement.findMany({
      where,
      skip,
      take: limit,
      orderBy: { expressId: 'asc' },
      select: {
        id: true,
        expressId: true,
        globalId: true,
        ifcType: true,
        storey: true,
        space: true,
        bbox: true,
        properties: true,
        createdAt: true
      }
    }),
    prisma.modelElement.count({ where })
  ]);

  res.json({
    elements,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
}));

/**
 * GET /api/models/:id/elements/:expressId
 * Get specific element details
 */
router.get('/:id/elements/:expressId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id, expressId } = req.params;

  // Verify model access
  const model = await prisma.model.findFirst({
    where: {
      id
    },
    select: { id: true, projectId: true }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  // Check project access
  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  const element = await prisma.modelElement.findUnique({
    where: {
      modelId_expressId: {
        modelId: id,
        expressId: parseInt(expressId)
      }
    }
  });

  if (!element) {
    throw createApiError('Element not found', 404);
  }

  res.json({ element });
}));

/**
 * GET /api/models/:id/summary
 * Get model summary statistics
 */
router.get('/:id/summary', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;

  // Verify model access
  const model = await prisma.model.findFirst({
    where: {
      id
    },
    select: {
      id: true,
      projectId: true,
      status: true,
      processingProgress: true,
      elementCount: true,
      spatialStructure: true
    }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  // Check project access
  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  // Get real-time counts
  const [totalElements, elementTypes, storeys] = await Promise.all([
    prisma.modelElement.count({ where: { modelId: id } }),
    prisma.modelElement.groupBy({
      by: ['ifcType'],
      where: { modelId: id },
      _count: { ifcType: true },
      orderBy: { _count: { ifcType: 'desc' } },
      take: 20 // Top 20 types
    }),
    prisma.modelElement.groupBy({
      by: ['storey'],
      where: { 
        modelId: id,
        storey: { not: null }
      },
      _count: { storey: true },
      orderBy: { _count: { storey: 'desc' } }
    })
  ]);

  const summary = {
    status: model.status.toLowerCase(),
    processingProgress: model.processingProgress,
    totalElements,
    spatialStructure: model.spatialStructure,
    elementTypes: elementTypes.map(item => ({
      type: item.ifcType,
      count: item._count.ifcType
    })),
    storeys: storeys.map(item => ({
      storey: item.storey,
      count: item._count.storey
    })),
    lastUpdated: new Date().toISOString()
  };

  res.json({ summary });
}));

/**
 * GET /api/models/:id/progress
 * Get real-time processing progress (SSE endpoint)
 */
router.get('/:id/progress', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;

  // Verify model access
  const model = await prisma.model.findFirst({
    where: {
      id
    },
    select: { id: true, projectId: true, status: true, processingProgress: true }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  // Check project access
  const hasAccess = await checkProjectAccess(model.projectId, req.user.id, req.user.role);
  if (!hasAccess) {
    throw createApiError('You do not have access to this model', 403);
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send initial progress
  const sendProgress = async () => {
    try {
      const currentModel = await prisma.model.findUnique({
        where: { id },
        select: {
          status: true,
          processingProgress: true,
          errorMessage: true,
          elementCount: true,
          _count: {
            select: { elements: true }
          }
        }
      });

      if (currentModel) {
        const progressData = {
          status: currentModel.status.toLowerCase(),
          progress: currentModel.processingProgress || 0,
          elementsProcessed: currentModel.elementCount || 0,
          totalElements: currentModel.elementCount,
          errorMessage: currentModel.errorMessage,
          timestamp: new Date().toISOString()
        };

        res.write(`data: ${JSON.stringify(progressData)}\n\n`);

        // Stop sending updates if processing is complete
        if (currentModel.status === 'READY' || currentModel.status === 'FAILED') {
          res.end();
          return;
        }
      }
    } catch (error) {
      logger.error('Error sending progress update:', error);
      res.end();
    }
  };

  // Send progress immediately
  await sendProgress();

  // Set up interval for updates (every 2 seconds)
  const interval = setInterval(sendProgress, 2000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });

  req.on('error', () => {
    clearInterval(interval);
    res.end();
  });
}));

/**
 * DELETE /api/models/:id
 * Delete a model and its associated data
 * Only project owners and managers can delete
 */
router.delete('/:id', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;

  // Get model
  const model = await prisma.model.findFirst({
    where: {
      id
    },
    select: {
      id: true,
      projectId: true,
      storageKey: true,
      originalFilename: true,
      project: {
        select: {
          createdBy: true
        }
      }
    }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  // Check delete permission (only ADMIN, project owner, or MANAGER can delete)
  const isAdmin = req.user.role === 'ADMIN';
  const isOwner = model.project.createdBy === req.user.id;
  const isMember = await prisma.projectMember.findFirst({
    where: {
      projectId: model.projectId,
      userId: req.user.id,
      role: 'MANAGER'
    }
  });

  if (!isAdmin && !isOwner && !isMember) {
    throw createApiError('You do not have permission to delete this model', 403);
  }

  // Delete from storage
  try {
    await storageService.deleteFile(model.storageKey);
  } catch (error) {
    logger.warn(`Failed to delete file from storage: ${model.storageKey}`, error);
  }

  // Delete from database (cascade will handle elements)
  await prisma.model.delete({
    where: { id }
  });

  logger.info(`Model deleted: ${model.originalFilename} by ${req.user.email}`);

  res.json({
    message: 'Model deleted successfully'
  });
}));

export { router as modelRoutes };
