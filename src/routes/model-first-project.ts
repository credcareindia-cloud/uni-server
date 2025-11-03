import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
// import { fragProcessor } from '../services/fragProcessor.js';
import { ifcConverter } from '../services/ifcConverter.js';

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
router.post('/create-project-with-model', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    throw createApiError('User not authenticated', 401);
  }

  // Check for uploaded file using express-fileupload
  if (!req.files || !req.files.fragFile) {
    throw createApiError('No model file provided', 400);
  }

  const uploadedFile = Array.isArray(req.files.fragFile) ? req.files.fragFile[0] : req.files.fragFile;
  
  // Handle both temp files and in-memory files
  const fileBuffer = uploadedFile.tempFilePath 
    ? await import('fs').then(fs => fs.promises.readFile(uploadedFile.tempFilePath))
    : uploadedFile.data;
  
  // Debug: Check file data before processing
  logger.info(`🔍 File received - Name: ${uploadedFile.name}, Size: ${uploadedFile.size}, Using temp file: ${!!uploadedFile.tempFilePath}`);
  if (uploadedFile.tempFilePath) {
    logger.info(`📂 Temp file path: ${uploadedFile.tempFilePath}`);
  }
  
  // Validate file type (IFC or FRAG)
  const fileName = uploadedFile.name.toLowerCase();
  const isIfc = fileName.endsWith('.ifc');
  const isFrag = fileName.endsWith('.frag');
  
  if (!isIfc && !isFrag) {
    throw createApiError('Only .ifc or .frag files are allowed', 400);
  }

  logger.info(`📁 File type: ${isIfc ? 'IFC' : 'FRAG'}, Buffer size: ${fileBuffer.length} bytes`);

  // Validate project data
  const projectData = createProjectWithModelSchema.parse(req.body);

  try {
    // Convert IFC to FRAG if needed
    let fragFileData: Buffer;
    let originalFilename: string;
    let extractedMetadata: any = null;

    if (isIfc) {
      logger.info('🔄 Converting IFC to FRAG format...');
      logger.info(`💾 IFC file size: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);
      
      const conversionResult = await ifcConverter.convertIfcToFragments(
        fileBuffer,
        (progress, message) => {
          logger.info(`📊 ${message}`);
        }
      );

      fragFileData = Buffer.from(conversionResult.fragmentsBuffer);
      originalFilename = uploadedFile.name.replace(/\.ifc$/i, '.frag');
      extractedMetadata = conversionResult.metadata;
      
      logger.info(`✅ IFC converted to FRAG: ${fragFileData.length} bytes`);
      logger.info(`📊 Extracted during conversion: ${extractedMetadata.totalElements} elements, ${extractedMetadata.storeys.length} storeys`);
    } else {
      fragFileData = uploadedFile.data;
      originalFilename = uploadedFile.name;
      logger.info('📦 Processing FRAG file directly');
    }

    // Start a transaction to ensure data consistency
    const result = await prisma.$transaction(async (tx) => {
      // Create the project first
      const project = await tx.project.create({
        data: {
          name: projectData.projectName,
          description: projectData.projectDescription || `Project created from ${uploadedFile.name}`,
          status: projectData.projectStatus,
          metadata: {
            createdFromModel: true,
            originalFilename: uploadedFile.name,
            convertedFromIfc: isIfc,
            modelFirst: true
          },
          createdBy: req.user.id
        }
      });

      // Upload FRAG file to storage (either converted or original)
      const fileKey = `models/${project.id}/${Date.now()}-${originalFilename}`;
      logger.info(`🔍 Before storage upload - Data length: ${fragFileData.length}`);
      await storageService.uploadFile(fileKey, fragFileData, 'application/octet-stream');
      logger.info(`🔍 After storage upload - Data length: ${fragFileData.length}`);

      // Create the model record
      const model = await tx.model.create({
        data: {
          projectId: project.id,
          type: 'FRAG',
          originalFilename: originalFilename,
          storageKey: fileKey,
          sizeBytes: BigInt(fragFileData.length),
          status: 'READY',
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

    // Process the FRAG file to extract additional metadata
    // If we already have metadata from IFC conversion, convert it to FRAG format
    let metadata;
    if (extractedMetadata && extractedMetadata.storeys) {
      logger.info(`✅ Using metadata extracted during IFC conversion`);
      logger.info(`📊 Converting IFC metadata to FRAG format...`);
      
      // Convert IFC metadata to FRAG metadata format
      // Extract all panels from all storeys
      const allPanels: any[] = [];
      extractedMetadata.storeys.forEach((storey: any) => {
        if (storey.elements && storey.elements.length > 0) {
          storey.elements.forEach((element: any) => {
            allPanels.push({
              id: element.id,
              name: element.name,
              type: element.type,
              material: element.material, // Include material
              storey: storey.name
            });
          });
        }
      });
      
      metadata = {
        totalElements: extractedMetadata.totalElements || 0,
        panels: allPanels,
        groups: [],
        spatialStructure: extractedMetadata.storeys.map((storey: any, index: number) => ({
          id: `${result.model.id.slice(-8)}_storey_${index}`,
          name: storey.name,
          type: 'IfcBuildingStorey',
          elementCount: storey.elementCount,
          properties: {
            description: `Building storey: ${storey.name}`,
            elevation: index * 3000, // Estimated elevation
            elementIds: storey.elements ? storey.elements.map((e: any) => e.id) : []
          },
          children: storey.elements ? storey.elements.map((element: any) => ({
            id: element.id,
            name: element.name,
            type: element.type,
            material: element.material, // Include material in children
            properties: {
              storey: storey.name,
              material: element.material // Also in properties for compatibility
            }
          })) : []
        })),
        statistics: {
          totalPanels: allPanels.length,
          completedPanels: 0,
          readyForProduction: 0,
          inProduction: 0,
          shipped: 0,
          preFabricated: 0,
          progressPercentage: 0,
          statusBreakdown: {}
        }
      };
      
      logger.info(`✅ Converted IFC metadata: ${metadata.totalElements} elements, ${metadata.spatialStructure.length} storeys`);
      
      // Save metadata to database
      await prisma.model.update({
        where: { id: result.model.id },
        data: {
          elementCount: metadata.totalElements,
          spatialStructure: metadata.spatialStructure
        }
      });
      logger.info(`💾 Metadata saved to database for model ${result.model.id}`);
      
      // Save panels to Panel Management system
      if (metadata.panels && metadata.panels.length > 0) {
        logger.info(`📦 Saving ${metadata.panels.length} panels to Panel Management...`);
        
        const panelsToCreate = metadata.panels.map((panel: any) => ({
          projectId: result.project.id,
          modelId: result.model.id,
          // Don't set elementId - it has a foreign key constraint to ModelElement table
          name: panel.name,
          tag: panel.name, // Use name as tag
          objectType: panel.type, // IFC type (IfcElementAssembly, etc.)
          location: panel.storey, // Storey name as location
          material: panel.material && panel.material !== 'N/A' ? panel.material : null, // Material from IFC
          // Note: status is now managed via PanelStatus junction table (many-to-many)
          metadata: {
            extractedFromIFC: true,
            storeyName: panel.storey,
            elementType: panel.type,
            ifcElementId: panel.id, // Store IFC element ID in metadata instead
            material: panel.material
            // ...(panel.status ? { defaultStatus: panel.status } : {}) // Store status in metadata if provided
          }
        }));
        
        // Batch create panels
        await prisma.panel.createMany({
          data: panelsToCreate,
          skipDuplicates: true
        });
        
        logger.info(`✅ ${metadata.panels.length} panels saved to Panel Management`);
      }
    } else {
      // COMMENTED OUT: FRAG file processing no longer needed
      // FRAG files are only used for viewer display, not for metadata extraction
      // All metadata is extracted from IFC files during upload
      // FRAG files can be uploaded directly and stored without processing
      logger.info(`📦 FRAG file uploaded - no metadata extraction needed`);
      
      // For FRAG files, just return empty metadata structure
      metadata = {
        totalElements: 0,
        panels: [],
        groups: [],
        spatialStructure: [],
        statistics: {
          totalPanels: 0,
          completedPanels: 0,
          readyForProduction: 0,
          inProduction: 0,
          shipped: 0,
          preFabricated: 0,
          progressPercentage: 0,
          statusBreakdown: {}
        }
      };
      
      // logger.info(`🔄 Starting FRAG processing for model ${result.model.id}`);
      // metadata = await fragProcessor.processFragFile(result.model.id, fragFileData);
      // logger.info(`✅ FRAG processing completed successfully for model ${result.model.id}`);
      // await prisma.model.update({
      //   where: { id: result.model.id },
      //   data: {
      //     elementCount: metadata.totalElements,
      //     spatialStructure: metadata.spatialStructure
      //   }
      // });
      // logger.info(`💾 Metadata saved to database for model ${result.model.id}`);
    }

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

    // Cleanup temp file if it exists
    if (uploadedFile.tempFilePath) {
      try {
        const fs = await import('fs');
        await fs.promises.unlink(uploadedFile.tempFilePath);
        logger.info(`🗑️ Cleaned up temp file: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        logger.warn(`⚠️ Failed to cleanup temp file: ${cleanupError}`);
      }
    }

  } catch (error) {
    // Cleanup temp file on error
    if (uploadedFile.tempFilePath) {
      try {
        const fs = await import('fs');
        await fs.promises.unlink(uploadedFile.tempFilePath);
        logger.info(`🗑️ Cleaned up temp file after error: ${uploadedFile.tempFilePath}`);
      } catch (cleanupError) {
        logger.warn(`⚠️ Failed to cleanup temp file: ${cleanupError}`);
      }
    }
    
    logger.error('Error creating project with model:', error);
    throw createApiError('Failed to create project with model', 500);
  }
}));

export { router as modelFirstProjectRouter };
