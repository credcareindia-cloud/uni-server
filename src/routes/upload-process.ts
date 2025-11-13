import { Router, Response } from 'express';
import type { UploadedFile } from 'express-fileupload';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { enqueueIfcConversion } from '../queue/index.js';
import { shouldRejectLargeFile, logSystemResources } from '../utils/systemMonitor.js';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Validation schema for project creation with model
const uploadProcessSchema = z.object({
  projectName: z.string().min(1).max(255),
  projectDescription: z.string().max(1000).optional(),
  projectStatus: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional().default('ACTIVE'),
});

// In-memory processing status store (in production, use Redis)
const processingJobs = new Map<string, {
  id: string;
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  projectData?: any;
  error?: string;
  createdAt: Date;
}>();

/**
 * POST /api/upload-and-process
 * Upload file and start processing - project created only AFTER successful processing
 */
router.post('/upload-and-process', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  // Check for uploaded file using express-fileupload
  const files = req.files as { [fieldname: string]: UploadedFile | UploadedFile[] } | UploadedFile[] | undefined;
  const hasFrag = !!(files && (Array.isArray(files) ? false : (files as any).fragFile));
  if (!files || !hasFrag) {
    throw createApiError('No model file provided', 400);
  }

  const fileField = (files as any).fragFile as UploadedFile | UploadedFile[];
  const uploadedFile: UploadedFile = Array.isArray(fileField) ? fileField[0] : fileField;
  
  // Handle both temp files and in-memory files
  let tempFilePath = uploadedFile.tempFilePath as string | undefined;
  if (!tempFilePath) {
    const fs = await import('fs');
    const path = await import('path');
    const tmpDir = process.env.FILE_UPLOAD_TMP_DIR || '/tmp';
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    tempFilePath = path.join(tmpDir, `upload_${unique}_${uploadedFile.name}`);
    await fs.promises.writeFile(tempFilePath, uploadedFile.data);
  }
  
  // Validate file type (IFC or FRAG)
  const fileName = uploadedFile.name.toLowerCase();
  const isIfc = fileName.endsWith('.ifc');
  const isFrag = fileName.endsWith('.frag');
  
  if (!isIfc && !isFrag) {
    throw createApiError('Only .ifc or .frag files are allowed', 400);
  }

  // Add file size limits
  const fileSizeMB = uploadedFile.size / (1024 * 1024);
  const isProduction = process.env.NODE_ENV === 'production';
  
  const MAX_FILE_SIZE_MB = isProduction ? 5120 : 1024; // 5GB in production, 1GB in dev
  const WARN_FILE_SIZE_MB = isProduction ? 2048 : 500;  // 2GB warning in production, 500MB in dev

  if (fileSizeMB > MAX_FILE_SIZE_MB) {
    throw createApiError(`File too large: ${fileSizeMB.toFixed(1)}MB. Maximum allowed: ${MAX_FILE_SIZE_MB}MB`, 413);
  }

  if (fileSizeMB > WARN_FILE_SIZE_MB) {
    logger.warn(`⚠️ Large file upload: ${fileSizeMB.toFixed(1)}MB - may cause high memory usage`);
  }

  // Check system resources before processing large files
  if (fileSizeMB > 100) {
    logSystemResources('Pre-upload system status');
    const resourceCheck = shouldRejectLargeFile(fileSizeMB);
    if (resourceCheck.reject) {
      throw createApiError(resourceCheck.reason!, 503);
    }
  }

  logger.info(`📁 File type: ${isIfc ? 'IFC' : 'FRAG'}, Size: ${fileSizeMB.toFixed(1)}MB`);

  // Validate project data
  const projectData = uploadProcessSchema.parse(req.body);

  try {
    // Generate unique processing ID
    const processingId = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    
    // Store processing job status
    processingJobs.set(processingId, {
      id: processingId,
      status: 'uploading',
      progress: 10,
      message: 'File uploaded successfully. Starting processing...',
      createdAt: new Date()
    });

    // Prepare target filename for FRAG (for IFC we convert to .frag)
    const finalFragName = isIfc
      ? uploadedFile.name.replace(/\.ifc$/i, '.frag')
      : uploadedFile.name;

    // Start background processing - NO PROJECT CREATED YET
    enqueueIfcConversion({
      processingId, // Pass processing ID to worker
      tempFilePath: tempFilePath!,
      originalFilename: uploadedFile.name,
      finalFragName,
      uploadedByUserId: req.user.id,
      projectData: {
        name: projectData.projectName,
        description: projectData.projectDescription || `Project created from ${uploadedFile.name}`,
        status: projectData.projectStatus,
      }
    });

    // Update status to processing
    processingJobs.set(processingId, {
      id: processingId,
      status: 'processing',
      progress: 20,
      message: isIfc ? 'Converting IFC to FRAG format...' : 'Processing FRAG file...',
      createdAt: new Date()
    });

    logger.info(`🚀 Processing started for ${uploadedFile.name} with ID: ${processingId}`);

    // Return processing ID - NO PROJECT DATA YET
    res.status(202).json({
      success: true,
      processingId,
      message: 'File uploaded successfully. Processing started.',
      status: 'processing',
      progress: 20
    });

    // IMPORTANT: Do not cleanup temp file here; the worker will delete it after processing

  } catch (error) {
    // Attempt to cleanup temp file on error
    if (tempFilePath) {
      try {
        const fs = await import('fs');
        await fs.promises.unlink(tempFilePath);
        logger.info(`🗑️ Cleaned up temp file after error: ${tempFilePath}`);
      } catch (cleanupError) {
        logger.warn(`⚠️ Failed to cleanup temp file: ${cleanupError}`);
      }
    }
    
    logger.error('Error starting file processing:', error);
    throw createApiError('Failed to start file processing', 500);
  }
}));

/**
 * GET /api/processing-status/:id
 * Get processing status by ID
 */
router.get('/processing-status/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { id } = req.params;
  const job = processingJobs.get(id);

  if (!job) {
    throw createApiError('Processing job not found', 404);
  }

  // Clean up completed jobs older than 1 hour
  if (job.status === 'completed' || job.status === 'failed') {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (job.createdAt < oneHourAgo) {
      processingJobs.delete(id);
      throw createApiError('Processing job expired', 404);
    }
  }

  res.json({
    success: true,
    ...job
  });
}));

/**
 * Function called by worker to update processing status
 */
export function updateProcessingStatus(
  processingId: string, 
  status: 'processing' | 'completed' | 'failed',
  progress: number,
  message: string,
  projectData?: any,
  error?: string
) {
  const job = processingJobs.get(processingId);
  if (job) {
    processingJobs.set(processingId, {
      ...job,
      status,
      progress,
      message,
      projectData,
      error
    });
    logger.info(`📊 Processing ${processingId}: ${status} (${progress}%) - ${message}`);
  }
}

/**
 * Function called by worker to mark processing as completed with project data
 */
export function completeProcessing(processingId: string, projectData: any) {
  updateProcessingStatus(
    processingId,
    'completed',
    100,
    'Project created successfully!',
    projectData
  );
}

/**
 * Function called by worker to mark processing as failed
 */
export function failProcessing(processingId: string, error: string) {
  updateProcessingStatus(
    processingId,
    'failed',
    0,
    'Processing failed',
    undefined,
    error
  );
}

export { router as uploadProcessRouter };
