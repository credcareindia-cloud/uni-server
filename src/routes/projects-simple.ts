import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireProjectRole } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { storageService } from '../config/storage.js';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Validation schemas
const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(255, 'Project name too long'),
  description: z.string().optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(255, 'Project name too long').optional(),
  description: z.string().optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
});

const querySchema = z.object({
  page: z.string().transform(val => parseInt(val) || 1).optional(),
  limit: z.string().transform(val => Math.min(parseInt(val) || 10000, 10000)).optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
  search: z.string().optional(),
});

/**
 * Helper function to resolve project ID
 * Uses global ID - displayNumber is only for display purposes
 */
async function resolveProjectId(idParam: string): Promise<number | null> {
  const id = parseInt(idParam);
  if (isNaN(id)) return null;
  return id;
}

/**
 * GET /api/projects
 * Get all projects for the authenticated user
 */
router.get('/', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { page = 1, limit = 10, status, search } = querySchema.parse(req.query);
  const skip = (page - 1) * limit;

  // Build where clause - all users see only projects in their organization
  // Admins see all projects in their org, others see only their memberships within their org
  const baseWhere: any = {
    organizationId: req.user.organizationId // ALL queries must filter by organization
  };

  const where: any = req.user.role === 'ADMIN'
    ? baseWhere // Admins see all projects in their organization
    : {
      ...baseWhere,
      members: {
        some: {
          userId: req.user.id
        }
      }
    };

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }

  // Get projects with basic info
  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            modelHistory: true,
            groups: true,
            panels: true
          }
        },
        currentModel: {
          select: {
            id: true,
            type: true,
            status: true,
            sizeBytes: true,
            version: true,
            isActive: true
          }
        },
        modelHistory: {
          select: {
            id: true,
            type: true,
            status: true,
            sizeBytes: true,
            version: true,
            isActive: true,
            createdAt: true
          }
        },
        members: {
          where: { userId: req.user.id },
          select: { role: true }
        }
      }
    }),
    prisma.project.count({ where })
  ]);

  // Transform response
  const transformedProjects = projects.map(project => ({
    id: String(project.id),
    displayNumber: project.displayNumber,
    name: project.name,
    description: project.description,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    currentModel: project.currentModel ? {
      ...project.currentModel,
      sizeBytes: Number(project.currentModel.sizeBytes)
    } : null,
    modelHistory: project.modelHistory.map(model => ({
      ...model,
      sizeBytes: Number(model.sizeBytes)
    })),
    stats: {
      totalModels: project._count.modelHistory,
      totalGroups: project._count.groups,
      totalPanels: project._count.panels
    },
    userRole: (project.members as any)?.length > 0 ? (project.members as any)[0].role : undefined
  }));

  res.json({
    projects: transformedProjects,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
}));

/**
 * GET /api/projects/:id
 * Get a specific project by ID (supports both global ID and displayNumber)
 */
router.get('/:id', requireProjectRole('VIEWER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const projectId = await resolveProjectId(id);

  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  const project = await prisma.project.findUnique({
    where: {
      id: projectId
    },
    include: {
      _count: {
        select: {
          modelHistory: true,
          groups: true,
          panels: true
        }
      },
      currentModel: {
        select: {
          id: true,
          originalFilename: true,
          type: true,
          status: true,
          sizeBytes: true,
          version: true,
          isActive: true,
          processingProgress: true,
          elementCount: true,
          spatialStructure: true,
          category: true,
          displayName: true,
          isMultiFile: true,
          createdAt: true,
          updatedAt: true
        }
      },
      modelHistory: {
        select: {
          id: true,
          originalFilename: true,
          type: true,
          status: true,
          sizeBytes: true,
          version: true,
          isActive: true,
          processingProgress: true,
          elementCount: true,
          spatialStructure: true,
          category: true,
          displayName: true,
          isMultiFile: true,
          createdAt: true,
          updatedAt: true
        },
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  if (!project) {
    throw createApiError('Project not found', 404);
  }

  // Transform response
  const transformedProject = {
    id: String(project.id),
    displayNumber: project.displayNumber,
    name: project.name,
    description: project.description,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    currentModel: project.currentModel ? {
      ...project.currentModel,
      sizeBytes: Number(project.currentModel.sizeBytes)
    } : null,
    modelHistory: project.modelHistory.map(model => ({
      ...model,
      sizeBytes: Number(model.sizeBytes)
    })),
    stats: {
      totalModels: project._count.modelHistory,
      totalGroups: project._count.groups,
      totalPanels: project._count.panels,
      totalSize: project.modelHistory.reduce((sum, model) => sum + Number(model.sizeBytes), 0),
      readyModels: project.modelHistory.filter(m => m.status === 'READY').length,
      processingModels: project.modelHistory.filter(m => m.status === 'PROCESSING').length
    }
  };

  res.json(transformedProject);
}));

/**
 * POST /api/projects
 * DISABLED: Projects can only be created with models via /api/create-project-with-model
 * This enforces the model-first approach where every project must have a model
 */
router.post('/', asyncHandler(async (req: any, res: Response) => {
  res.status(400).json({
    error: 'Standalone project creation is not allowed',
    message: 'Projects can only be created with a model. Please use the model upload feature to create a project.',
    redirectTo: '/api/create-project-with-model',
    timestamp: new Date().toISOString()
  });
}));

/**
 * PUT /api/projects/:id
 * Update a project (supports both global ID and displayNumber)
 */
router.put('/:id', requireProjectRole('MANAGER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const projectId = await resolveProjectId(id);
  const updateData = updateProjectSchema.parse(req.body);

  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      ...(updateData.name && { name: updateData.name }),
      ...(updateData.description !== undefined && { description: updateData.description }),
      ...(updateData.status && { status: updateData.status })
    },
    include: {
      _count: {
        select: {
          modelHistory: true,
          groups: true,
          panels: true
        }
      }
    }
  });

  logger.info(`Project updated: ${project.name} by ${req.user.email}`);

  // Transform response
  const transformedProject = {
    id: project.id,
    displayNumber: project.displayNumber,
    name: project.name,
    description: project.description,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    stats: {
      totalModels: project._count.modelHistory,
      totalGroups: project._count.groups,
      totalPanels: project._count.panels
    }
  };

  res.json({
    message: 'Project updated successfully',
    project: transformedProject
  });
}));

import { enqueueDeletion } from '../queue/index.js';

/**
 * Update deletion status (called by worker)
 */
export async function updateDeletionStatus(
  jobId: string,
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED',
  progress: number,
  message: string,
  error?: string
) {
  try {
    const updateData: any = {
      status,
      progress,
      message
    };

    if (error) {
      updateData.error = error;
    }

    if (status === 'COMPLETED') {
      updateData.completedAt = new Date();
    }

    await prisma.projectDeletion.update({
      where: { id: jobId },
      data: updateData
    });

    logger.info(`Deletion job ${jobId} updated: ${status} (${progress}%) - ${message}`);
  } catch (err) {
    logger.error(`Failed to update deletion job ${jobId}:`, err);
  }
}

/**
 * GET /api/projects/deletions/:jobId
 * Check status of a deletion job
 */
router.get('/deletions/:jobId', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { jobId } = req.params;

  const job = await prisma.projectDeletion.findUnique({
    where: { id: jobId }
  });

  if (!job) {
    throw createApiError('Deletion job not found', 404);
  }

  // Only allow the user who started it or admins to see status
  if (job.deletedBy !== req.user.id && req.user.role !== 'ADMIN') {
    throw createApiError('Unauthorized', 403);
  }

  res.json(job);
}));

/**
 * DELETE /api/projects/:id/safe-delete
 * Start async project deletion
 */
router.delete('/:id/safe-delete', requireProjectRole('MANAGER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const projectId = await resolveProjectId(id);

  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true }
  });

  if (!project) {
    throw createApiError('Project not found', 404);
  }

  logger.info(`Initiating async deletion for project: ${project.name} (ID: ${projectId}) by ${req.user.email}`);

  // Create deletion job record
  const job = await prisma.projectDeletion.create({
    data: {
      projectId,
      projectName: project.name,
      status: 'PENDING',
      progress: 0,
      message: 'Queued for deletion',
      deletedBy: req.user.id
    }
  });

  // Enqueue the job
  enqueueDeletion({
    jobId: job.id,
    projectId,
    userId: req.user.id
  });

  res.json({
    message: 'Project deletion started',
    jobId: job.id,
    statusUrl: `/api/projects/deletions/${job.id}`
  });
}));

/**
 * POST /api/projects/:id/force-cleanup
 * Force cleanup of stuck/zombie projects (ADMIN only)
 * Uses very small batch sizes and delays to avoid timeouts
 */
router.post('/:id/force-cleanup', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  // Only admins can force cleanup
  if (req.user.role !== 'ADMIN') {
    throw createApiError('Only admins can force cleanup projects', 403);
  }

  const { id } = req.params;
  const projectId = await resolveProjectId(id);

  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      name: true,
      _count: {
        select: {
          panels: true,
          groups: true,
          statuses: true,
          modelHistory: true
        }
      }
    }
  });

  if (!project) {
    throw createApiError('Project not found', 404);
  }

  logger.info(`🧹 FORCE CLEANUP initiated for project: ${project.name} (ID: ${projectId}) by ${req.user.email}`);
  logger.info(`   Panels: ${project._count.panels}, Groups: ${project._count.groups}, Statuses: ${project._count.statuses}, Models: ${project._count.modelHistory}`);

  // Larger batch size to speed up deletion
  const BATCH_SIZE = 500;
  const DELAY_MS = 10;

  try {
    let totalDeleted = {
      panelStatuses: 0,
      panelGroups: 0,
      statusHistory: 0,
      panels: 0,
      groups: 0,
      statuses: 0,
      modelElements: 0,
      models: 0,
      members: 0
    };

    // Step 1: Query all Panel IDs and Model IDs upfront
    const panels = await prisma.panel.findMany({
      where: { projectId },
      select: { id: true }
    });
    const panelIds = panels.map(p => p.id);

    const modelsQuery = await prisma.model.findMany({
      where: { projectId },
      select: { id: true }
    });
    const modelIds = modelsQuery.map(m => m.id);

    // Helper to process in chunks
    const deleteInBatches = async (ids: string[], deleteFn: (batchIds: string[]) => Promise<any>, counterKey: keyof typeof totalDeleted) => {
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const batch = ids.slice(i, i + BATCH_SIZE);
            const result = await deleteFn(batch);
            totalDeleted[counterKey] += batch.length;
            await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        }
    };

    // Delete QRCodes & UserPanelViews
    await prisma.qRCode.deleteMany({ where: { projectId } }).catch(() => {});
    if (panelIds.length > 0) {
        let deletedViews = 0;
        await deleteInBatches(panelIds, async (batchIds) => {
            const res = await prisma.userPanelView.deleteMany({ where: { panelId: { in: batchIds } } }).catch(() => ({ count: 0 }));
            if (res) deletedViews += res.count;
        }, "panelStatuses"); // using existing counter fields or skip counting
    }

    // Delete panels (cascades automatically for statuses and groups)
    if (panelIds.length > 0) {
        await deleteInBatches(panelIds, async (batchIds) => {
            await prisma.panel.deleteMany({ where: { id: { in: batchIds } } });
        }, "panels");
    }

    // Delete groups and statuses
    const deletedGroups = await prisma.group.deleteMany({ where: { projectId } });
    totalDeleted.groups = deletedGroups.count;
    const deletedStatuses = await prisma.status.deleteMany({ where: { projectId } });
    totalDeleted.statuses = deletedStatuses.count;

    // Note: Model elements will be automatically deleted when their parent model is deleted
    // due to Prisma's `onDelete: Cascade` relation on ModelElement -> Model.
    // We do not need to manually delete them here.

    // Delete models
    if (modelIds.length > 0) {
        const deletedModels = await prisma.model.deleteMany({ where: { projectId } });
        totalDeleted.models = deletedModels.count;
    }

    // Delete project members
    const deletedMembers = await prisma.projectMember.deleteMany({ where: { projectId } });
    totalDeleted.members = deletedMembers.count;

    // Delete deletion jobs except this? No wait, this is force cleanup, delete all jobs
    await prisma.projectDeletion.deleteMany({ where: { projectId } }).catch(() => {});

    // Delete the project
    await prisma.project.delete({ where: { id: projectId } });

    logger.info(`✅ FORCE CLEANUP completed for project ${projectId}`);
    logger.info(`   Summary: ${JSON.stringify(totalDeleted)}`);

    res.json({
      message: 'Project force cleanup completed successfully',
      projectId,
      deleted: totalDeleted
    });

  } catch (error) {
    logger.error(`❌ Force cleanup failed for project ${projectId}:`, error);
    throw createApiError('Force cleanup failed', 500);
  }
}));

/**
 * DELETE /api/projects/:id
 * Delete a project (MANAGER+ role required)
 */
router.delete('/:id', requireProjectRole('MANAGER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const projectId = await resolveProjectId(id);

  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true }
  });

  if (!project) {
    throw createApiError('Project not found', 404);
  }

  await prisma.project.delete({
    where: { id: projectId }
  });

  logger.info(`Project deleted: ${project.name} by ${req.user.email}`);

  res.json({
    message: 'Project deleted successfully',
    projectId: projectId
  });
}));


/**
 * GET /api/projects/:id/activities
 * Get recent activities for a project
 */
router.get('/:id/activities', requireProjectRole('VIEWER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const projectId = await resolveProjectId(id);

  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  // Authorization already handled by middleware
  // For now, return an empty array
  // TODO: Implement activity tracking in the future
  res.json([]);
}));

/**
 * GET /api/projects/:id/panels
 * Get all panels for a project with optional model filtering
 */
router.get('/:id/panels', requireProjectRole('VIEWER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const { modelId } = req.query; // Optional model filter
  const projectId = await resolveProjectId(id);

  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  // Authorization already handled by middleware

  // Build where clause for panel filtering
  const where: any = { projectId };

  // If modelId is provided, filter by specific model
  if (modelId && modelId !== 'all') {
    where.modelId = modelId as string;
  }

  // Get panels with model information
  const panels = await prisma.panel.findMany({
    where,
    select: {
      id: true,
      projectId: true,
      modelId: true,
      elementId: true,
      name: true,
      tag: true,
      objectType: true,
      dimensions: true,
      location: true,
      material: true,
      weight: true,
      area: true,
      productionDate: true,
      shippingDate: true,
      installationDate: true,
      notes: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
      // Include model information for display
      model: {
        select: {
          id: true,
          originalFilename: true,
          category: true,
          displayName: true
        }
      },
      // Include group assignments
      groups: {
        include: {
          group: {
            select: {
              id: true,
              name: true
            }
          }
        }
      },
      // Include status assignments
      statuses: {
        include: {
          status: {
            select: {
              id: true,
              name: true,
              icon: true,
              color: true
            }
          }
        }
      }
    },
    orderBy: [
      { modelId: 'asc' }, // Group by model first
      { name: 'asc' }     // Then by name
    ]
  });

  // Transform panels to include model info and flatten relationships
  const transformedPanels = panels.map(panel => ({
    id: panel.id,
    projectId: panel.projectId,
    modelId: panel.modelId,
    elementId: panel.elementId,
    name: panel.name,
    tag: panel.tag,
    objectType: panel.objectType,
    dimensions: panel.dimensions,
    location: panel.location,
    material: panel.material,
    weight: panel.weight,
    area: panel.area,
    productionDate: panel.productionDate,
    shippingDate: panel.shippingDate,
    installationDate: panel.installationDate,
    notes: panel.notes,
    metadata: panel.metadata,
    createdAt: panel.createdAt,
    updatedAt: panel.updatedAt,
    // Model information
    model: panel.model,
    // Group information (keep full object structure for modal)
    groups: panel.groups,
    // Status information (keep full object structure for modal)
    statuses: panel.statuses,
    status: panel.statuses.length > 0
      ? panel.statuses[0].status.name
      : 'READY_FOR_PRODUCTION',
    // Additional display fields
    storey: panel.location || 'Unknown',
    description: panel.notes || `${panel.objectType || 'Panel'} - ${panel.name}`,
    details: `Material: ${panel.material || 'N/A'}, Location: ${panel.location || 'N/A'}`
  }));

  logger.info(`✅ Fetched ${transformedPanels.length} panels for project ${projectId}${modelId ? ` (model: ${modelId})` : ' (all models)'}`);

  res.json({
    panels: transformedPanels,
    total: transformedPanels.length,
    modelFilter: modelId || 'all'
  });
}));

/**
 * GET /api/projects/:id/bimsf-panels
 * Unique BIMSF_Container panel IDs across Structure + MEP (and other) models.
 * Prefer spatialStructure.bimsfMap; fall back to ModelElement.properties.BIMSF_Container.
 */
router.get('/:id/bimsf-panels', requireProjectRole('VIEWER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const projectId = await resolveProjectId(id);
  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  const models = await prisma.model.findMany({
    where: { projectId, status: 'READY', isActive: true },
    select: {
      id: true,
      category: true,
      displayName: true,
      originalFilename: true,
      spatialStructure: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const normalize = (v: string) => String(v || '').replace(/^\*/, '').trim();
  type Agg = {
    id: string;
    displayName: string;
    count: number;
    byCategory: Record<string, number>;
    modelIds: string[];
  };
  const agg = new Map<string, Agg>();

  const bump = (raw: string, category: string | null, modelId: string) => {
    const display = normalize(raw);
    if (!display) return;
    const key = display.toLowerCase();
    let row = agg.get(key);
    if (!row) {
      row = { id: display, displayName: display, count: 0, byCategory: {}, modelIds: [] };
      agg.set(key, row);
    }
    row.count += 1;
    const cat = category || 'UNCATEGORIZED';
    row.byCategory[cat] = (row.byCategory[cat] || 0) + 1;
    if (!row.modelIds.includes(modelId)) row.modelIds.push(modelId);
  };

  for (const model of models) {
    const spatial = model.spatialStructure as any;
    const bimsfMap = spatial?.bimsfMap;
    let usedMap = false;

    if (bimsfMap?.byPanel && typeof bimsfMap.byPanel === 'object') {
      for (const [panelId, info] of Object.entries(bimsfMap.byPanel as Record<string, any>)) {
        const display = normalize((info as any)?.displayName || panelId);
        if (!display) continue;
        const count = Number((info as any)?.count) || ((info as any)?.elementIds?.length) || 1;
        const key = display.toLowerCase();
        let row = agg.get(key);
        if (!row) {
          row = { id: display, displayName: display, count: 0, byCategory: {}, modelIds: [] };
          agg.set(key, row);
        }
        row.count += count;
        const cat = model.category || 'UNCATEGORIZED';
        row.byCategory[cat] = (row.byCategory[cat] || 0) + count;
        if (!row.modelIds.includes(model.id)) row.modelIds.push(model.id);
        usedMap = true;
      }
    } else if (Array.isArray(bimsfMap?.panels) && bimsfMap.panels.length) {
      for (const p of bimsfMap.panels) {
        const display = normalize(p.displayName || p.id || p.bimsf);
        if (!display) continue;
        const count = Number(p.count) || 1;
        const key = display.toLowerCase();
        let row = agg.get(key);
        if (!row) {
          row = { id: display, displayName: display, count: 0, byCategory: {}, modelIds: [] };
          agg.set(key, row);
        }
        row.count += count;
        const cat = model.category || 'UNCATEGORIZED';
        row.byCategory[cat] = (row.byCategory[cat] || 0) + count;
        if (!row.modelIds.includes(model.id)) row.modelIds.push(model.id);
        usedMap = true;
      }
    } else if (bimsfMap?.byElementId && typeof bimsfMap.byElementId === 'object') {
      for (const raw of Object.values(bimsfMap.byElementId as Record<string, string>)) {
        bump(String(raw), model.category, model.id);
        usedMap = true;
      }
    }

    if (!usedMap) {
      const elements = await prisma.modelElement.findMany({
        where: { modelId: model.id },
        select: { properties: true },
        take: 100000,
      });
      for (const el of elements) {
        const props = (el.properties as Record<string, unknown> | null) || {};
        const bimsf = typeof props.BIMSF_Container === 'string' ? props.BIMSF_Container : null;
        if (bimsf) bump(bimsf, model.category, model.id);
      }
    }
  }

  const panels = [...agg.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));

  res.json({
    success: true,
    projectId,
    panels,
    total: panels.length,
    models: models.map((m) => ({
      id: m.id,
      category: m.category,
      displayName: m.displayName || m.originalFilename,
      hasBimsfMap: !!(m.spatialStructure as any)?.bimsfMap,
    })),
  });
}));

/**
 * GET /api/projects/:id/models-list
 * Get all models for a project (for model selection dropdown)
 */
router.get('/:id/models-list', requireProjectRole('VIEWER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const projectId = await resolveProjectId(id);

  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  // Authorization already handled by middleware
  const project = await prisma.project.findUnique({
    where: {
      id: projectId
    },
    include: {
      modelHistory: {
        where: {
          status: 'READY', // Only include ready models
          isActive: true,  // Only current versions (hide replaced after republish)
        },
        select: {
          id: true,
          originalFilename: true,
          category: true,
          displayName: true,
          isActive: true,
          elementCount: true,
          sizeBytes: true,
          createdAt: true
        },
        orderBy: {
          createdAt: 'desc'
        }
      }
    }
  });

  if (!project) {
    throw createApiError('Project not found', 404);
  }

  // Get panel counts for each model to use as fallback for elementCount
  const panelCounts = await Promise.all(
    project.modelHistory.map(async (model) => {
      const panelCount = await prisma.panel.count({
        where: {
          projectId: projectId,
          modelId: model.id
        }
      });
      return { modelId: model.id, panelCount };
    })
  );

  const panelCountMap = Object.fromEntries(
    panelCounts.map(pc => [pc.modelId, pc.panelCount])
  );

  // Transform models for dropdown display and remove duplicates
  const uniqueModels = new Map();

  project.modelHistory.forEach(model => {
    // Skip if we already have this model (by ID)
    if (uniqueModels.has(model.id)) {
      return;
    }

    // Create a more descriptive name
    const baseName = model.originalFilename.replace(/\.(ifc|frag)$/i, '');
    const panelCount = panelCountMap[model.id] || 0;

    // Improve category detection from filename if category is 'OTHER'
    let finalCategory = model.category;
    if (model.category === 'OTHER' || !model.category) {
      const filename = model.originalFilename.toLowerCase();
      if (filename.includes('struct') || filename.includes('arch')) {
        finalCategory = 'STRUCTURE';
      } else if (filename.includes('mep') || filename.includes('plumb') || filename.includes('hvac')) {
        finalCategory = 'MEP';
      } else if (filename.includes('elect') || filename.includes('power') || filename.includes('light')) {
        finalCategory = 'ELECTRICAL';
      } else {
        finalCategory = 'OTHER';
      }
    }

    const displayName = model.displayName && model.displayName !== 'Other'
      ? model.displayName
      : baseName;

    uniqueModels.set(model.id, {
      id: model.id,
      name: displayName,
      filename: model.originalFilename,
      category: finalCategory,
      isActive: model.isActive,
      elementCount: model.elementCount || panelCount || 0, // Use panel count as fallback
      sizeBytes: Number(model.sizeBytes),
      createdAt: model.createdAt
    });
  });

  const models = Array.from(uniqueModels.values());

  res.json({
    models,
    total: models.length
  });
}));

/**
 * GET /api/projects/:id/publish-revisions
 * Group models into publish revisions (by multiFileJobId / shared publish batch).
 * Latest = ALL currently active models across disciplines (Structure + MEP + Architecture).
 */
router.get('/:id/publish-revisions', requireProjectRole('VIEWER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const projectId = await resolveProjectId(req.params.id);
  if (!projectId) {
    throw createApiError('Invalid project ID', 400);
  }

  const models = await prisma.model.findMany({
    where: { projectId, status: 'READY' },
    select: {
      id: true,
      category: true,
      version: true,
      isActive: true,
      originalFilename: true,
      displayName: true,
      multiFileJobId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  type RevModel = (typeof models)[number];
  const mapModel = (m: RevModel) => ({
    id: m.id,
    category: m.category,
    version: m.version,
    isActive: m.isActive,
    name: m.displayName || m.originalFilename,
    originalFilename: m.originalFilename,
  });

  const activeModels = models.filter((m) => m.isActive);
  const inactiveModels = models.filter((m) => !m.isActive);

  const revisions: Array<{
    id: string;
    createdAt: Date;
    version: number;
    isLatest: boolean;
    label: string;
    categories: string[];
    models: ReturnType<typeof mapModel>[];
  }> = [];

  // One composite "Latest" with every active discipline model
  if (activeModels.length > 0) {
    const createdAt = activeModels.reduce(
      (max, m) => (m.createdAt > max ? m.createdAt : max),
      activeModels[0].createdAt
    );
    const maxVersion = Math.max(...activeModels.map((m) => m.version || 1));
    const categories = [...new Set(activeModels.map((m) => m.category))].sort();
    revisions.push({
      id: 'latest',
      createdAt,
      version: maxVersion,
      isLatest: true,
      label: `Latest · ${categories.join(' + ')}`,
      categories,
      models: activeModels.map(mapModel),
    });
  }

  // Historical batches (inactive models only), by publish job
  const groups = new Map<string, RevModel[]>();
  for (const m of inactiveModels) {
    const key = m.multiFileJobId || `solo_${m.id}`;
    const list = groups.get(key) || [];
    list.push(m);
    groups.set(key, list);
  }

  for (const [id, groupModels] of groups.entries()) {
    const createdAt = groupModels.reduce(
      (max, m) => (m.createdAt > max ? m.createdAt : max),
      groupModels[0].createdAt
    );
    const maxVersion = Math.max(...groupModels.map((m) => m.version || 1));
    const categories = [...new Set(groupModels.map((m) => m.category))].sort();
    revisions.push({
      id,
      createdAt,
      version: maxVersion,
      isLatest: false,
      label: `v${maxVersion} · ${categories.join(' + ')}`,
      categories,
      models: groupModels.map(mapModel),
    });
  }

  revisions.sort((a, b) => {
    if (a.isLatest !== b.isLatest) return a.isLatest ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  res.json({ revisions, total: revisions.length });
}));

function mergeBrowserSnapshots(snapshots: any[]): any | null {
  const valid = snapshots.filter((s) => s && typeof s === 'object');
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  const base = { ...valid[0] };
  const viewByKey = new Map<string, any>();
  const sheetByKey = new Map<string, any>();
  const scheduleByKey = new Map<string, any>();
  const legendByKey = new Map<string, any>();
  const linkByKey = new Map<string, any>();
  const levelByKey = new Map<string, any>();
  const phaseByKey = new Map<string, any>();
  const templateByKey = new Map<string, any>();
  let familiesSummary: Record<string, number> = {};

  const put = (map: Map<string, any>, key: string, item: any) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, item);
  };

  for (const snap of valid) {
    for (const v of snap.views || []) {
      put(
        viewByKey,
        String(v.name || '')
          .trim()
          .toLowerCase() || `id:${v.id}`,
        v
      );
    }
    for (const s of snap.sheets || []) {
      put(
        sheetByKey,
        `${String(s.number || '').trim()}|${String(s.name || '')
          .trim()
          .toLowerCase()}` || `id:${s.id}`,
        s
      );
    }
    for (const s of snap.schedules || []) {
      put(scheduleByKey, String(s.name || '').trim().toLowerCase() || `id:${s.id}`, s);
    }
    for (const l of snap.legends || []) {
      put(legendByKey, String(l.name || '').trim().toLowerCase() || `id:${l.id}`, l);
    }
    for (const l of snap.links || []) {
      put(linkByKey, String(l.name || '').trim().toLowerCase() || `id:${l.id}`, l);
    }
    for (const l of snap.levels || []) {
      put(levelByKey, String(l.name || '').trim().toLowerCase() || `id:${l.id}`, l);
    }
    for (const p of snap.phases || []) {
      put(phaseByKey, String(p.name || '').trim().toLowerCase() || `id:${p.id}`, p);
    }
    for (const t of snap.viewTemplates || []) {
      put(templateByKey, String(t.name || '').trim().toLowerCase() || `id:${t.id}`, t);
    }
    if (snap.familiesSummary && typeof snap.familiesSummary === 'object') {
      for (const [k, v] of Object.entries(snap.familiesSummary)) {
        familiesSummary[k] = (familiesSummary[k] || 0) + (Number(v) || 0);
      }
    }
    if (snap.projectInfo && !base.projectInfo) {
      base.projectInfo = snap.projectInfo;
    }
  }

  return {
    ...base,
    schemaVersion: base.schemaVersion || 1,
    views: Array.from(viewByKey.values()),
    sheets: Array.from(sheetByKey.values()),
    schedules: Array.from(scheduleByKey.values()),
    legends: Array.from(legendByKey.values()),
    links: Array.from(linkByKey.values()),
    levels: Array.from(levelByKey.values()).sort(
      (a, b) => (Number(a.elevation) || 0) - (Number(b.elevation) || 0)
    ),
    phases: Array.from(phaseByKey.values()),
    viewTemplates: Array.from(templateByKey.values()),
    familiesSummary,
  };
}

/**
 * GET /api/projects/:id/browser?revisionId=
 * Revit Project Browser snapshot + drawing list for a publish revision.
 * revisionId=latest (default): merge browser/drawings from ALL active discipline publishes.
 */
router.get('/:id/browser', requireProjectRole('VIEWER'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) throw createApiError('User not authenticated', 401);

  const projectId = await resolveProjectId(req.params.id);
  if (!projectId) throw createApiError('Invalid project ID', 400);

  let publishJobId = typeof req.query.revisionId === 'string' ? req.query.revisionId : undefined;
  const wantLatest = !publishJobId || publishJobId === 'latest';

  if (wantLatest) {
    const activeModels = await prisma.model.findMany({
      where: { projectId, isActive: true, multiFileJobId: { not: null } },
      select: { multiFileJobId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const jobIds = [
      ...new Set(
        activeModels
          .map((m) => m.multiFileJobId)
          .filter((id): id is string => !!id)
      ),
    ];

    if (jobIds.length === 0) {
      const latest = await prisma.projectBrowserRevision.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: { publishJobId: true },
      });
      if (latest) jobIds.push(latest.publishJobId);
    }

    if (jobIds.length === 0) {
      return res.json({
        revisionId: null,
        snapshot: null,
        drawings: [],
        message: 'No Project Browser data published yet',
      });
    }

    const browserRevs = await prisma.projectBrowserRevision.findMany({
      where: { projectId, publishJobId: { in: jobIds } },
      orderBy: { createdAt: 'desc' },
    });

    const drawings = await prisma.projectDrawing.findMany({
      where: { projectId, publishJobId: { in: jobIds } },
      orderBy: [{ createdAt: 'desc' }, { kind: 'asc' }, { name: 'asc' }],
    });

    // Prefer newest drawing when same stableKey appears in multiple discipline publishes
    const drawingByKey = new Map<string, (typeof drawings)[number]>();
    for (const d of drawings) {
      if (!drawingByKey.has(d.stableKey)) drawingByKey.set(d.stableKey, d);
    }

    const snapshot = mergeBrowserSnapshots(browserRevs.map((r) => r.snapshot));

    return res.json({
      revisionId: 'latest',
      snapshot,
      mergedFrom: jobIds,
      drawings: Array.from(drawingByKey.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({
          id: d.id,
          stableKey: d.stableKey,
          kind: d.kind,
          name: d.name,
          sheetNumber: d.sheetNumber,
          viewType: d.viewType,
          revitElementId: d.revitElementId,
          hasDxf: !!d.dxfStorageKey,
          hasDwg: !!d.dwgStorageKey,
          sizeBytes: Number(d.sizeBytes),
        })),
    });
  }

  const browserRev = await prisma.projectBrowserRevision.findUnique({
    where: { publishJobId },
  });

  const drawings = await prisma.projectDrawing.findMany({
    where: { projectId, publishJobId },
    orderBy: [{ kind: 'asc' }, { sheetNumber: 'asc' }, { name: 'asc' }],
  });

  res.json({
    revisionId: publishJobId,
    snapshot: browserRev?.snapshot ?? null,
    drawings: drawings.map((d) => ({
      id: d.id,
      stableKey: d.stableKey,
      kind: d.kind,
      name: d.name,
      sheetNumber: d.sheetNumber,
      viewType: d.viewType,
      revitElementId: d.revitElementId,
      hasDxf: !!d.dxfStorageKey,
      hasDwg: !!d.dwgStorageKey,
      sizeBytes: Number(d.sizeBytes),
    })),
  });
}));

/**
 * GET /api/projects/:id/drawings/:drawingId/download-url?format=dxf|dwg
 */
router.get(
  '/:id/drawings/:drawingId/download-url',
  requireProjectRole('VIEWER'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('User not authenticated', 401);

    const projectId = await resolveProjectId(req.params.id);
    if (!projectId) throw createApiError('Invalid project ID', 400);

    const format = String(req.query.format || 'dxf').toLowerCase();
    if (format !== 'dxf' && format !== 'dwg') {
      throw createApiError('format must be dxf or dwg', 400);
    }

    const drawing = await prisma.projectDrawing.findFirst({
      where: { id: req.params.drawingId, projectId },
    });
    if (!drawing) throw createApiError('Drawing not found', 404);

    const key = format === 'dwg' ? drawing.dwgStorageKey : drawing.dxfStorageKey;
    if (!key) throw createApiError(`${format.toUpperCase()} not available for this drawing`, 404);

    const url = await storageService.getDownloadUrl(key, 3600);
    res.json({
      url,
      format,
      fileName: `${drawing.stableKey}.${format}`,
      drawingId: drawing.id,
      name: drawing.name,
    });
  })
);

/**
 * GET /api/projects/:id/drawings/:drawingId/file?format=dxf|dwg
 * Same-origin stream (avoids MinIO CORS issues in the CAD viewer).
 */
router.get(
  '/:id/drawings/:drawingId/file',
  requireProjectRole('VIEWER'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('User not authenticated', 401);

    const projectId = await resolveProjectId(req.params.id);
    if (!projectId) throw createApiError('Invalid project ID', 400);

    const format = String(req.query.format || 'dxf').toLowerCase();
    if (format !== 'dxf' && format !== 'dwg') {
      throw createApiError('format must be dxf or dwg', 400);
    }

    const drawing = await prisma.projectDrawing.findFirst({
      where: { id: req.params.drawingId, projectId },
    });
    if (!drawing) throw createApiError('Drawing not found', 404);

    const key = format === 'dwg' ? drawing.dwgStorageKey : drawing.dxfStorageKey;
    if (!key) throw createApiError(`${format.toUpperCase()} not available for this drawing`, 404);

    const buffer = await storageService.downloadFile(key);
    const fileName = `${drawing.stableKey}.${format}`;
    res.setHeader(
      'Content-Type',
      format === 'dxf' ? 'application/dxf' : 'application/acad'
    );
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  })
);

export default router;
