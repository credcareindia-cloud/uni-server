import { Router, Response } from 'express';
import type { UploadedFile } from 'express-fileupload';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { enqueueIfcConversion } from '../queue/index.js';
import { notificationService } from '../services/notificationService.js';
import {
  CATEGORY_MAP,
  createElementsAndPanelsFromMetadata,
  replaceCategoryModelVersion,
  deactivateCategoriesNotInPublish,
  type RemapSummary,
} from '../services/modelVersioning.js';
import { storageService } from '../config/storage.js';
import { emitModelUpdated } from '../services/websocket.js';

const router = Router();
router.use(authenticateToken);

interface RevitPublishJob {
  id: string;
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  totalFiles: number;
  completedFiles: number;
  existingProjectId?: number;
  projectId?: number;
  projectData?: { id: number; name: string };
  remapSummaries?: RemapSummary[];
  /** When true, deactivate categories not included in this upload (full replace). Default false for multi-discipline partial publishes. */
  pruneMissingCategories?: boolean;
  error?: string;
  createdAt: Date;
  projectBase: {
    name: string;
    description: string;
    status: string;
    createdBy: string;
    organizationId: string;
  };
  files: {
    id: string;
    fileName: string;
    category: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    processingId?: string;
    tempFragPath?: string;
    metadata?: any;
    colorMap?: any;
    bimsfMap?: any;
    finalFragName?: string;
    error?: string;
  }[];
  browserSnapshot?: any;
  /** Per-file Revit colour maps (same order as model files) — system LineColor etc. */
  colorMaps?: any[];
  /** Per-file BIMSF_Container maps (panel ids) for 3D tree multi-select. */
  bimsfMaps?: any[];
  drawingManifest?: Array<{
    key: string;
    revitElementId?: number;
    kind: string;
    name: string;
    sheetNumber?: string | null;
    viewType?: string | null;
    dxfFileName?: string | null;
    dwgFileName?: string | null;
  }>;
  drawingTempFiles?: Array<{
    field: string;
    fileName: string;
    tempPath: string;
    format: 'dxf' | 'dwg';
    index: number;
  }>;
}

const revitJobs = new Map<string, RevitPublishJob>();

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

function parseCategories(body: Record<string, unknown>, fileCount: number): string[] | null {
  const raw = body.categories;
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || parsed.length !== fileCount) return null;
    return parsed.map((c) => String(c).toLowerCase());
  } catch {
    return null;
  }
}

/**
 * POST /api/revit/publish
 * Multipart IFC upload from Revit plugin.
 * - No projectId: create new multi-file project
 * - With projectId: replace active model per category + GlobalId panel remap
 */
router.post(
  '/publish',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user?.organizationId) {
      throw createApiError('User not authenticated', 401);
    }

    const files = req.files as
      | { [fieldname: string]: UploadedFile | UploadedFile[] }
      | UploadedFile[]
      | undefined;
    if (!files) {
      throw createApiError('No files provided', 400);
    }

    const uploadedFiles: UploadedFile[] = [];
    if (Array.isArray(files)) {
      uploadedFiles.push(...files);
    } else {
      Object.values(files).forEach((fileField) => {
        if (Array.isArray(fileField)) uploadedFiles.push(...fileField);
        else uploadedFiles.push(fileField);
      });
    }

    if (uploadedFiles.length === 0) {
      throw createApiError('No valid files found', 400);
    }

    // Split model files (IFC/FRAG) from CAD drawings (DXF/DWG)
    const modelFiles: UploadedFile[] = [];
    const drawingUploads: UploadedFile[] = [];
    for (const f of uploadedFiles) {
      const n = (f.name || '').toLowerCase();
      if (n.endsWith('.ifc') || n.endsWith('.frag')) modelFiles.push(f);
      else if (n.endsWith('.dxf') || n.endsWith('.dwg')) drawingUploads.push(f);
      else {
        // Ignore unknown extras (e.g. snapshot json file if sent as file)
        const field = (f as any).fieldname || '';
        if (String(field).startsWith('drawing')) {
          throw createApiError(`Invalid drawing type: ${f.name}`, 400);
        }
      }
    }

    if (modelFiles.length === 0) {
      throw createApiError('No IFC/FRAG model files provided', 400);
    }

    const body = req.body || {};
    const projectIdRaw = body.projectId ? parseInt(String(body.projectId), 10) : undefined;
    const projectName =
      (body.projectName && String(body.projectName).trim()) ||
      `Revit Publish ${new Date().toISOString().slice(0, 10)}`;
    const projectDescription = body.projectDescription
      ? String(body.projectDescription)
      : 'Published from Revit';

    let browserSnapshot: any = undefined;
    if (body.browserSnapshot) {
      try {
        browserSnapshot =
          typeof body.browserSnapshot === 'string'
            ? JSON.parse(body.browserSnapshot)
            : body.browserSnapshot;
      } catch {
        logger.warn('Invalid browserSnapshot JSON on revit publish');
      }
    }

    let drawingManifest: RevitPublishJob['drawingManifest'] = [];
    if (body.drawingManifest) {
      try {
        const parsed =
          typeof body.drawingManifest === 'string'
            ? JSON.parse(body.drawingManifest)
            : body.drawingManifest;
        if (Array.isArray(parsed)) drawingManifest = parsed;
      } catch {
        logger.warn('Invalid drawingManifest JSON on revit publish');
      }
    }

    let colorMaps: any[] = [];
    if (body.colorMaps) {
      try {
        const raw = body.colorMaps;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) colorMaps = parsed;
        else if (parsed && typeof parsed === 'object') colorMaps = [parsed];
        logger.info(
          `Revit publish colorMaps: ${colorMaps.length} map(s), fieldChars=${
            typeof raw === 'string' ? raw.length : 'object'
          }`
        );
      } catch (err) {
        const raw = body.colorMaps;
        logger.warn(
          `Invalid colorMaps JSON on revit publish (chars=${
            typeof raw === 'string' ? raw.length : typeof raw
          }): ${err instanceof Error ? err.message : err}`
        );
      }
    }

    let bimsfMaps: any[] = [];
    if (body.bimsfMaps) {
      try {
        const raw = body.bimsfMaps;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) bimsfMaps = parsed;
        else if (parsed && typeof parsed === 'object') bimsfMaps = [parsed];
        logger.info(
          `Revit publish bimsfMaps: ${bimsfMaps.length} map(s), fieldChars=${
            typeof raw === 'string' ? raw.length : 'object'
          }, panels=${bimsfMaps.reduce((n, m) => n + (m?.panelCount || m?.panels?.length || 0), 0)}`
        );
      } catch (err) {
        const raw = body.bimsfMaps;
        logger.warn(
          `Invalid bimsfMaps JSON on revit publish (chars=${
            typeof raw === 'string' ? raw.length : typeof raw
          }): ${err instanceof Error ? err.message : err}`
        );
      }
    } else {
      logger.warn('Revit publish: no bimsfMaps field on request');
    }

    const categoriesFromBody = parseCategories(body, modelFiles.length);

    let resolvedProjectId: number | undefined = projectIdRaw;
    let staleProjectCleared = false;

    if (projectIdRaw) {
      const existing = await prisma.project.findFirst({
        where: {
          id: projectIdRaw,
          organizationId: req.user.organizationId,
        },
        select: { id: true, name: true },
      });
      if (!existing) {
        logger.warn(
          `Revit publish: projectId ${projectIdRaw} not found; creating a new project instead`
        );
        resolvedProjectId = undefined;
        staleProjectCleared = true;
      }
    }

    const jobId = `revit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // Persist drawing uploads to temp paths for finalize
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = process.env.FILE_UPLOAD_TMP_DIR || os.tmpdir();
    const drawingTempFiles: NonNullable<RevitPublishJob['drawingTempFiles']> = [];

    // Prefer fieldname index mapping (drawingDxf0 / drawingDwg0)
    const filesMap = (!Array.isArray(files) && files) ? files as Record<string, UploadedFile | UploadedFile[]> : null;
    if (filesMap) {
      for (const [field, fileField] of Object.entries(filesMap)) {
        const match = /^(drawingDxf|drawingDwg)(\d+)$/i.exec(field);
        if (!match) continue;
        const format = match[1].toLowerCase().includes('dxf') ? 'dxf' : 'dwg';
        const index = parseInt(match[2], 10);
        const list = Array.isArray(fileField) ? fileField : [fileField];
        for (const uploadedFile of list) {
          let tempFilePath = uploadedFile.tempFilePath as string | undefined;
          if (!tempFilePath) {
            const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            tempFilePath = path.join(tmpDir, `revit_draw_${unique}_${uploadedFile.name}`);
            await fs.promises.writeFile(tempFilePath, uploadedFile.data);
          }
          drawingTempFiles.push({
            field,
            fileName: uploadedFile.name,
            tempPath: tempFilePath,
            format,
            index,
          });
        }
      }
    } else {
      // Fallback: match by extension order
      let dxfI = 0;
      let dwgI = 0;
      for (const uploadedFile of drawingUploads) {
        const n = uploadedFile.name.toLowerCase();
        const format = n.endsWith('.dxf') ? 'dxf' : 'dwg';
        const index = format === 'dxf' ? dxfI++ : dwgI++;
        let tempFilePath = uploadedFile.tempFilePath as string | undefined;
        if (!tempFilePath) {
          const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
          tempFilePath = path.join(tmpDir, `revit_draw_${unique}_${uploadedFile.name}`);
          await fs.promises.writeFile(tempFilePath, uploadedFile.data);
        }
        drawingTempFiles.push({
          field: `drawing${format}${index}`,
          fileName: uploadedFile.name,
          tempPath: tempFilePath,
          format,
          index,
        });
      }
    }

    const pruneMissingCategories =
      String(body.pruneMissingCategories || '').toLowerCase() === 'true' ||
      body.pruneMissingCategories === true ||
      body.pruneMissingCategories === '1';

    const job: RevitPublishJob = {
      id: jobId,
      status: 'processing',
      progress: 5,
      message: staleProjectCleared
        ? 'Bound project was deleted — creating a new Uniqube project...'
        : 'Starting Revit publish...',
      totalFiles: modelFiles.length,
      completedFiles: 0,
      existingProjectId: resolvedProjectId,
      pruneMissingCategories,
      createdAt: new Date(),
      projectBase: {
        name: projectName,
        description: projectDescription,
        status: 'ACTIVE',
        createdBy: req.user.id,
        organizationId: req.user.organizationId,
      },
      files: [],
      browserSnapshot,
      colorMaps,
      bimsfMaps,
      drawingManifest,
      drawingTempFiles,
    };

    for (let i = 0; i < modelFiles.length; i++) {
      const uploadedFile = modelFiles[i];
      const fileName = uploadedFile.name.toLowerCase();

      let tempFilePath = uploadedFile.tempFilePath as string | undefined;
      if (!tempFilePath) {
        const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        tempFilePath = path.join(tmpDir, `revit_${unique}_${uploadedFile.name}`);
        await fs.promises.writeFile(tempFilePath, uploadedFile.data);
      }

      const category =
        (categoriesFromBody && categoriesFromBody[i]) || detectFileCategory(uploadedFile.name);
      const isIfc = fileName.endsWith('.ifc');
      const baseName = uploadedFile.name.replace(/\.(ifc|frag)$/i, '');
      const finalFragName = isIfc ? `${baseName}.frag` : uploadedFile.name;
      const processingId = `revit_proc_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;

      job.files.push({
        id: `file_${i}`,
        fileName: uploadedFile.name,
        category,
        status: 'processing',
        progress: 10,
        processingId,
        finalFragName,
        colorMap: colorMaps[i] || null,
        bimsfMap: bimsfMaps[i] || null,
      });

      enqueueIfcConversion({
        processingId,
        tempFilePath,
        originalFilename: uploadedFile.name,
        finalFragName,
        uploadedByUserId: req.user.id,
        projectData: {
          name: projectName,
          description: projectDescription,
          status: 'ACTIVE',
        },
        isMultiFile: true,
        multiFileJobId: jobId,
        fileIndex: i,
        category,
      });
    }

    revitJobs.set(jobId, job);

    logger.info(
      `Revit publish job ${jobId} started (${modelFiles.length} models, ${drawingTempFiles.length} drawings, projectId=${resolvedProjectId || 'new'}${staleProjectCleared ? ', stale binding ignored' : ''})`
    );

    res.status(202).json({
      success: true,
      jobId,
      status: 'processing',
      message: staleProjectCleared
        ? `Bound project was deleted — creating a new project from ${modelFiles.length} file(s)`
        : `Publish started for ${modelFiles.length} file(s)`,
      existingProjectId: resolvedProjectId || null,
      staleProjectCleared,
      drawingsQueued: drawingTempFiles.length,
      hasBrowserSnapshot: !!browserSnapshot,
    });
  })
);

/**
 * GET /api/revit/publish-status/:jobId
 */
router.get(
  '/publish-status/:jobId',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('User not authenticated', 401);
    const job = revitJobs.get(req.params.jobId);
    if (!job) throw createApiError('Publish job not found', 404);

    res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      projectId: job.projectId || job.existingProjectId || null,
      projectData: job.projectData,
      remapSummaries: job.remapSummaries || [],
      error: job.error,
      totalFiles: job.totalFiles,
      completedFiles: job.completedFiles,
      files: job.files,
    });
  })
);

/**
 * Called from queue when a revit publish file finishes (same multi_status_update channel).
 * We register a parallel handler by intercepting via updateRevitPublishStatus export.
 */
export function updateRevitPublishStatus(
  jobId: string,
  fileIndex: number,
  status: 'processing' | 'completed' | 'failed',
  progress: number,
  message: string,
  modelData?: any,
  error?: string
) {
  const job = revitJobs.get(jobId);
  if (!job || !job.files[fileIndex]) {
    return false; // not a revit job
  }

  job.files[fileIndex].status = status;
  job.files[fileIndex].progress = progress;
  if (modelData) {
    if (modelData.tempFragPath) job.files[fileIndex].tempFragPath = modelData.tempFragPath;
    if (modelData.metadata) job.files[fileIndex].metadata = modelData.metadata;
    if (modelData.finalFragName) job.files[fileIndex].finalFragName = modelData.finalFragName;
  }
  if (error) job.files[fileIndex].error = error;

  const completedFiles = job.files.filter((f) => f.status === 'completed').length;
  const failedFiles = job.files.filter((f) => f.status === 'failed').length;
  job.completedFiles = completedFiles;

  if (completedFiles === job.totalFiles) {
    job.progress = 90;
    job.message = 'Finalizing publish...';
    revitJobs.set(jobId, job);
    void finalizeRevitPublish(jobId);
  } else if (failedFiles > 0 && completedFiles + failedFiles === job.totalFiles) {
    job.status = 'failed';
    job.progress = Math.round((completedFiles / job.totalFiles) * 100);
    job.message = `${failedFiles} of ${job.totalFiles} files failed`;
    job.error = job.files.map((f) => f.error).filter(Boolean).join('; ');
    revitJobs.set(jobId, job);
  } else {
    let totalProgress = completedFiles * 100;
    job.files.forEach((f) => {
      if (f.status === 'processing') totalProgress += f.progress || 0;
    });
    job.progress = Math.min(89, Math.round(totalProgress / job.totalFiles));
    job.message = `Processing ${job.totalFiles - completedFiles} file(s)...`;
    revitJobs.set(jobId, job);
  }

  return true;
}

async function finalizeRevitPublish(jobId: string) {
  const job = revitJobs.get(jobId);
  if (!job) return;

  try {
    let projectId = job.existingProjectId;
    let projectName = job.projectBase.name;

    if (!projectId) {
      const project = await prisma.$transaction(async (tx) => {
        const maxProjectInOrg = await tx.project.findFirst({
          where: { organizationId: job.projectBase.organizationId },
          orderBy: { displayNumber: 'desc' },
          select: { displayNumber: true },
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
              createdFromRevitPublish: true,
              totalFiles: job.totalFiles,
              categories: job.files.map((f) => f.category),
            },
            createdBy: job.projectBase.createdBy,
          },
        });
      });

      await prisma.projectMember.create({
        data: {
          projectId: project.id,
          userId: job.projectBase.createdBy,
          role: 'OWNER',
        },
      });

      projectId = project.id;
      projectName = project.name;

      // First publish: create models like multi-file
      const createdModelIds: string[] = [];
      for (const f of job.files) {
        const categoryEnum = CATEGORY_MAP[f.category] || 'OTHER';
        const finalName = f.finalFragName || f.fileName.replace(/\.[^/.]+$/, '.frag');
        if (!f.tempFragPath) throw new Error(`Missing FRAG for ${f.fileName}`);

        const model = await prisma.model.create({
          data: {
            projectId,
            type: 'FRAG',
            originalFilename: finalName,
            storageKey: 'temp_key',
            sizeBytes: BigInt(0),
            status: 'READY',
            processingProgress: 100,
            version: 1,
            isActive: true,
            category: categoryEnum,
            displayName: f.category.charAt(0).toUpperCase() + f.category.slice(1),
            isMultiFile: true,
            multiFileJobId: jobId,
          },
        });

        const fs = await import('fs');
        const fragBuffer = await fs.promises.readFile(f.tempFragPath);
        const finalStorageKey = storageService.generateStorageKey(String(projectId), model.id, finalName);
        await storageService.uploadFile(finalStorageKey, fragBuffer, 'application/octet-stream');
        await prisma.model.update({
          where: { id: model.id },
          data: { storageKey: finalStorageKey, sizeBytes: BigInt(fragBuffer.length) },
        });

        const created = await createElementsAndPanelsFromMetadata({
          projectId,
          modelId: model.id,
          metadata: f.metadata,
          colorMap: f.colorMap || null,
          bimsfMap: f.bimsfMap || null,
        });
        const spatialPayload: Record<string, unknown> = {};
        if (f.colorMap) spatialPayload.colorMap = f.colorMap;
        if (f.bimsfMap) spatialPayload.bimsfMap = f.bimsfMap;
        await prisma.model.update({
          where: { id: model.id },
          data: {
            elementCount: created.elementCount,
            spatialStructure:
              Object.keys(spatialPayload).length > 0 ? (spatialPayload as any) : undefined,
          },
        });

        try {
          await fs.promises.unlink(f.tempFragPath);
        } catch {
          /* ignore */
        }
        createdModelIds.push(model.id);
      }

      const structure = await prisma.model.findFirst({
        where: { projectId, category: 'STRUCTURE', isActive: true },
        select: { id: true },
      });
      await prisma.project.update({
        where: { id: projectId },
        data: { currentModelId: structure?.id || createdModelIds[0] },
      });

      job.remapSummaries = createdModelIds.map((id) => ({
        remapped: 0,
        orphaned: 0,
        created: 0,
        modelId: id,
        category: 'NEW',
        version: 1,
      }));

      await notificationService.projectNotifications.createdSuccess(
        job.projectBase.organizationId,
        projectName,
        projectId,
        createdModelIds.length
      );
    } else {
      // Republish: version replace only for uploaded categories.
      // Other disciplines (Structure / MEP / Architecture) keep their latest active model —
      // they are published from separate Revit files / machines.
      const summaries: RemapSummary[] = [];

      for (const f of job.files) {
        if (!f.tempFragPath) throw new Error(`Missing FRAG for ${f.fileName}`);
        const categoryEnum = CATEGORY_MAP[f.category] || 'OTHER';
        const summary = await replaceCategoryModelVersion({
          projectId,
          category: categoryEnum,
          displayName: f.category.charAt(0).toUpperCase() + f.category.slice(1),
          finalFragName: f.finalFragName || f.fileName.replace(/\.[^/.]+$/, '.frag'),
          tempFragPath: f.tempFragPath,
          metadata: f.metadata,
          notifyUserId: job.projectBase.createdBy,
          publishBatchId: jobId,
          colorMap: f.colorMap || null,
          bimsfMap: f.bimsfMap || null,
        });
        summaries.push(summary);
      }

      // Optional full sync only when client asks to prune missing trades
      if (job.pruneMissingCategories) {
        const keepCategories = job.files.map(
          (f) => CATEGORY_MAP[f.category] || 'OTHER'
        ) as Array<'STRUCTURE' | 'MEP' | 'ELECTRICAL' | 'ARCHITECTURE' | 'OTHER'>;
        const pruned = await deactivateCategoriesNotInPublish({
          projectId,
          keepCategories,
        });
        if (pruned.deactivated.length) {
          logger.info(
            `Publish ${jobId}: pruned ${pruned.deactivated.length} model(s), orphaned ${pruned.orphanedPanels} panel(s)`
          );
        }
      }

      job.remapSummaries = summaries;

      try {
        emitModelUpdated(job.projectBase.createdBy, {
          projectId,
          republish: true,
          summaries,
        });
      } catch {
        /* ignore */
      }
    }

    job.projectId = projectId;
    job.projectData = { id: projectId, name: projectName };

    // Persist Project Browser snapshot + CAD drawings for this revision
    await persistBrowserAndDrawings(job, projectId);

    job.status = 'completed';
    job.progress = 100;
    job.message = job.existingProjectId
      ? `Republished project ${projectId}`
      : `Created project ${projectId}`;
    revitJobs.set(jobId, job);
    logger.info(`Revit publish job ${jobId} completed → project ${projectId}`);
  } catch (e: any) {
    job.status = 'failed';
    job.message = 'Failed to finalize Revit publish';
    job.error = e?.message || 'Unknown error';
    revitJobs.set(jobId, job);
    logger.error(`Revit publish finalize failed for ${jobId}:`, e);
  }
}

async function persistBrowserAndDrawings(job: RevitPublishJob, projectId: number) {
  const fs = await import('fs');

  if (job.browserSnapshot) {
    try {
      await prisma.projectBrowserRevision.upsert({
        where: { publishJobId: job.id },
        create: {
          projectId,
          publishJobId: job.id,
          snapshot: job.browserSnapshot,
        },
        update: {
          snapshot: job.browserSnapshot,
        },
      });
      logger.info(`Stored browser snapshot for publish ${job.id}`);
    } catch (e) {
      logger.error(`Failed to store browser snapshot for ${job.id}:`, e);
    }
  }

  const manifest = job.drawingManifest || [];
  const temps = job.drawingTempFiles || [];
  if (manifest.length === 0 && temps.length === 0) return;

  // Index temp files by manifest index + format
  const byIndexFormat = new Map<string, (typeof temps)[0]>();
  for (const t of temps) {
    byIndexFormat.set(`${t.index}:${t.format}`, t);
  }
  // Also index by filename for fallback
  const byFileName = new Map<string, (typeof temps)[0]>();
  for (const t of temps) {
    byFileName.set(t.fileName.toLowerCase(), t);
  }

  for (let i = 0; i < manifest.length; i++) {
    const m = manifest[i];
    const kind = (String(m.kind || 'VIEW').toUpperCase() === 'SHEET' ? 'SHEET' : 'VIEW') as
      | 'VIEW'
      | 'SHEET';

    let dxfTemp = byIndexFormat.get(`${i}:dxf`);
    let dwgTemp = byIndexFormat.get(`${i}:dwg`);
    if (!dxfTemp && m.dxfFileName) dxfTemp = byFileName.get(m.dxfFileName.toLowerCase());
    if (!dwgTemp && m.dwgFileName) dwgTemp = byFileName.get(m.dwgFileName.toLowerCase());

    let dxfStorageKey: string | null = null;
    let dwgStorageKey: string | null = null;
    let sizeBytes = BigInt(0);

    try {
      if (dxfTemp?.tempPath) {
        const buf = await fs.promises.readFile(dxfTemp.tempPath);
        dxfStorageKey = `projects/${projectId}/revisions/${job.id}/drawings/${m.key}.dxf`;
        await storageService.uploadFile(dxfStorageKey, buf, 'application/dxf');
        sizeBytes += BigInt(buf.length);
        try {
          await fs.promises.unlink(dxfTemp.tempPath);
        } catch {
          /* ignore */
        }
      }
      if (dwgTemp?.tempPath) {
        const buf = await fs.promises.readFile(dwgTemp.tempPath);
        dwgStorageKey = `projects/${projectId}/revisions/${job.id}/drawings/${m.key}.dwg`;
        await storageService.uploadFile(dwgStorageKey, buf, 'application/acad');
        sizeBytes += BigInt(buf.length);
        try {
          await fs.promises.unlink(dwgTemp.tempPath);
        } catch {
          /* ignore */
        }
      }

      if (!dxfStorageKey && !dwgStorageKey) continue;

      await prisma.projectDrawing.upsert({
        where: {
          publishJobId_stableKey: {
            publishJobId: job.id,
            stableKey: m.key,
          },
        },
        create: {
          projectId,
          publishJobId: job.id,
          stableKey: m.key,
          kind,
          name: m.name || m.key,
          sheetNumber: m.sheetNumber || null,
          viewType: m.viewType || null,
          revitElementId: m.revitElementId ?? null,
          dxfStorageKey,
          dwgStorageKey,
          sizeBytes,
        },
        update: {
          name: m.name || m.key,
          sheetNumber: m.sheetNumber || null,
          viewType: m.viewType || null,
          revitElementId: m.revitElementId ?? null,
          dxfStorageKey,
          dwgStorageKey,
          sizeBytes,
        },
      });
    } catch (e) {
      logger.error(`Failed to store drawing ${m.key} for ${job.id}:`, e);
    }
  }

  // Cleanup any leftover temp drawing files
  for (const t of temps) {
    try {
      await fs.promises.unlink(t.tempPath);
    } catch {
      /* ignore */
    }
  }

  logger.info(`Stored drawings for publish ${job.id} (manifest=${manifest.length})`);
}

export { router as revitPublishRouter, revitJobs };
