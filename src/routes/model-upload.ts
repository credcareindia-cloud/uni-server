// import { Router, Response } from 'express';
// import { z } from 'zod';
// import multer from 'multer';
// import { prisma } from '../config/database.js';
// import { storageService } from '../config/storage.js';
// import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
// import { logger } from '../utils/logger.js';

// const router = Router();

// // Configure multer for file uploads
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: {
//     fileSize: 100 * 1024 * 1024, // 100MB limit
//   },
//   fileFilter: (req, file, cb) => {
//     if (file.originalname.toLowerCase().endsWith('.frag')) {
//       cb(null, true);
//     } else {
//       cb(new Error('Only .frag files are allowed'));
//     }
//   }
// });

// // Validation schema for project creation with model
// const createProjectWithModelSchema = z.object({
//   projectName: z.string().min(1).max(255),
//   projectDescription: z.string().max(1000).optional(),
//   projectStatus: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional().default('ACTIVE'),
// });

// /**
//  * POST /api/upload/model-with-project
//  * Upload a FRAG model and create a project automatically when processing succeeds
//  */
// router.post('/model-with-project', upload.single('fragFile'), asyncHandler(async (req: any, res: Response) => {
//   // Temporary: Use demo user for testing without auth
//   let demoUser = await prisma.user.findUnique({
//     where: { email: 'demo@uniqube.com' }
//   });
  
//   // Create demo user if it doesn't exist
//   if (!demoUser) {
//     demoUser = await prisma.user.create({
//       data: {
//         email: 'demo@uniqube.com',
//         name: 'Demo User',
//         passwordHash: 'demo-hash',
//         role: 'USER'
//       }
//     });
//   }
  
//   req.user = demoUser;

//   if (!req.user) {
//     throw createApiError('User not authenticated', 401);
//   }

//   if (!req.file) {
//     throw createApiError('No FRAG file provided', 400);
//   }

//   // Validate project data
//   const projectData = createProjectWithModelSchema.parse(req.body);

//   try {
//     // Start a transaction to ensure data consistency
//     const result = await prisma.$transaction(async (tx) => {
//       // Create the project first
//       const project = await tx.project.create({
//         data: {
//           name: projectData.projectName,
//           description: projectData.projectDescription || `Project created from ${req.file.originalname}`,
//           status: projectData.projectStatus,
//           metadata: {
//             createdFromModel: true,
//             originalFilename: req.file.originalname
//           },
//           createdBy: req.user.id
//         }
//       });

//       // Upload file to storage
//       const fileKey = `models/${project.id}/${Date.now()}-${req.file.originalname}`;
//       await storageService.uploadFile(fileKey, req.file.buffer, req.file.mimetype);

//       // Create the model record
//       const model = await tx.model.create({
//         data: {
//           projectId: project.id,
//           type: 'FRAG',
//           originalFilename: req.file.originalname,
//           storageKey: fileKey,
//           sizeBytes: req.file.size,
//           status: 'PROCESSING',
//           version: 1,
//           isActive: true,
//           uploadedBy: req.user.id
//         }
//       });

//       // Update project to set current model
//       await tx.project.update({
//         where: { id: project.id },
//         data: { currentModelId: model.id }
//       });

//       return { project, model };
//     });

//     logger.info(`Project and model created: ${result.project.name} with model ${result.model.id}`);

//     // Process the model asynchronously
//     processModelAsync(result.model.id, req.file.buffer);

//     // Return immediate response
//     res.status(201).json({
//       success: true,
//       project: {
//         id: result.project.id,
//         name: result.project.name,
//         description: result.project.description,
//         status: result.project.status.toLowerCase().replace('_', '-'),
//         createdAt: result.project.createdAt,
//         updatedAt: result.project.updatedAt
//       },
//       model: {
//         id: result.model.id,
//         originalFilename: result.model.originalFilename,
//         status: result.model.status.toLowerCase(),
//         version: result.model.version,
//         sizeBytes: result.model.sizeBytes
//       },
//       message: 'Project created and model is being processed. You will be notified when processing is complete.'
//     });

//   } catch (error) {
//     logger.error('Error creating project with model:', error);
//     throw createApiError('Failed to create project with model', 500);
//   }
// }));

// /**
//  * Async function to process the model after upload
//  */
// async function processModelAsync(modelId: string, fileBuffer: Buffer) {
//   try {
//     logger.info(`Starting async processing for model ${modelId}`);

//     // Process the FRAG file
//     const metadata = await fragProcessor.processFragFile(fileBuffer);

//     // Update model with processing results
//     await prisma.model.update({
//       where: { id: modelId },
//       data: {
//         status: 'READY',
//         elementCount: metadata.totalElements,
//         metadata: metadata,
//         processedAt: new Date()
//       }
//     });

//     // Create groups and panels from metadata
//     if (metadata.groups && metadata.groups.length > 0) {
//       await prisma.group.createMany({
//         data: metadata.groups.map(group => ({
//           modelId: modelId,
//           name: group.name,
//           ifcType: group.ifcType,
//           elementIds: group.elementIds,
//           metadata: group
//         }))
//       });
//     }

//     if (metadata.panels && metadata.panels.length > 0) {
//       await prisma.panel.createMany({
//         data: metadata.panels.map(panel => ({
//           modelId: modelId,
//           name: panel.name,
//           storey: panel.storey,
//           status: 'PENDING',
//           metadata: panel
//         }))
//       });
//     }

//     logger.info(`Model ${modelId} processed successfully with ${metadata.totalElements} elements`);

//   } catch (error) {
//     logger.error(`Error processing model ${modelId}:`, error);

//     // Update model status to failed
//     await prisma.model.update({
//       where: { id: modelId },
//       data: {
//         status: 'FAILED',
//         metadata: { error: error instanceof Error ? error.message : String(error) }
//       }
//     });
//   }
// }

// export { router as modelUploadRouter };
