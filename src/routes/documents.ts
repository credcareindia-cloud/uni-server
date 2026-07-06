import { Router, Response } from 'express';
import { DocumentCategory, PrismaClient } from '@prisma/client';
import type { UploadedFile } from 'express-fileupload';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';

const router = Router();
const prisma = new PrismaClient();

router.use(authenticateToken);

const MAX_DOC_SIZE = Number(process.env.DOCS_MAX_FILE_SIZE || 200 * 1024 * 1024); // 200MB
const docNameSchema = z.string().trim().min(1).max(255);
const categorySchema = z.nativeEnum(DocumentCategory);

const CATEGORY_RULES: Record<DocumentCategory, { extensions: Set<string>; mimePrefixes: string[] }> = {
  DRAWINGS: {
    extensions: new Set([
      'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif',
      'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'dwg', 'dxf', 'dwf', 'skp', 'rvt',
      'zip', 'txt', 'csv',
    ]),
    mimePrefixes: [
      'application/pdf',
      'image/',
      'application/vnd.openxmlformats-officedocument',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/zip',
      'application/x-zip-compressed',
      'text/plain',
      'application/octet-stream',
    ],
  },
  LOGISTICS: {
    extensions: new Set(['pdf']),
    mimePrefixes: ['application/pdf'],
  },
  CNC: {
    extensions: new Set([
      'nc', 'cnc', 'tap', 'gcode', 'gc', 'mpg', 'cps', 'iso', 'txt',
      'csv', 'xls', 'xlsx',
    ]),
    mimePrefixes: [
      'text/plain',
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
      'application/x-nc',
      'application/x-gcode',
    ],
  },
};

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : '';
}

function isAllowedForCategory(file: UploadedFile, category: DocumentCategory): { ok: boolean; reason?: string } {
  const rules = CATEGORY_RULES[category];
  const ext = getExtension(file.name || '');
  const mime = (file.mimetype || '').toLowerCase();
  const mimeOk = rules.mimePrefixes.some(prefix => mime === prefix || mime.startsWith(prefix));
  const extOk = rules.extensions.has(ext);
  if (!mimeOk && !extOk) {
    const allowed = [...rules.extensions].join(', ');
    return { ok: false, reason: `Unsupported file type for ${category}. Allowed: ${allowed}` };
  }
  return { ok: true };
}

function ensureProjectAccess(projectId: number, userId: string) {
  return prisma.project.findFirst({
    where: {
      id: projectId,
      OR: [
        { createdBy: userId },
        { members: { some: { userId } } },
      ],
    },
    select: { id: true, organizationId: true },
  });
}

function parseCategoryParam(raw: unknown): DocumentCategory | null {
  const parsed = categorySchema.safeParse(
    typeof raw === 'string' ? raw.toUpperCase() : raw
  );
  return parsed.success ? parsed.data : null;
}

// GET /api/documents/:projectId?category=DRAWINGS|LOGISTICS|CNC
router.get('/:projectId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const projectId = parseInt(req.params.projectId);
    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await ensureProjectAccess(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const category = req.query.category ? parseCategoryParam(req.query.category) : null;
    if (req.query.category && !category) {
      return res.status(400).json({ error: 'Invalid category. Use DRAWINGS, LOGISTICS, or CNC.' });
    }

    const docs = await prisma.projectDocument.findMany({
      where: {
        projectId,
        ...(category ? { category } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        uploader: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({
      documents: docs.map(d => ({
        ...d,
        sizeBytes: Number(d.sizeBytes),
      })),
    });
  } catch (error) {
    logger.error('Error listing documents:', error);
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// POST /api/documents/:projectId  (multipart: name, category, file)
router.post('/:projectId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const projectId = parseInt(req.params.projectId);
    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await ensureProjectAccess(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsedName = docNameSchema.safeParse(req.body?.name);
    if (!parsedName.success) {
      return res.status(400).json({ error: 'Document name is required (1–255 chars)' });
    }

    const category = parseCategoryParam(req.body?.category) ?? DocumentCategory.DRAWINGS;

    const fileField = req.files?.file;
    const file = Array.isArray(fileField) ? fileField[0] : (fileField as UploadedFile | undefined);
    if (!file) return res.status(400).json({ error: 'No file uploaded (field "file")' });

    const allowed = isAllowedForCategory(file, category);
    if (!allowed.ok) return res.status(400).json({ error: allowed.reason || 'Unsupported file type' });

    if (file.size > MAX_DOC_SIZE) {
      return res.status(413).json({
        error: `File too large (${Math.round(file.size / 1024 / 1024)} MB). Limit: ${Math.round(MAX_DOC_SIZE / 1024 / 1024)} MB.`,
      });
    }

    const ext = getExtension(file.name) || 'bin';
    const safeKey = `documents/${projectId}/${category.toLowerCase()}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

    const buffer = file.data && file.data.length > 0
      ? file.data
      : await (await import('node:fs/promises')).readFile(file.tempFilePath);

    await storageService.uploadFile(safeKey, buffer, file.mimetype || 'application/octet-stream');

    const doc = await prisma.projectDocument.create({
      data: {
        projectId,
        category,
        name: parsedName.data,
        originalFilename: file.name,
        storageKey: safeKey,
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: BigInt(file.size),
        uploadedBy: req.user.id,
      },
      include: {
        uploader: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(201).json({
      document: { ...doc, sizeBytes: Number(doc.sizeBytes) },
    });
  } catch (error) {
    logger.error('Error uploading document:', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// PATCH /api/documents/:projectId/:documentId  (rename)
router.patch('/:projectId/:documentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const projectId = parseInt(req.params.projectId);
    const { documentId } = req.params;
    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await ensureProjectAccess(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsedName = docNameSchema.safeParse(req.body?.name);
    if (!parsedName.success) {
      return res.status(400).json({ error: 'Document name is required (1–255 chars)' });
    }

    const existing = await prisma.projectDocument.findFirst({
      where: { id: documentId, projectId },
    });
    if (!existing) return res.status(404).json({ error: 'Document not found' });

    const doc = await prisma.projectDocument.update({
      where: { id: documentId },
      data: { name: parsedName.data },
      include: { uploader: { select: { id: true, name: true, email: true } } },
    });

    res.json({ document: { ...doc, sizeBytes: Number(doc.sizeBytes) } });
  } catch (error) {
    logger.error('Error renaming document:', error);
    res.status(500).json({ error: 'Failed to rename document' });
  }
});

// GET /api/documents/:projectId/:documentId/download  -> { url }
router.get('/:projectId/:documentId/download', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const projectId = parseInt(req.params.projectId);
    const { documentId } = req.params;
    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await ensureProjectAccess(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const doc = await prisma.projectDocument.findFirst({
      where: { id: documentId, projectId },
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const url = await storageService.getDownloadUrl(doc.storageKey, 60 * 10);
    res.json({ url, name: doc.name, originalFilename: doc.originalFilename });
  } catch (error) {
    logger.error('Error generating document download URL:', error);
    res.status(500).json({ error: 'Failed to get download URL' });
  }
});

// DELETE /api/documents/:projectId/:documentId
router.delete('/:projectId/:documentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const projectId = parseInt(req.params.projectId);
    const { documentId } = req.params;
    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await ensureProjectAccess(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const doc = await prisma.projectDocument.findFirst({
      where: { id: documentId, projectId },
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    try {
      await storageService.deleteFile(doc.storageKey);
    } catch (storageError) {
      logger.warn(`Failed to delete document from storage (key: ${doc.storageKey}):`, storageError);
    }

    await prisma.projectDocument.delete({ where: { id: documentId } });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

export default router;
