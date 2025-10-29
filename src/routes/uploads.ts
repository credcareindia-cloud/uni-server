import { Router, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';
import { fragProcessor } from '../services/fragProcessor.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
// Removed IFC job queue import - FRAG files don't need processing!

const router = Router();

// Validation schemas
const initiateUploadSchema = z.object({
  projectId: z.string().transform(val => parseInt(val)).refine(val => !isNaN(val), 'Project ID must be a valid number'),
  filename: z.string().min(1, 'Filename is required'),
  fileSize: z.number().min(1, 'File size must be greater than 0'),
  contentType: z.string().min(1, 'Content type is required'),
});

// Removed IFC upload completion schema - FRAG files don't need processing!

/**
 * POST /api/uploads/initiate
 * Initiate file upload - creates model record and returns signed upload URL
 * TODO: Re-enable authentication after testing
 */
router.post('/initiate', asyncHandler(async (req: any, res: Response) => {
  // Temporary: Use demo user for testing without auth
  const demoUser = await prisma.user.findUnique({
    where: { email: 'demo@uniqube.com' }
  });
  req.user = demoUser || { id: 'demo-user-id', email: 'demo@uniqube.com' };
  
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { projectId, filename, fileSize, contentType } = initiateUploadSchema.parse(req.body);

  // Verify project exists and user owns it
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      createdBy: req.user.id
    }
  });

  if (!project) {
    throw createApiError('Project not found', 404);
  }

  // Validate file type
  const allowedTypes = ['model/ifc', 'application/octet-stream', 'application/x-step'];
  const allowedExtensions = ['.ifc', '.frag'];
  const fileExtension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  
  if (!allowedExtensions.includes(fileExtension)) {
    throw createApiError('Invalid file type. Only IFC and FRAG files are allowed.', 400);
  }

  // Check file size limit (5GB)
  const maxFileSize = parseInt(process.env.MAX_FILE_SIZE || '5368709120'); // 5GB
  if (fileSize > maxFileSize) {
    throw createApiError(`File too large. Maximum size is ${Math.round(maxFileSize / 1024 / 1024 / 1024)}GB`, 400);
  }

  // Only FRAG files supported now
  if (fileExtension !== '.frag') {
    throw createApiError('Only FRAG files are supported', 400);
  }

  // Generate unique model ID and storage key
  const modelId = uuidv4();
  const storageKey = storageService.generateStorageKey(projectId.toString(), modelId, filename);

  // Create model record
  const model = await prisma.model.create({
    data: {
      id: modelId,
      projectId,
      originalFilename: filename,
      storageKey,
      type: 'FRAG',
      sizeBytes: BigInt(fileSize),
      status: 'UPLOADED',
      processingProgress: 0
    }
  });

  // Generate pre-signed upload URL
  const uploadUrl = await storageService.getUploadUrl(storageKey, contentType, 3600); // 1 hour expiry

  logger.info(`Upload initiated: ${filename} (${fileSize} bytes) for project ${projectId} by ${req.user.email}`);

  res.json({
    message: 'Upload initiated successfully',
    modelId: model.id,
    uploadUrl,
    storageKey,
    expiresIn: 3600
  });
}));

/**
 * POST /api/uploads/multipart/initiate
 * Initiate multipart upload for very large files
 */
router.post('/multipart/initiate', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { projectId, filename, fileSize, contentType } = initiateUploadSchema.parse(req.body);

  // Verify project exists and user owns it
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      createdBy: req.user.id
    }
  });

  if (!project) {
    throw createApiError('Project not found', 404);
  }

  // Validate file type and size (only FRAG supported)
  const fileExtension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  
  if (fileExtension !== '.frag') {
    throw createApiError('Only FRAG files are supported', 400);
  }

  const maxFileSize = parseInt(process.env.MAX_FILE_SIZE || '5368709120');
  if (fileSize > maxFileSize) {
    throw createApiError(`File too large. Maximum size is ${Math.round(maxFileSize / 1024 / 1024 / 1024)}GB`, 400);
  }

  const modelId = uuidv4();
  const storageKey = storageService.generateStorageKey(projectId.toString(), modelId, filename);

  // Create model record
  const model = await prisma.model.create({
    data: {
      id: modelId,
      projectId,
      originalFilename: filename,
      storageKey,
      type: 'FRAG',
      sizeBytes: BigInt(fileSize),
      status: 'UPLOADED',
      processingProgress: 0
    }
  });

  // For now, return regular upload URL (multipart upload can be implemented later)
  const uploadUrl = await storageService.getUploadUrl(storageKey, contentType, 7200); // 2 hours for large files

  logger.info(`Multipart upload initiated: ${filename} (${fileSize} bytes) for project ${projectId} by ${req.user.email}`);

  res.json({
    message: 'Multipart upload initiated successfully',
    modelId: model.id,
    uploadUrl,
    storageKey,
    expiresIn: 7200,
    chunkSize: 100 * 1024 * 1024 // 100MB chunks recommended
  });
}));

/**
 * GET /api/uploads/status/:modelId
 * Get upload/processing status
 */
router.get('/status/:modelId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { modelId } = req.params;

  const model = await prisma.model.findFirst({
    where: {
      id: modelId || '',
      project: {
        createdBy: req.user.id
      }
    },
    select: {
      id: true,
      originalFilename: true,
      status: true,
      processingProgress: true,
      errorMessage: true,
      elementCount: true,
      createdAt: true,
      updatedAt: true
    }
  });

  if (!model) {
    throw createApiError('Model not found', 404);
  }

  const status = {
    modelId: model.id,
    filename: model.originalFilename,
    status: model.status.toLowerCase(),
    progress: model.processingProgress || 0,
    elementsProcessed: model.elementCount || 0,
    totalElements: model.elementCount,
    errorMessage: model.errorMessage,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt
  };

  res.json({ status });
}));

/**
 * POST /api/uploads/frag
 * Direct FRAG file upload for projects
 */
router.post('/frag', asyncHandler(async (req: any, res: Response) => {
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

  // Get project ID from query parameters (sent by frontend)
  const projectIdStr = req.body.projectId || req.query.projectId;
  const projectId = projectIdStr ? parseInt(projectIdStr, 10) : null;
  
  console.log('FRAG Upload Request:', {
    body: req.body,
    query: req.query,
    projectId,
    files: req.files,
    headers: req.headers['content-type']
  });
  
  if (!projectId || isNaN(projectId)) {
    throw createApiError('Valid Project ID is required', 400);
  }

  // Verify project exists and user owns it
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      createdBy: req.user.id
    }
  });

  if (!project) {
    throw createApiError('Project not found or access denied', 404);
  }

  // ENFORCE ONE MODEL PER PROJECT RULE
  // Check if project already has a model
  const existingModel = await prisma.model.findFirst({
    where: {
      projectId: projectId
    }
  });

  if (existingModel) {
    throw createApiError('Project already has a model. Each project can only have one model. Use model replacement feature instead.', 400);
  }

  // Check if file was uploaded
  if (!req.files || !req.files.file) {
    throw createApiError('No file uploaded', 400);
  }

  const file = Array.isArray(req.files.file) ? req.files.file[0] : req.files.file;
  
  // Validate file type
  if (!file.name.toLowerCase().endsWith('.frag')) {
    throw createApiError('Invalid file type. Only FRAG files are allowed.', 400);
  }

  try {
    // Generate unique model ID and storage key
    const modelId = uuidv4();
    const storageKey = storageService.generateStorageKey(projectId.toString(), modelId, file.name);

    logger.info(`Creating model record in database for: ${file.name}`);

    // Create model record in database first
    const model = await prisma.model.create({
      data: {
        id: modelId,
        projectId: projectId,
        originalFilename: file.name,
        storageKey,
        type: 'FRAG',
        sizeBytes: BigInt(file.size),
        status: 'PROCESSING', // Start as processing
        processingProgress: 0,
        elementCount: null
      }
    });

    logger.info(`Model record created successfully: ${model.id}`);

    // Process FRAG file BEFORE uploading to preserve buffer
    logger.info(`Starting FRAG metadata processing for: ${file.name}`);
    
    try {
      // Read file from temp path since useTempFiles is enabled
      const fs = await import('fs/promises');
      const fileBuffer = await fs.readFile(file.tempFilePath);
      logger.info(`Processing FRAG file with buffer size: ${fileBuffer.length} bytes`);
      
      await fragProcessor.processFragFile(model.id, fileBuffer);
      logger.info(`FRAG metadata processing completed for: ${file.name}`);
      
      // Upload file to storage after successful processing
      logger.info(`Uploading FRAG file to storage: ${storageKey}`);
      await storageService.uploadFile(storageKey, fileBuffer, file.mimetype || 'application/octet-stream');
      logger.info(`File uploaded successfully: ${storageKey}`);
      
    } catch (processingError) {
      logger.error(`FRAG processing failed for ${model.id}:`, processingError);
      // Update model status to failed
      await prisma.model.update({
        where: { id: model.id },
        data: {
          status: 'FAILED',
          errorMessage: processingError instanceof Error ? processingError.message : 'Processing failed'
        }
      });
    }

    // Get updated model status
    const updatedModel = await prisma.model.findUnique({
      where: { id: model.id },
      select: {
        id: true,
        originalFilename: true,
        sizeBytes: true,
        status: true,
        type: true,
        processingProgress: true,
        elementCount: true
      }
    });

    res.json({
      success: true,
      message: 'FRAG file uploaded and processed successfully',
      model: {
        id: updatedModel?.id || model.id,
        filename: updatedModel?.originalFilename || model.originalFilename,
        size: Number(updatedModel?.sizeBytes || model.sizeBytes),
        status: updatedModel?.status || model.status,
        type: updatedModel?.type || model.type,
        progress: updatedModel?.processingProgress || 0,
        elementCount: updatedModel?.elementCount
      },
      projectId
    });
  } catch (error) {
    logger.error('Error uploading FRAG file:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error details:', {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      projectId,
      fileName: file.name,
      fileSize: file.size
    });
    throw createApiError(`Failed to upload FRAG file: ${errorMessage}`, 500);
  }
}));

export { router as uploadRoutes };
