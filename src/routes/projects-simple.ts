import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireProjectRole } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

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
          status: 'READY' // Only include ready models
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

export default router;
