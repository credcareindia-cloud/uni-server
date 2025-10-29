import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { fragProcessor } from '../services/fragProcessor.js';

const router = Router();

// Validation schema for project creation with model
const createProjectWithModelSchema = z.object({
  projectName: z.string().min(1).max(255),
  projectDescription: z.string().max(1000).optional(),
  projectStatus: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional().default('ACTIVE'),
});

/**
 * POST /api/create-project-with-model
 * Upload a FRAG model and create a project automatically when processing succeeds
 * This implements the model-first project creation workflow
 */
router.post('/create-project-with-model', asyncHandler(async (req: any, res: Response) => {
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

  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  // Check for uploaded file using express-fileupload
  if (!req.files || !req.files.fragFile) {
    throw createApiError('No FRAG file provided', 400);
  }

  const fragFile = Array.isArray(req.files.fragFile) ? req.files.fragFile[0] : req.files.fragFile;
  
  // Debug: Check file data before processing
  logger.info(`🔍 File received - Name: ${fragFile.name}, Size: ${fragFile.size}, Data length: ${fragFile.data ? fragFile.data.length : 'undefined'}`);
  
  // Validate file type
  if (!fragFile.name.toLowerCase().endsWith('.frag')) {
    throw createApiError('Only .frag files are allowed', 400);
  }

  // Validate project data
  const projectData = createProjectWithModelSchema.parse(req.body);

  try {
    // Start a transaction to ensure data consistency
    const result = await prisma.$transaction(async (tx) => {
      // Create the project first
      const project = await tx.project.create({
        data: {
          name: projectData.projectName,
          description: projectData.projectDescription || `Project created from ${fragFile.name}`,
          status: projectData.projectStatus,
          metadata: {
            createdFromModel: true,
            originalFilename: fragFile.name,
            modelFirst: true
          },
          createdBy: req.user.id
        }
      });

      // Upload file to storage
      const fileKey = `models/${project.id}/${Date.now()}-${fragFile.name}`;
      logger.info(`🔍 Before storage upload - Data length: ${fragFile.data ? fragFile.data.length : 'undefined'}`);
      await storageService.uploadFile(fileKey, fragFile.data, fragFile.mimetype);
      logger.info(`🔍 After storage upload - Data length: ${fragFile.data ? fragFile.data.length : 'undefined'}`);

      // Create the model record
      const model = await tx.model.create({
        data: {
          projectId: project.id,
          type: 'FRAG',
          originalFilename: fragFile.name,
          storageKey: fileKey,
          sizeBytes: BigInt(fragFile.size),
          status: 'READY', // FRAG files are instantly ready
          processingProgress: 100,
          version: 1,
          isActive: true
        }
      });

      // Update project to set current model
      const updatedProject = await tx.project.update({
        where: { id: project.id },
        data: {
          currentModelId: model.id
        }
      });

      return { project: updatedProject, model };
    });

    logger.info(`Project and model created: ${result.project.name} with model ${result.model.id}`);

    // Process the FRAG file synchronously and wait for completion
    logger.info(`🔄 Starting synchronous FRAG processing for model ${result.model.id}`);
    const metadata = await fragProcessor.processFragFile(result.model.id, fragFile.data);
    logger.info(`✅ FRAG processing completed successfully for model ${result.model.id}`);

    // Return response with complete metadata
    res.status(201).json({
      success: true,
      project: {
        id: result.project.id,
        name: result.project.name,
        description: result.project.description,
        status: result.project.status.toLowerCase().replace('_', '-'),
        createdAt: result.project.createdAt,
        updatedAt: result.project.updatedAt
      },
      model: {
        id: result.model.id,
        originalFilename: result.model.originalFilename,
        status: 'ready',
        sizeBytes: Number(result.model.sizeBytes)
      },
      metadata: {
        totalElements: metadata.totalElements,
        panelsCount: metadata.panels.length,
        groupsCount: metadata.groups.length,
        spatialStructure: metadata.spatialStructure,
        statistics: metadata.statistics
      },
      message: 'Project created and model processed successfully.'
    });

  } catch (error) {
    logger.error('Error creating project with model:', error);
    throw createApiError('Failed to create project with model', 500);
  }
}));

export { router as modelFirstProjectRouter };
