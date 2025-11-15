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

// Validation schema for multi-file project creation
const multiFileUploadSchema = z.object({
  projectName: z.string().min(1).max(255),
  projectDescription: z.string().max(1000).optional(),
  projectStatus: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional().default('ACTIVE'),
  files: z.array(z.object({
    fileName: z.string(),
    category: z.enum(['structure', 'mep', 'electrical', 'other']),
    fileSize: z.number()
  }))
});

// Enhanced processing job interface for multi-file projects
interface MultiFileProcessingJob {
  id: string;
  projectId?: string;
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  totalFiles: number;
  completedFiles: number;
  files: {
    id: string;
    fileName: string;
    category: string;
    status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed';
    progress: number;
    processingId?: string;
    modelId?: string;
    error?: string;
    // Data returned by workers for finalization
    tempFragPath?: string;
    metadata?: any;
    originalFilename?: string;
    finalFragName?: string;
    isIfc?: boolean;
  }[];
  projectData?: any;
  projectBase: {
    name: string;
    description: string;
    status: string;
    createdBy: string;
    organizationId: string;
  };
  error?: string;
  createdAt: Date;
}

// In-memory store for multi-file processing jobs (use Redis in production)
const multiFileJobs = new Map<string, MultiFileProcessingJob>();

/**
 * POST /api/multi-file-upload
 * Create a project with multiple IFC/FRAG files
 */
router.post('/multi-file-upload', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  // Check for uploaded files
  const files = req.files as { [fieldname: string]: UploadedFile | UploadedFile[] } | UploadedFile[] | undefined;
  if (!files) {
    throw createApiError('No files provided', 400);
  }

  // Extract all uploaded files (support multiple file fields)
  const uploadedFiles: UploadedFile[] = [];
  
  if (Array.isArray(files)) {
    uploadedFiles.push(...files);
  } else {
    Object.values(files).forEach(fileField => {
      if (Array.isArray(fileField)) {
        uploadedFiles.push(...fileField);
      } else {
        uploadedFiles.push(fileField);
      }
    });
  }

  if (uploadedFiles.length === 0) {
    throw createApiError('No valid files found', 400);
  }

  // Validate all files
  const validatedFiles: Array<{
    file: UploadedFile;
    tempPath: string;
    category: string;
    isIfc: boolean;
  }> = [];

  let totalSizeMB = 0;

  for (const uploadedFile of uploadedFiles) {
    // Validate file type
    const fileName = uploadedFile.name.toLowerCase();
    const isIfc = fileName.endsWith('.ifc');
    const isFrag = fileName.endsWith('.frag');
    
    if (!isIfc && !isFrag) {
      throw createApiError(`Invalid file type: ${uploadedFile.name}. Only .ifc or .frag files are allowed`, 400);
    }

    // Handle temp file path
    let tempFilePath = uploadedFile.tempFilePath as string | undefined;
    if (!tempFilePath) {
      const fs = await import('fs');
      const path = await import('path');
      const tmpDir = process.env.FILE_UPLOAD_TMP_DIR || '/tmp';
      const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      tempFilePath = path.join(tmpDir, `upload_${unique}_${uploadedFile.name}`);
      await fs.promises.writeFile(tempFilePath, uploadedFile.data);
    }

    // Auto-detect category from filename
    const category = detectFileCategory(uploadedFile.name);
    
    validatedFiles.push({
      file: uploadedFile,
      tempPath: tempFilePath,
      category,
      isIfc
    });

    totalSizeMB += uploadedFile.size / (1024 * 1024);
  }

  // Check total file size limits
  const isProduction = process.env.NODE_ENV === 'production';
  const MAX_TOTAL_SIZE_MB = isProduction ? 10240 : 2048; // 10GB in production, 2GB in dev
  
  if (totalSizeMB > MAX_TOTAL_SIZE_MB) {
    throw createApiError(`Total file size too large: ${totalSizeMB.toFixed(1)}MB. Maximum allowed: ${MAX_TOTAL_SIZE_MB}MB`, 413);
  }

  // Check system resources for large uploads
  if (totalSizeMB > 500) {
    logSystemResources('Pre-multi-upload system status');
    const resourceCheck = shouldRejectLargeFile(totalSizeMB);
    if (resourceCheck.reject) {
      throw createApiError(resourceCheck.reason!, 503);
    }
  }

  // Validate project data
  const projectData = z.object({
    projectName: z.string().min(1).max(255),
    projectDescription: z.string().max(1000).optional(),
    projectStatus: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional().default('ACTIVE'),
  }).parse(req.body);

  logger.info(`🏗️ Starting multi-file project creation: ${projectData.projectName} with ${validatedFiles.length} files (${totalSizeMB.toFixed(1)}MB total)`);

  try {
    // Generate unique job ID
    const jobId = `multi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    
    // Create multi-file processing job
    const job: MultiFileProcessingJob = {
      id: jobId,
      status: 'uploading',
      progress: 0,
      message: 'Initializing multi-file upload...',
      totalFiles: validatedFiles.length,
      completedFiles: 0,
      files: validatedFiles.map((vf, index) => ({
        id: `file_${index}_${Date.now()}`,
        fileName: vf.file.name,
        category: vf.category,
        status: 'pending',
        progress: 0
      })),
      createdAt: new Date(),
      projectBase: {
        name: projectData.projectName,
        description: projectData.projectDescription || `Project with ${validatedFiles.length} files`,
        status: projectData.projectStatus,
        createdBy: req.user.id,
        organizationId: req.user!.organizationId,
      }
    };

    multiFileJobs.set(jobId, job);

    // Start processing each file
    for (let i = 0; i < validatedFiles.length; i++) {
      const validatedFile = validatedFiles[i];
      const fileJob = job.files[i];
      
      // Generate processing ID for this file
      const processingId = `proc_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
      fileJob.processingId = processingId;
      fileJob.status = 'uploading';

      // Prepare target filename - keep original name, add number if duplicate
      const baseName = validatedFile.file.name.replace(/\.(ifc|frag)$/i, '');
      const baseFragName = validatedFile.isIfc
        ? `${baseName}.frag`
        : validatedFile.file.name;
      
      // Check if this filename already exists in this job
      const existingFiles = job.files.slice(0, i).filter(f => f.finalFragName);
      const existingNames = existingFiles.map(f => f.finalFragName);
      
      let finalFragName = baseFragName;
      let counter = 1;
      while (existingNames.includes(finalFragName)) {
        const nameWithoutExt = baseFragName.replace(/\.frag$/i, '');
        finalFragName = `${nameWithoutExt} ${counter}.frag`;
        counter++;
      }
      
      // Store the finalFragName in the job for future duplicate checking
      fileJob.finalFragName = finalFragName;

      // Enqueue file for processing
      enqueueIfcConversion({
        processingId,
        tempFilePath: validatedFile.tempPath,
        originalFilename: validatedFile.file.name,
        finalFragName,
        uploadedByUserId: req.user.id,
        projectData: {
          // For multi-file uploads, this projectData should be ignored by the worker
          // The actual project will be created by updateMultiFileStatus when all files complete
          name: projectData.projectName, // Keep original name, not per-category
          description: projectData.projectDescription || `Multi-component project: ${projectData.projectName}`,
          status: projectData.projectStatus
        },
        // Multi-file context for the worker
        isMultiFile: true,
        multiFileJobId: jobId,
        fileIndex: i,
        category: fileJob.category
      });

      // Update file status
      fileJob.status = 'processing';
      fileJob.progress = 10;
    }

    // Update job status
    job.status = 'processing';
    job.progress = 10;
    job.message = `Processing ${validatedFiles.length} files...`;
    multiFileJobs.set(jobId, job);

    // Real progress will come directly from IFC converter via environment variables

    logger.info(`🚀 Multi-file processing started with job ID: ${jobId}`);

    // Return job ID for status tracking
    res.status(202).json({
      success: true,
      jobId,
      message: `Multi-file upload started. Processing ${validatedFiles.length} files.`,
      status: 'processing',
      totalFiles: validatedFiles.length,
      progress: 10
    });

  } catch (error) {
    // Cleanup temp files on error
    for (const vf of validatedFiles) {
      try {
        const fs = await import('fs');
        await fs.promises.unlink(vf.tempPath);
        logger.info(`🗑️ Cleaned up temp file: ${vf.tempPath}`);
      } catch (cleanupError) {
        logger.warn(`⚠️ Failed to cleanup temp file ${vf.tempPath}: ${cleanupError}`);
      }
    }
    
    logger.error('Error starting multi-file processing:', error);
    throw createApiError('Failed to start multi-file processing', 500);
  }
}));

/**
 * GET /api/multi-file-status/:jobId
 * Get multi-file processing status
 */
router.get('/multi-file-status/:jobId', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  const { jobId } = req.params;
  const job = multiFileJobs.get(jobId);

  if (!job) {
    logger.warn(`🔍 Job ${jobId} not found in multiFileJobs map`);
    throw createApiError('Multi-file job not found', 404);
  }

  logger.info(`🔍 Returning job status for ${jobId}: status=${job.status}, progress=${job.progress}`);

  // Clean up completed jobs older than 2 hours
  if ((job.status === 'completed' || job.status === 'failed')) {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    if (job.createdAt < twoHoursAgo) {
      multiFileJobs.delete(jobId);
      throw createApiError('Multi-file job expired', 404);
    }
  }

  // Return the same format as single file processing-status endpoint
  res.json({
    success: true,
    id: job.id,
    jobId: job.id, // Add jobId for frontend compatibility
    status: job.status,
    progress: job.progress,
    message: job.message,
    projectData: job.projectData,
    error: job.error,
    // Include additional multi-file specific data
    totalFiles: job.totalFiles,
    completedFiles: job.completedFiles,
    files: job.files
  });
}));

/**
 * Helper function to detect file category from filename
 */
function detectFileCategory(filename: string): string {
  const name = filename.toLowerCase();
  if (name.includes('mep') || name.includes('plumb') || name.includes('hvac') || name.includes('pipe')) {
    return 'mep';
  }
  if (name.includes('elect') || name.includes('power') || name.includes('light')) {
    return 'electrical';
  }
  if (name.includes('struct') || name.includes('frame') || name.includes('beam') || name.includes('column')) {
    return 'structure';
  }
  return 'other';
}

/**
 * Function called by worker to update individual file status within multi-file job
 */
export function updateMultiFileStatus(
  jobId: string,
  fileIndex: number,
  status: 'processing' | 'completed' | 'failed',
  progress: number,
  message: string,
  modelData?: any,
  error?: string
) {
  const job = multiFileJobs.get(jobId);
  if (!job || !job.files[fileIndex]) {
    logger.warn(`⚠️ Multi-file job ${jobId} or file ${fileIndex} not found for status update`);
    return;
  }

  // Update individual file status
  job.files[fileIndex].status = status;
  job.files[fileIndex].progress = progress;
  // Store model data from worker (temp FRAG path and metadata)
  if (modelData) {
    if (modelData.id) job.files[fileIndex].modelId = modelData.id;
    if (modelData.tempFragPath) job.files[fileIndex].tempFragPath = modelData.tempFragPath;
    if (modelData.metadata) job.files[fileIndex].metadata = modelData.metadata;
    if (modelData.originalFilename) job.files[fileIndex].originalFilename = modelData.originalFilename;
    if (modelData.finalFragName) job.files[fileIndex].finalFragName = modelData.finalFragName;
    if (typeof modelData.isIfc === 'boolean') job.files[fileIndex].isIfc = modelData.isIfc;
  }
  if (error) {
    job.files[fileIndex].error = error;
  }

  // Calculate overall job progress
  const completedFiles = job.files.filter(f => f.status === 'completed').length;
  const failedFiles = job.files.filter(f => f.status === 'failed').length;
  const processingFiles = job.files.filter(f => f.status === 'processing').length;

  job.completedFiles = completedFiles;
  
  // Update overall job status
  if (completedFiles === job.totalFiles) {
    // All files completed successfully -> Create unified project and attach models
    logger.info(`🎯 All files completed for multi-file job ${jobId}. Creating unified project...`);
    (async () => {
      try {
        const categoryMap: Record<string, any> = {
          structure: 'STRUCTURE',
          mep: 'MEP',
          electrical: 'ELECTRICAL',
          other: 'OTHER'
        };

        // Create project with transaction to handle displayNumber
        const project = await prisma.$transaction(async (tx) => {
          // Get the max displayNumber for this organization
          const maxProjectInOrg = await tx.project.findFirst({
            where: { organizationId: job.projectBase.organizationId },
            orderBy: { displayNumber: 'desc' },
            select: { displayNumber: true }
          });
          const nextDisplayNumber = (maxProjectInOrg?.displayNumber || 0) + 1;

          return tx.project.create({
            data: {
              name: job.projectBase.name,
              description: job.projectBase.description,
              status: job.projectBase.status as any,
              organizationId: job.projectBase.organizationId,
              displayNumber: nextDisplayNumber,
              metadata: {
                createdFromMultiFile: true,
                totalFiles: job.totalFiles,
                categories: job.files.map(f => f.category)
              },
              createdBy: job.projectBase.createdBy
            }
          });
        });

        // Add creator as project member (OWNER)
        await prisma.projectMember.create({
          data: {
            projectId: project.id,
            userId: job.projectBase.createdBy,
            role: 'OWNER'
          }
        });

        const createdModelIds: string[] = [];
        // For each file, create model and upload FRAG to storage
        for (let idx = 0; idx < job.files.length; idx++) {
          const f = job.files[idx];
          const finalName = f.finalFragName || f.fileName.replace(/\.[^/.]+$/, '.frag');

          // Create model with temporary storageKey
          const model = await prisma.model.create({
            data: {
              projectId: project.id,
              type: 'FRAG',
              originalFilename: finalName,
              storageKey: 'temp_key',
              sizeBytes: BigInt(0),
              status: 'READY',
              processingProgress: 100,
              version: 1,
              isActive: true, // All models in multi-file project should be active
              category: categoryMap[f.category] || 'OTHER',
              displayName: f.category.charAt(0).toUpperCase() + f.category.slice(1),
              isMultiFile: true
            }
          });

          // Compute final storage key and upload
          const finalStorageKey = storageService.generateStorageKey(String(project.id), model.id, finalName);

          // Read temp FRAG and upload
          if (!f.tempFragPath) throw new Error(`Missing temp FRAG path for file index ${idx}`);
          const fs = await import('fs');
          const fragBuffer = await fs.promises.readFile(f.tempFragPath);
          await storageService.uploadFile(finalStorageKey, fragBuffer, 'application/octet-stream');

          // Update model with real storage key and size
          await prisma.model.update({
            where: { id: model.id },
            data: { storageKey: finalStorageKey, sizeBytes: BigInt(fragBuffer.length) }
          });

          // Create panels if metadata present and calculate element count
          const meta: any = f.metadata;
          let elementCount = 0;
          
          if (meta && Array.isArray(meta.storeys)) {
            const panels: any[] = [];
            for (const storey of meta.storeys) {
              if (storey.elements && storey.elements.length) {
                elementCount += storey.elements.length; // Count elements for this model
                for (const element of storey.elements) {
                  panels.push({
                    projectId: project.id,
                    modelId: model.id,
                    name: element.name,
                    tag: element.name,
                    objectType: element.type,
                    location: storey.name,
                    material: element.material && element.material !== 'N/A' ? element.material : null,
                    metadata: {
                      extractedFromIFC: true,
                      storeyName: storey.name,
                      elementType: element.type,
                      ifcElementId: element.id,
                      material: element.material
                    }
                  });
                }
              }
            }
            if (panels.length) {
              await prisma.panel.createMany({ data: panels, skipDuplicates: true });
            }
          }
          
          // Update model with element count
          await prisma.model.update({
            where: { id: model.id },
            data: { elementCount }
          });

          // Cleanup temp file
          try { await (await import('fs')).promises.unlink(f.tempFragPath); } catch {}

          createdModelIds.push(model.id);
        }

        // Set current model id to the first
        if (createdModelIds.length) {
          await prisma.project.update({ where: { id: project.id }, data: { currentModelId: createdModelIds[0] } });
        }

        job.status = 'completed';
        job.progress = 100;
        job.message = `Project created with ${createdModelIds.length} models`;
        job.projectId = String(project.id);
        job.projectData = { id: project.id, name: project.name };
        multiFileJobs.set(jobId, job);
        logger.info(`✅ Multi-file job ${jobId} created project ${project.id} with ${createdModelIds.length} models`);
        logger.info(`🔍 Job status updated to: ${job.status}, progress: ${job.progress}`);
      } catch (e: any) {
        job.status = 'failed';
        job.message = 'Failed to finalize multi-file project';
        job.error = e?.message || 'Unknown error';
        multiFileJobs.set(jobId, job);
        logger.error(`❌ Failed to finalize multi-file job ${jobId}:`, e);
      }
    })();
  } else if (failedFiles > 0 && (completedFiles + failedFiles) === job.totalFiles) {
    // Some files failed, no more processing
    job.status = 'failed';
    job.progress = Math.round((completedFiles / job.totalFiles) * 100);
    job.message = `${failedFiles} of ${job.totalFiles} files failed to process`;
  } else if (processingFiles > 0) {
    // Still processing - calculate progress based on individual file progress
    let totalProgress = completedFiles * 100; // Completed files contribute 100% each
    
    // Add partial progress from processing files
    job.files.forEach(f => {
      if (f.status === 'processing') {
        totalProgress += f.progress || 0; // Add individual file progress
      }
    });
    
    job.status = 'processing';
    job.progress = Math.min(99, Math.round(totalProgress / job.totalFiles)); // Cap at 99% until all complete
    job.message = `Processing ${processingFiles} files, ${completedFiles} completed...`;
  }

  multiFileJobs.set(jobId, job);
  logger.info(`📊 Multi-file job ${jobId}: ${job.status} (${job.progress}%) - ${job.message}`);
}

/**
 * Function to complete multi-file processing
 */
export function completeMultiFileJob(jobId: string, projectData: any) {
  const job = multiFileJobs.get(jobId);
  if (job) {
    job.status = 'completed';
    job.progress = 100;
    job.message = 'Multi-file project created successfully!';
    job.projectData = projectData;
    multiFileJobs.set(jobId, job);
    logger.info(`✅ Multi-file job ${jobId} completed successfully`);
  }
}

/**
 * Function to fail multi-file processing
 */
export function failMultiFileJob(jobId: string, error: string) {
  const job = multiFileJobs.get(jobId);
  if (job) {
    job.status = 'failed';
    job.message = 'Multi-file processing failed';
    job.error = error;
    multiFileJobs.set(jobId, job);
    logger.error(`❌ Multi-file job ${jobId} failed: ${error}`);
  }
}

export { router as multiFileUploadRouter };
