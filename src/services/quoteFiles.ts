import { readFile } from 'node:fs/promises';
import type fileUpload from 'express-fileupload';
import type { Response } from 'express';
import { DocumentCategory } from '@prisma/client';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';
import { createApiError } from '../middleware/errorHandler.js';

type Uploaded = fileUpload.UploadedFile;

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  dwg: 'application/acad',
  dxf: 'application/dxf',
  ifc: 'application/x-step',
};

/** Marketing site caps drawings at 4 MB; staff manual uploads may be larger. */
export const MAX_QUOTE_DRAWING_BYTES = Number(process.env.QUOTE_DRAWING_MAX_BYTES || 25 * 1024 * 1024);
export const MAX_QUOTE_MODEL_BYTES = Number(process.env.QUOTE_MODEL_MAX_BYTES || 500 * 1024 * 1024);

export function quoteContentType(filename: string, fallback?: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] || fallback || 'application/octet-stream';
}

function isObjectKey(key: string | null | undefined): key is string {
  return Boolean(key && key.startsWith('quotes/'));
}

async function bufferFromUpload(file: Uploaded): Promise<Buffer> {
  if (file.data && file.data.length > 0) return file.data;
  if (file.tempFilePath) return readFile(file.tempFilePath);
  throw createApiError('Uploaded file had no content', 400);
}

export async function storeQuoteAttachment(params: {
  organizationId: string;
  quoteId: string;
  kind: 'drawing' | 'model';
  file: Uploaded;
}): Promise<{ key: string; name: string; contentType: string; sizeBytes: number }> {
  const { organizationId, quoteId, kind, file } = params;
  const max = kind === 'drawing' ? MAX_QUOTE_DRAWING_BYTES : MAX_QUOTE_MODEL_BYTES;
  if (file.size > max) {
    throw createApiError(
      `${kind === 'drawing' ? 'Drawing' : 'Model'} is larger than ${Math.round(max / (1024 * 1024))} MB`,
      413
    );
  }

  const key = storageService.quoteFileKey(organizationId, quoteId, kind, file.name);
  const contentType = quoteContentType(file.name, file.mimetype);
  const buffer = await bufferFromUpload(file);

  await storageService.uploadFile(key, buffer, contentType, {
    organizationid: organizationId,
    quoteid: quoteId,
    kind,
  });

  return { key, name: file.name, contentType, sizeBytes: file.size };
}

/** Upload drawing/model; on failure delete the quote row and any objects already written. */
export async function attachQuoteFiles(params: {
  organizationId: string;
  quoteId: string;
  drawing?: Uploaded;
  model?: Uploaded;
}): Promise<{
  drawingKey?: string;
  drawingName?: string;
  modelKey?: string;
  modelName?: string;
}> {
  const { organizationId, quoteId, drawing, model } = params;
  const saved: { drawingKey?: string; drawingName?: string; modelKey?: string; modelName?: string } = {};

  try {
    if (drawing) {
      const result = await storeQuoteAttachment({ organizationId, quoteId, kind: 'drawing', file: drawing });
      saved.drawingKey = result.key;
      saved.drawingName = result.name;
    }
    if (model) {
      const result = await storeQuoteAttachment({ organizationId, quoteId, kind: 'model', file: model });
      saved.modelKey = result.key;
      saved.modelName = result.name;
    }
    return saved;
  } catch (error) {
    await purgeQuoteStorage(organizationId, quoteId).catch((purgeError) => {
      logger.warn(`Failed to purge quote objects after upload error (${quoteId})`, purgeError);
    });
    await prisma.quoteRequest.delete({ where: { id: quoteId } }).catch(() => undefined);
    throw error;
  }
}

export async function streamQuoteAttachment(
  res: Response,
  key: string | null,
  filename: string | null
): Promise<void> {
  if (!filename) throw createApiError('That file was not uploaded', 404);

  // Legacy local-disk keys from before S3 (ephemeral Fargate paths) are not recoverable.
  if (!isObjectKey(key)) throw createApiError('That file is no longer available', 404);

  const exists = await storageService.objectExists(key);
  if (!exists) throw createApiError('That file was not uploaded', 404);

  await storageService.streamToResponse(key, res, {
    filename,
    contentType: quoteContentType(filename),
  });
}

export async function purgeQuoteStorage(organizationId: string, quoteId: string): Promise<void> {
  const prefix = `quotes/${organizationId}/${quoteId}`;
  const deleted = await storageService.deletePrefix(prefix);
  if (deleted > 0) logger.info(`Purged ${deleted} quote object(s) under ${prefix}`);
}

/**
 * When staff start a project from a request, promote the drawing into project Documents
 * so it lives with the job (same bucket layout as Docs tab uploads).
 */
export async function promoteQuoteDrawingToProject(params: {
  organizationId: string;
  quoteId: string;
  projectId: number;
  drawingKey: string | null;
  drawingName: string | null;
  uploadedBy: string;
}): Promise<void> {
  const { organizationId, quoteId, projectId, drawingKey, drawingName, uploadedBy } = params;
  if (!isObjectKey(drawingKey) || !drawingName) return;

  const ext = drawingName.split('.').pop()?.toLowerCase() || 'bin';
  const destKey = `documents/${projectId}/drawings/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const contentType = quoteContentType(drawingName);

  try {
    await storageService.copyObject(drawingKey, destKey, contentType);
    const head = await storageService.headObject(drawingKey);

    await prisma.projectDocument.create({
      data: {
        projectId,
        category: DocumentCategory.DRAWINGS,
        name: drawingName,
        originalFilename: drawingName,
        storageKey: destKey,
        mimeType: contentType,
        sizeBytes: BigInt(head?.contentLength ?? 0),
        uploadedBy,
      },
    });
    logger.info(`Promoted quote ${quoteId} drawing to project ${projectId} document`);
  } catch (error) {
    // Starting the project should not fail because the drawing copy failed — staff can re-upload.
    logger.error(`Failed to promote quote drawing ${quoteId} → project ${projectId}`, error);
  }
}
