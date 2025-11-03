import { Router, Response } from 'express';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';

const router = Router();

/**
 * GET /api/models/:id/download
 * Download a model file
 */
router.get('/models/:id/download', asyncHandler(async (req: any, res: Response) => {
  const { id } = req.params;
  
  logger.info(`📥 Download request for model: ${id}`);
  
  try {
    // Find the model
    const model = await prisma.model.findUnique({
      where: { id }
    });
    
    if (!model) {
      throw createApiError('Model not found', 404);
    }
    
    logger.info(`✅ Model found: ${model.originalFilename}, Storage key: ${model.storageKey}`);
    
    // Download file from storage
    const fileBuffer = await storageService.downloadFile(model.storageKey);
    
    logger.info(`✅ File downloaded from storage: ${fileBuffer.length} bytes`);
    
    // Set headers for file download
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${model.originalFilename}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow CORS for viewer
    
    // Send file
    res.send(fileBuffer);
    
    logger.info(`✅ File sent to client: ${model.originalFilename}`);
    
  } catch (error) {
    logger.error('Error downloading model:', error);
    throw error;
  }
}));

export { router as modelDownloadRouter };
