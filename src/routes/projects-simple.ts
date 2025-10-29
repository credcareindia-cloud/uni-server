import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const router = Router();

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
  limit: z.string().transform(val => Math.min(parseInt(val) || 10, 100)).optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
  search: z.string().optional(),
});

/**
 * GET /api/projects
 * Get all projects for the authenticated user
 */
router.get('/', asyncHandler(async (req: any, res: Response) => {
  // Temporary: Use demo user for testing without auth
  let demoUser = await prisma.user.findUnique({
    where: { email: 'demo@uniqube.com' }
  });
  
  // Create demo user if it doesn't exist
  if (!demoUser) {
    demoUser = await prisma.user.create({
      data: {
        email: 'demo@uniqube.com',
        name: 'Demo User',
        passwordHash: 'demo-hash',
        role: 'USER'
      }
    });
  }
  
  req.user = demoUser;

  const { page = 1, limit = 10, status, search } = querySchema.parse(req.query);
  const skip = (page - 1) * limit;

  // Build where clause
  const where: any = {
    createdBy: req.user.id
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
        }
      }
    }),
    prisma.project.count({ where })
  ]);

  // Transform response
  const transformedProjects = projects.map(project => ({
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status.toLowerCase().replace('_', '-'),
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
    }
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
 * Get a specific project by ID
 */
router.get('/:id', asyncHandler(async (req: any, res: Response) => {
  // Temporary: Use demo user for testing without auth
  let demoUser = await prisma.user.findUnique({
    where: { email: 'demo@uniqube.com' }
  });
  
  if (!demoUser) {
    demoUser = await prisma.user.create({
      data: {
        email: 'demo@uniqube.com',
        name: 'Demo User',
        passwordHash: 'demo-hash',
        role: 'USER'
      }
    });
  }
  
  req.user = demoUser;

  const { id } = req.params;
  const projectId = parseInt(id);

  if (isNaN(projectId)) {
    throw createApiError('Invalid project ID', 400);
  }

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      createdBy: req.user.id
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
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status.toLowerCase().replace('_', '-'),
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
 * Update a project
 */
router.put('/:id', asyncHandler(async (req: any, res: Response) => {
  // Temporary: Use demo user for testing without auth
  let demoUser = await prisma.user.findUnique({
    where: { email: 'demo@uniqube.com' }
  });
  
  if (!demoUser) {
    demoUser = await prisma.user.create({
      data: {
        email: 'demo@uniqube.com',
        name: 'Demo User',
        passwordHash: 'demo-hash',
        role: 'USER'
      }
    });
  }
  
  req.user = demoUser;

  const { id } = req.params;
  const projectId = parseInt(id);
  const updateData = updateProjectSchema.parse(req.body);

  if (isNaN(projectId)) {
    throw createApiError('Invalid project ID', 400);
  }

  // Check if project exists and user owns it
  const existingProject = await prisma.project.findFirst({
    where: {
      id: projectId,
      createdBy: req.user.id
    }
  });

  if (!existingProject) {
    throw createApiError('Project not found', 404);
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
    name: project.name,
    description: project.description,
    status: project.status.toLowerCase().replace('_', '-'),
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

export default router;
