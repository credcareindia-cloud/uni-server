import { Router, Response } from 'express';
import fileUpload from 'express-fileupload';
import { prisma } from '../config/database.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { resolvePermissions } from '../auth/permissions.js';
import { logger } from '../utils/logger.js';
import {
  attachQuoteFiles,
  createQuoteUploadUrl,
  purgeQuoteStorage,
  promoteQuoteDrawingToProject,
  streamQuoteAttachment,
} from '../services/quoteFiles.js';

const router = Router();

const DRAWING_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'dwg', 'dxf']);
const MODEL_EXT = new Set(['ifc']);

type Uploaded = fileUpload.UploadedFile;

function one(file: Uploaded | Uploaded[] | undefined) {
  if (!file) return undefined;
  return Array.isArray(file) ? file[0] : file;
}

function extOf(name: string) {
  return name.split('.').pop()?.toLowerCase() || '';
}

function readFields(body: Record<string, unknown>) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const projectName = String(body.projectName || '').trim();
  const note = String(body.note || '').trim();
  if (name.length < 2) throw createApiError('Name is required', 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createApiError('A valid email is required', 400);
  if (projectName.length < 2) throw createApiError('Project name is required', 400);
  return { name, email, projectName, note };
}

async function receivingOrganization() {
  const organizations = await prisma.organization.findMany({
    include: { _count: { select: { users: true } } },
  });
  const organization = organizations
    .filter((item) => item._count.users > 0)
    .sort((a, b) => b._count.users - a._count.users)[0];
  if (!organization) throw createApiError('No workspace is ready to receive quotes yet', 503);
  return organization;
}

async function staffUser(req: AuthenticatedRequest) {
  if (!req.user) throw createApiError('User not authenticated', 401);
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, role: true, permissions: true, organizationId: true },
  });
  if (!user) throw createApiError('User not found', 401);
  const permissions = resolvePermissions(user.role, user.permissions);
  return { ...user, permissions };
}

function toJson(row: {
  id: string;
  name: string;
  email: string;
  projectName: string;
  note: string;
  drawingName: string | null;
  modelName: string | null;
  source: string;
  status: string;
  projectId: number | null;
  estimateId: string | null;
  createdAt: Date;
  project?: { id: number; name: string; displayNumber: number } | null;
}) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    projectName: row.projectName,
    note: row.note,
    drawingName: row.drawingName,
    modelName: row.modelName,
    hasDrawing: Boolean(row.drawingName),
    hasModel: Boolean(row.modelName),
    source: row.source,
    status: row.status,
    projectId: row.projectId,
    estimateId: row.estimateId,
    project: row.project ?? null,
    createdAt: row.createdAt,
  };
}

/** Browser asks for a short-lived PUT URL, uploads straight to S3/MinIO, then POSTs the key with the quote. */
router.post('/presign', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const filename = String(body.filename || '').trim();
  const contentType = String(body.contentType || '').trim();
  const sizeBytes = Number(body.sizeBytes);
  const kind = body.kind === 'model' ? 'model' as const : 'drawing' as const;
  if (!filename) throw createApiError('Filename is required', 400);

  const organization = await receivingOrganization();
  const upload = await createQuoteUploadUrl({
    organizationId: organization.id,
    kind,
    filename,
    contentType,
    sizeBytes,
  });
  res.json(upload);
}));

router.post('/', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const fields = readFields(req.body || {});
  const drawing = one(req.files?.drawing as Uploaded | Uploaded[] | undefined);
  const model = one(req.files?.model as Uploaded | Uploaded[] | undefined);
  const drawingKey = String(req.body?.drawingKey || '').trim() || undefined;
  const drawingName = String(req.body?.drawingName || '').trim() || undefined;
  const modelKey = String(req.body?.modelKey || '').trim() || undefined;
  const modelName = String(req.body?.modelName || '').trim() || undefined;
  // The drawing is optional: the marketing site sends template quotes, contact messages and
  // newsletter sign-ups here too, and those describe the request in the note instead.
  if (drawing && !DRAWING_EXT.has(extOf(drawing.name))) throw createApiError('Drawing must be a PDF, image, DWG, or DXF', 400);
  if (model && !MODEL_EXT.has(extOf(model.name))) throw createApiError('The 3D model must be an IFC file', 400);
  if (!fields.note) throw createApiError('Add a note describing the request', 400);

  const organization = await receivingOrganization();

  const created = await prisma.quoteRequest.create({
    data: {
      organizationId: organization.id,
      name: fields.name,
      email: fields.email,
      projectName: fields.projectName,
      note: fields.note,
      source: 'WEB',
    },
  });

  const files = await attachQuoteFiles({
    organizationId: organization.id,
    quoteId: created.id,
    drawing,
    model,
    drawingKey,
    drawingName,
    modelKey,
    modelName,
  });

  const quote = await prisma.quoteRequest.update({
    where: { id: created.id },
    data: {
      drawingKey: files.drawingKey,
      drawingName: files.drawingName,
      modelKey: files.modelKey,
      modelName: files.modelName,
    },
  });

  logger.info(`Quote received: ${quote.projectName} from ${quote.email}`);
  res.status(201).json({ id: quote.id, message: 'Quote request received' });
}));

router.use(authenticateToken);

router.get('/', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const user = await staffUser(req);
  if (!user.permissions.includes('estimate.view')) throw createApiError('Estimate access required', 403);

  const rows = await prisma.quoteRequest.findMany({
    where: { organizationId: user.organizationId },
    include: { project: { select: { id: true, name: true, displayNumber: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows.map(toJson));
}));

router.post('/manual', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const user = await staffUser(req);
  if (!user.permissions.includes('estimate.edit')) throw createApiError('Estimate access required', 403);
  const fields = readFields(req.body || {});
  const drawing = one(req.files?.drawing as Uploaded | Uploaded[] | undefined);
  const model = one(req.files?.model as Uploaded | Uploaded[] | undefined);
  if (drawing && !DRAWING_EXT.has(extOf(drawing.name))) throw createApiError('Drawing must be a PDF, image, DWG, or DXF', 400);
  if (model && !MODEL_EXT.has(extOf(model.name))) throw createApiError('The 3D model must be an IFC file', 400);

  const created = await prisma.quoteRequest.create({
    data: {
      organizationId: user.organizationId,
      name: fields.name,
      email: fields.email,
      projectName: fields.projectName,
      note: fields.note,
      source: 'MANUAL',
      createdById: user.id,
    },
  });

  const files = await attachQuoteFiles({
    organizationId: user.organizationId,
    quoteId: created.id,
    drawing,
    model,
  });

  const quote = await prisma.quoteRequest.update({
    where: { id: created.id },
    data: {
      drawingKey: files.drawingKey,
      drawingName: files.drawingName,
      modelKey: files.modelKey,
      modelName: files.modelName,
    },
    include: { project: { select: { id: true, name: true, displayNumber: true } } },
  });
  res.status(201).json(toJson(quote));
}));

router.get('/:id/files/:kind', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const user = await staffUser(req);
  if (!user.permissions.includes('estimate.view')) throw createApiError('Estimate access required', 403);
  const kind = req.params.kind;
  if (kind !== 'drawing' && kind !== 'model') throw createApiError('Unknown file', 404);

  const quote = await prisma.quoteRequest.findFirst({
    where: { id: req.params.id, organizationId: user.organizationId },
  });
  if (!quote) throw createApiError('Request not found', 404);

  const key = kind === 'drawing' ? quote.drawingKey : quote.modelKey;
  const name = kind === 'drawing' ? quote.drawingName : quote.modelName;
  await streamQuoteAttachment(res, key, name);
}));

async function deleteStartedWork(organizationId: string, projectId: number | null, estimateId: string | null) {
  if (!projectId && !estimateId) return;

  await prisma.estimate.deleteMany({
    where: {
      organizationId,
      OR: [
        ...(projectId ? [{ projectId }] : []),
        ...(estimateId ? [{ id: estimateId }] : []),
      ],
    },
  });

  if (!projectId) return;
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId },
    select: { id: true },
  });
  if (!project) return;

  await prisma.project.update({
    where: { id: projectId },
    data: { currentModelId: null },
  }).catch(() => undefined);
  await prisma.qRCode.deleteMany({ where: { projectId } }).catch(() => undefined);
  await prisma.project.delete({ where: { id: projectId } });
  // Estimation studio tables are created lazily; ignore if the schema is not there yet.
  await prisma.$executeRaw`DELETE FROM estimation.projects WHERE id = ${`p${projectId}`}`.catch(() => undefined);
}

router.delete('/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const user = await staffUser(req);
  if (!user.permissions.includes('admin')) throw createApiError('Admin access required', 403);

  const quote = await prisma.quoteRequest.findFirst({
    where: { id: req.params.id, organizationId: user.organizationId },
  });
  if (!quote) throw createApiError('Request not found', 404);

  await deleteStartedWork(user.organizationId, quote.projectId, quote.estimateId);
  await prisma.quoteRequest.delete({ where: { id: quote.id } });
  await purgeQuoteStorage(user.organizationId, quote.id, {
    drawingKey: quote.drawingKey,
    modelKey: quote.modelKey,
  }).catch((error) => {
    logger.warn(`Quote ${quote.id} DB row deleted but S3 purge failed`, error);
  });
  logger.info(`Quote ${quote.id} deleted by ${user.id}`);
  res.status(204).end();
}));

router.post('/:id/start', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const user = await staffUser(req);
  if (!user.permissions.includes('estimate.edit')) throw createApiError('Estimate access required', 403);

  const quote = await prisma.quoteRequest.findFirst({
    where: { id: req.params.id, organizationId: user.organizationId },
  });
  if (!quote) throw createApiError('Request not found', 404);
  if (quote.projectId) {
    res.json({ projectId: quote.projectId, estimateId: quote.estimateId, alreadyStarted: true });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const [highest, takenJobs] = await Promise.all([
      tx.project.findFirst({
        where: { organizationId: user.organizationId },
        orderBy: { displayNumber: 'desc' },
        select: { displayNumber: true },
      }),
      tx.estimate.findMany({
        where: { organizationId: user.organizationId, revision: 'R0' },
        select: { jobNumber: true },
      }),
    ]);
    const taken = new Set(takenJobs.map((row) => row.jobNumber));
    let displayNumber = (highest?.displayNumber || 0) + 1;
    while (taken.has(String(displayNumber))) displayNumber += 1;

    const project = await tx.project.create({
      data: {
        name: quote.projectName,
        description: quote.note || null,
        status: 'PLANNING',
        stage: 'TENDER',
        buildSystem: 'LGS',
        organizationId: user.organizationId,
        displayNumber,
        createdBy: user.id,
        metadata: {
          createdAsTender: true,
          client: quote.name,
          clientEmail: quote.email,
          quoteRequestId: quote.id,
          note: quote.note,
          drawingName: quote.drawingName,
          modelName: quote.modelName,
        },
      },
    });
    await tx.projectMember.create({
      data: { projectId: project.id, userId: user.id, role: 'OWNER' },
    });
    const estimate = await tx.estimate.create({
      data: {
        organizationId: user.organizationId,
        projectId: project.id,
        createdBy: user.id,
        jobNumber: String(project.displayNumber),
        revision: 'R0',
        name: quote.projectName,
        client: quote.name,
        notes: quote.note || null,
        sourceFile: quote.drawingName || quote.modelName,
      },
    });
    await tx.quoteRequest.update({
      where: { id: quote.id },
      data: { status: 'STARTED', projectId: project.id, estimateId: estimate.id },
    });
    return { projectId: project.id, estimateId: estimate.id, displayNumber: project.displayNumber };
  });

  await promoteQuoteDrawingToProject({
    organizationId: user.organizationId,
    quoteId: quote.id,
    projectId: result.projectId,
    drawingKey: quote.drawingKey,
    drawingName: quote.drawingName,
    uploadedBy: user.id,
  });

  logger.info(`Quote ${quote.id} started as project ${result.projectId}`);
  res.status(201).json(result);
}));

export default router;
