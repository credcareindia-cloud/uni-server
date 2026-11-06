import { Router, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import fileUpload from 'express-fileupload';
import { prisma } from '../config/database.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { resolvePermissions } from '../auth/permissions.js';
import { logger } from '../utils/logger.js';

const router = Router();
const uploadRoot = path.join(process.cwd(), 'data', 'quote-files');

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

async function saveFile(id: string, kind: 'drawing' | 'model', file: Uploaded) {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  const key = path.join(id, `${kind}-${safe}`);
  const dest = path.join(uploadRoot, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (file.tempFilePath) await fs.copyFile(file.tempFilePath, dest);
  else await fs.writeFile(dest, file.data);
  return { key, name: file.name };
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

router.post('/', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const fields = readFields(req.body || {});
  const drawing = one(req.files?.drawing as Uploaded | Uploaded[] | undefined);
  const model = one(req.files?.model as Uploaded | Uploaded[] | undefined);
  if (!drawing) throw createApiError('Upload a drawing', 400);
  if (!DRAWING_EXT.has(extOf(drawing.name))) throw createApiError('Drawing must be a PDF, image, DWG, or DXF', 400);
  if (model && !MODEL_EXT.has(extOf(model.name))) throw createApiError('The 3D model must be an IFC file', 400);
  if (!fields.note) throw createApiError('Add a note with the drawing', 400);

  const organizations = await prisma.organization.findMany({
    include: { _count: { select: { users: true } } },
  });
  const organization = organizations
    .filter((item) => item._count.users > 0)
    .sort((a, b) => b._count.users - a._count.users)[0];
  if (!organization) throw createApiError('No workspace is ready to receive quotes yet', 503);

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

  const drawingSaved = await saveFile(created.id, 'drawing', drawing);
  const modelSaved = model ? await saveFile(created.id, 'model', model) : null;
  const quote = await prisma.quoteRequest.update({
    where: { id: created.id },
    data: {
      drawingKey: drawingSaved.key,
      drawingName: drawingSaved.name,
      modelKey: modelSaved?.key,
      modelName: modelSaved?.name,
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
  const drawingSaved = drawing ? await saveFile(created.id, 'drawing', drawing) : null;
  const modelSaved = model ? await saveFile(created.id, 'model', model) : null;
  const quote = await prisma.quoteRequest.update({
    where: { id: created.id },
    data: {
      drawingKey: drawingSaved?.key,
      drawingName: drawingSaved?.name,
      modelKey: modelSaved?.key,
      modelName: modelSaved?.name,
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
  if (!key || !name) throw createApiError('That file was not uploaded', 404);

  const filePath = path.join(uploadRoot, key);
  await fs.access(filePath);
  res.download(filePath, name);
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
  await prisma.$executeRaw`DELETE FROM estimation.projects WHERE id = ${`p${projectId}`}`;
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
  await fs.rm(path.join(uploadRoot, quote.id), { recursive: true, force: true });
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

  logger.info(`Quote ${quote.id} started as project ${result.projectId}`);
  res.status(201).json(result);
}));

export default router;
