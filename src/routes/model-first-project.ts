import { Router, Response } from 'express';
import type { UploadedFile } from 'express-fileupload';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { authenticateToken, AuthenticatedRequest, requireAdmin } from '../middleware/auth.js';
import { enqueueIfcConversion } from '../queue/index.js';
import { shouldRejectLargeFile, logSystemResources } from '../utils/systemMonitor.js';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Validation schema for project creation with model
const createProjectWithModelSchema = z.object({
  projectName: z.string().min(1).max(255),
  projectDescription: z.string().max(1000).optional(),
  projectStatus: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional().default('ACTIVE'),
});

/**
 * POST /api/create-project-with-model
 * Upload an IFC or FRAG model and create a project automatically
 * - IFC files: Converts to FRAG format and extracts metadata during conversion
 * - FRAG files: Processes directly and extracts metadata
 * This implements the model-first project creation workflow
 */
router.post('/create-project-with-model', requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
  // IMPORTANT: For background processing, we keep temp file for the worker to read.
  // If the file arrived in-memory, write it to a temp file ourselves.
  let tempFilePath = uploadedFile.tempFilePath as string | undefined;
  if (!tempFilePath) {
    const fs = await import('fs');
    const path = await import('path');
    const tmpDir = process.env.FILE_UPLOAD_TMP_DIR || '/tmp';
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    tempFilePath = path.join(tmpDir, `upload_${unique}_${uploadedFile.name}`);
    await fs.promises.writeFile(tempFilePath, uploadedFile.data);
  }
  
  // Debug: Check file data before processing
  logger.info(`🔍 File received - Name: ${uploadedFile.name}, Size: ${uploadedFile.size}, Using temp file: ${!!tempFilePath}`);
  if (tempFilePath) {
    logger.info(`📂 Temp file path: ${tempFilePath}`);
  }
  
  // Validate file type (IFC or FRAG)
  const fileName = uploadedFile.name.toLowerCase();
  const isIfc = fileName.endsWith('.ifc');
  const isFrag = fileName.endsWith('.frag');
  
  if (!isIfc && !isFrag) {
    throw createApiError('Only .ifc or .frag files are allowed', 400);
  }

  // Add file size limits - different for production vs development
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
  if (fileSizeMB > 100) { // Check for files > 100MB
    logSystemResources('Pre-upload system status');
    const resourceCheck = shouldRejectLargeFile(fileSizeMB);
    if (resourceCheck.reject) {
      throw createApiError(resourceCheck.reason!, 503);
    }
  }

  logger.info(`📁 File type: ${isIfc ? 'IFC' : 'FRAG'}, Size: ${fileSizeMB.toFixed(1)}MB`);

  // Validate project data
  const projectData = createProjectWithModelSchema.parse(req.body);

  try {
    // Prepare target filename for FRAG (for IFC we convert to .frag)
    const finalFragName = isIfc
      ? uploadedFile.name.replace(/\.ifc$/i, '.frag')
      : uploadedFile.name;

    // Start a transaction to ensure data consistency
    const result = await prisma.$transaction(async (tx) => {
      // Create the project first
      const project = await tx.project.create({
        data: {
          name: projectData.projectName,
          description: projectData.projectDescription || `Project created from ${uploadedFile.name}`,
          status: projectData.projectStatus,
          organizationId: req.user.organizationId,
          metadata: {
            createdFromModel: true,
            originalFilename: uploadedFile.name,
            convertedFromIfc: isIfc,
            modelFirst: true
          },
          createdBy: req.user.id
        }
      });

      // Precompute storage key for the FRAG that will exist after background processing
      const fileKey = storageService.generateStorageKey(String(project.id), 'TEMP_MODEL_ID', finalFragName);

      // Create the model record
      const model = await tx.model.create({
        data: {
          projectId: project.id,
          type: 'FRAG',
          originalFilename: finalFragName,
          storageKey: fileKey,
          sizeBytes: BigInt(0),
          status: 'PROCESSING',
          processingProgress: 1,
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

      // Now that we have the model ID, update the storage key to embed it
      const finalKey = storageService.generateStorageKey(String(project.id), model.id, finalFragName);
      await tx.model.update({ where: { id: model.id }, data: { storageKey: finalKey } });

      // Create owner membership for the creator (admin requester)
      await tx.projectMember.create({
        data: {
          projectId: project.id,
          userId: req.user!.id,
          role: 'OWNER'
        }
      });

      return { project: updatedProject, model: { ...model, storageKey: finalKey } };
    });

    logger.info(`Project and model created: ${result.project.name} with model ${result.model.id}`);

    // Enqueue background processing job. Worker will:
    // - If IFC: convert to FRAG, upload to storageKey, extract metadata, create panels
    // - If FRAG: upload to storageKey
    enqueueIfcConversion({
      modelId: result.model.id,
      projectId: result.project.id,
      tempFilePath: tempFilePath!,
      originalFilename: uploadedFile.name,
      uploadedByUserId: req.user.id,
    });

    // Return response with complete metadata
    res.status(201).json({
      success: true,
      project: {
        id: String(result.project.id),
        name: result.project.name,
        description: result.project.description,
        status: result.project.status.toLowerCase().replace('_', '-'),
        createdAt: result.project.createdAt,
        updatedAt: result.project.updatedAt,
        // Add stats that frontend expects
        stats: {
          totalModels: 1,
          totalGroups: 0,
          totalPanels: 0
        },
        // Add fields that frontend might expect
        panelsCount: 0,
        groupsCount: 0,
        modelsCount: 1,
        currentModel: {
          id: result.model.id,
          originalFilename: result.model.originalFilename,
          status: 'processing',
          sizeBytes: Number(result.model.sizeBytes)
        }
      },
      model: {
        id: result.model.id,
        originalFilename: result.model.originalFilename,
        status: 'processing',
        sizeBytes: Number(result.model.sizeBytes),
        processingProgress: 1
      },
      message: 'Project created. Model is processing in the background.'
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
    
    logger.error('Error creating project with model:', error);
    throw createApiError('Failed to create project with model', 500);
  }
}));

export { router as modelFirstProjectRouter };
