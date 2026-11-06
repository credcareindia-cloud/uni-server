import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { asyncHandler, createApiError } from '../middleware/errorHandler.js';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { priceEstimate } from '../services/estimating.js';
import { buildEstimateWorkbook } from '../services/estimateWorkbook.js';
import { generateEstimateLines } from '../services/estimateGenerate.js';
import { extractPdfExcerpts, loadHistoricalRates } from '../services/estimateInputs.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.use(authenticateToken);

const marginFields = {
  overheadPct: z.number().min(0).max(1).optional(),
  marginPct: z.number().min(0).max(0.95).optional(),
  financingPct: z.number().min(0).max(1).optional(),
  contingencyPct: z.number().min(0).max(1).optional(),
  customsPct: z.number().min(0).max(1).optional(),
  corporateTaxPct: z.number().min(0).max(1).optional(),
  designPct: z.number().min(0).max(1).optional(),
  commissionPct: z.number().min(0).max(1).optional(),
};

const updateEstimateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  client: z.string().optional(),
  location: z.string().optional(),
  consultant: z.string().optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'WON', 'LOST', 'SUPERSEDED']).optional(),
  totalArea: z.number().positive().optional(),
  fxRate: z.number().positive().optional(),
  notes: z.string().optional(),
  projectId: z.number().int().nullable().optional(),
  ...marginFields,
});

const listQuerySchema = z.object({
  projectId: z.string().regex(/^\d+$/).transform(Number).optional(),
});

const createEstimateSchema = z.object({
  projectId: z.number().int(),
  revision: z.string().min(1).max(32),
  jobNumber: z.string().min(1).max(32).optional(),
  name: z.string().min(1).max(255).optional(),
  /** Clone this revision's lines and percentages, the usual way an R1 is raised. */
  copyFromId: z.string().optional(),
});

const updateLineSchema = z.object({
  qty: z.number().min(0).optional(),
  description: z.string().min(1).optional(),
  unit: z.string().nullable().optional(),
  materialCost: z.number().min(0).optional(),
  fabricationCost: z.number().min(0).optional(),
  installationCost: z.number().min(0).optional(),
  prelimsCost: z.number().min(0).optional(),
  shippingCost: z.number().min(0).optional(),
  packagingCost: z.number().min(0).optional(),
  loadingCost: z.number().min(0).optional(),
});

const createLineSchema = z.object({
  bill: z.string().min(1).max(120).default('General'),
  description: z.string().min(1).max(500),
  unit: z.string().max(32).nullable().optional(),
  qty: z.number().min(0).default(0),
  /** Unit direct cost; stored as material for now — enough to price a line. */
  unitCost: z.number().min(0).default(0),
  mode: z.enum(['FULL', 'PASS_THROUGH']).optional(),
});

/**
 * Loads an estimate and prices it. Pure: reads never write.
 *
 * Prices are always derived here rather than read from the stored columns, so a
 * response can never show a stale figure left behind by a partial write.
 */
async function loadAndPrice(estimateId: string) {
  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!estimate) return null;
  return { estimate, priced: priceEstimate(estimate, estimate.lines) };
}

/**
 * Writes the derived figures back after a change.
 *
 * The stored amounts exist only so the list view need not price every estimate; the
 * line costs and the revision's percentages remain the source of truth.
 */
async function persistTotals(result: NonNullable<Awaited<ReturnType<typeof loadAndPrice>>>) {
  const { estimate, priced } = result;
  const changed = priced.lines.filter((line, i) => {
    const stored = estimate.lines[i];
    return stored.sellRate !== line.sellRate || stored.totalAmount !== line.amount;
  });

  await prisma.$transaction([
    ...changed.map((line) =>
      prisma.estimateLine.update({
        where: { id: line.id },
        data: { sellRate: line.sellRate, totalAmount: line.amount },
      }),
    ),
    prisma.estimate.update({
      where: { id: estimate.id },
      data: { totalAmount: priced.total },
    }),
  ]);
}

function serialize(result: Awaited<ReturnType<typeof loadAndPrice>>) {
  if (!result) return null;
  const { estimate: e, priced } = result;
  return {
    id: e.id,
    jobNumber: e.jobNumber,
    revision: e.revision,
    name: e.name,
    client: e.client,
    location: e.location,
    consultant: e.consultant,
    status: e.status,
    currency: e.currency,
    fxRate: e.fxRate,
    totalArea: e.totalArea,
    projectId: e.projectId,
    notes: e.notes,
    sourceFile: e.sourceFile,
    updatedAt: e.updatedAt,
    margins: {
      overheadPct: e.overheadPct,
      marginPct: e.marginPct,
      financingPct: e.financingPct,
      contingencyPct: e.contingencyPct,
      customsPct: e.customsPct,
      corporateTaxPct: e.corporateTaxPct,
      designPct: e.designPct,
      commissionPct: e.commissionPct,
    },
    bills: priced.bills,
    directCost: priced.directCost,
    total: priced.total,
    totalUsd: priced.totalUsd,
    perSqft: priced.perSqft,
    perSqftUsd: priced.perSqftUsd,
  };
}

/** GET /api/estimates?projectId= — the revisions of one project, or all of them. */
router.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);

    const { projectId } = listQuerySchema.parse(req.query);

    const estimates = await prisma.estimate.findMany({
      where: {
        organizationId: req.user.organizationId,
        ...(projectId !== undefined ? { projectId } : {}),
      },
      orderBy: [{ jobNumber: 'desc' }, { revision: 'asc' }],
      include: {
        _count: { select: { lines: true, takeoff: true } },
        project: { select: { id: true, displayNumber: true, name: true } },
      },
    });

    res.json({
      estimates: estimates.map((e) => ({
        id: e.id,
        jobNumber: e.jobNumber,
        revision: e.revision,
        name: e.name,
        client: e.client,
        status: e.status,
        currency: e.currency,
        totalArea: e.totalArea,
        totalAmount: e.totalAmount,
        perSqft: e.totalArea && e.totalArea > 0 && e.totalAmount ? e.totalAmount / e.totalArea : null,
        lineCount: e._count.lines,
        takeoffCount: e._count.takeoff,
        project: e.project,
        updatedAt: e.updatedAt,
      })),
    });
  }),
);

/** POST /api/estimates — raise a revision against a project, optionally cloning one. */
router.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);

    const data = createEstimateSchema.parse(req.body);

    const project = await prisma.project.findFirst({
      where: { id: data.projectId, organizationId: req.user.organizationId },
      select: { id: true, displayNumber: true, name: true },
    });
    if (!project) throw createApiError('Project not found', 404);

    const source = data.copyFromId
      ? await prisma.estimate.findFirst({
          where: { id: data.copyFromId, organizationId: req.user.organizationId },
          include: { lines: { orderBy: { sortOrder: 'asc' } } },
        })
      : null;
    if (data.copyFromId && !source) throw createApiError('Revision to copy not found', 404);

    const jobNumber = data.jobNumber ?? source?.jobNumber ?? String(project.displayNumber);

    const clash = await prisma.estimate.findFirst({
      where: { organizationId: req.user.organizationId, jobNumber, revision: data.revision },
      select: { id: true },
    });
    if (clash) throw createApiError(`Revision ${data.revision} already exists for job ${jobNumber}`, 409);

    const created = await prisma.estimate.create({
      data: {
        organizationId: req.user.organizationId,
        projectId: project.id,
        createdBy: req.user.id,
        jobNumber,
        revision: data.revision,
        name: data.name ?? source?.name ?? project.name,
        client: source?.client ?? null,
        location: source?.location ?? null,
        consultant: source?.consultant ?? null,
        currency: source?.currency ?? 'AED',
        fxRate: source?.fxRate ?? 3.6725,
        totalArea: source?.totalArea ?? null,
        // Carrying the source's percentages forward is the point of copying: a new
        // revision reprices the same commercial position against changed scope.
        ...(source
          ? {
              overheadPct: source.overheadPct,
              marginPct: source.marginPct,
              financingPct: source.financingPct,
              contingencyPct: source.contingencyPct,
              customsPct: source.customsPct,
              corporateTaxPct: source.corporateTaxPct,
              designPct: source.designPct,
              commissionPct: source.commissionPct,
            }
          : {}),
        ...(source
          ? {
              lines: {
                create: source.lines.map((l) => ({
                  sortOrder: l.sortOrder,
                  slNo: l.slNo,
                  bill: l.bill,
                  description: l.description,
                  unit: l.unit,
                  qty: l.qty,
                  mode: l.mode,
                  materialCost: l.materialCost,
                  fabricationCost: l.fabricationCost,
                  installationCost: l.installationCost,
                  prelimsCost: l.prelimsCost,
                  shippingCost: l.shippingCost,
                  packagingCost: l.packagingCost,
                  loadingCost: l.loadingCost,
                })),
              },
            }
          : {}),
      },
      select: { id: true },
    });

    const result = await loadAndPrice(created.id);
    if (result) await persistTotals(result);
    logger.info(`Estimate ${jobNumber} ${data.revision} created by ${req.user.email}`);
    res.status(201).json(serialize(result));
  }),
);

/** GET /api/estimates/:id — full priced estimate, recomputed on read. */
router.get(
  '/:id',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);

    const owned = await prisma.estimate.findFirst({
      where: { id: req.params.id, organizationId: req.user.organizationId },
      select: { id: true },
    });
    if (!owned) throw createApiError('Estimate not found', 404);

    res.json(serialize(await loadAndPrice(owned.id)));
  }),
);

/** GET /api/estimates/:id/export — the priced estimate as a workbook. */
router.get(
  '/:id/export',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);

    const owned = await prisma.estimate.findFirst({
      where: { id: req.params.id, organizationId: req.user.organizationId },
      select: { id: true },
    });
    if (!owned) throw createApiError('Estimate not found', 404);

    const result = await loadAndPrice(owned.id);
    if (!result) throw createApiError('Estimate not found', 404);

    const { buffer, filename } = await buildEstimateWorkbook(result.estimate, result.priced);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

/** PATCH /api/estimates/:id — header details and commercial percentages. */
router.patch(
  '/:id',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);

    const existing = await prisma.estimate.findFirst({
      where: { id: req.params.id, organizationId: req.user.organizationId },
      select: { id: true, status: true },
    });
    if (!existing) throw createApiError('Estimate not found', 404);

    const data = updateEstimateSchema.parse(req.body);
    await prisma.estimate.update({ where: { id: existing.id }, data });

    const result = await loadAndPrice(existing.id);
    if (result) await persistTotals(result);
    logger.info(`Estimate ${existing.id} updated by ${req.user.id}`);
    res.json(serialize(result));
  }),
);

/** POST /api/estimates/:id/lines — add a priced item to the revision. */
router.post(
  '/:id/lines',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);

    const owned = await prisma.estimate.findFirst({
      where: { id: req.params.id, organizationId: req.user.organizationId },
      select: { id: true },
    });
    if (!owned) throw createApiError('Estimate not found', 404);

    const data = createLineSchema.parse(req.body);
    const last = await prisma.estimateLine.findFirst({
      where: { estimateId: owned.id },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    await prisma.estimateLine.create({
      data: {
        estimateId: owned.id,
        bill: data.bill,
        description: data.description,
        unit: data.unit ?? null,
        qty: data.qty,
        mode: data.mode ?? 'FULL',
        materialCost: data.unitCost,
        sortOrder: (last?.sortOrder ?? 0) + 1,
      },
    });

    const result = await loadAndPrice(owned.id);
    if (result) await persistTotals(result);
    res.status(201).json(serialize(result));
  }),
);

/** PATCH /api/estimates/:id/lines/:lineId — quantity or a direct cost component. */
router.patch(
  '/:id/lines/:lineId',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);

    const line = await prisma.estimateLine.findFirst({
      where: {
        id: req.params.lineId,
        estimateId: req.params.id,
        estimate: { organizationId: req.user.organizationId },
      },
      select: { id: true },
    });
    if (!line) throw createApiError('Estimate line not found', 404);

    const data = updateLineSchema.parse(req.body);
    await prisma.estimateLine.update({ where: { id: line.id }, data });

    const result = await loadAndPrice(req.params.id);
    if (result) await persistTotals(result);
    res.json(serialize(result));
  }),
);

const generateSchema = z.object({
  /** Replace existing lines. Default true so Auto Generate starts from a clean draft. */
  replace: z.boolean().optional().default(true),
});

/**
 * POST /api/estimates/:id/generate — draft lines with OpenAI from project inputs.
 *
 * Pulls PDF text from uploaded drawings and seeds the model with this organisation's
 * historical unit rates, then snaps matching descriptions back onto those rates.
 * Still a draft the estimator reviews — not a finished quote.
 */
router.post(
  '/:id/generate',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);
    if (!process.env.OPENAI_API_KEY) {
      throw createApiError('OpenAI is not configured on this server', 503);
    }

    const { replace } = generateSchema.parse(req.body ?? {});

    const estimate = await prisma.estimate.findFirst({
      where: { id: req.params.id, organizationId: req.user.organizationId },
      include: {
        project: { select: { id: true, name: true, buildSystem: true } },
        lines: { select: { id: true }, take: 1 },
      },
    });
    if (!estimate) throw createApiError('Estimate not found', 404);

    const docs = estimate.projectId
      ? await prisma.projectDocument.findMany({
          where: { projectId: estimate.projectId, category: 'DRAWINGS' },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: {
            name: true,
            originalFilename: true,
            mimeType: true,
            storageKey: true,
          },
        })
      : [];

    const documentNames = docs.map((d) => d.originalFilename || d.name);
    const imageDocs = docs.filter(
      (d) =>
        d.mimeType.startsWith('image/') ||
        /\.(png|jpe?g|webp|gif)$/i.test(d.originalFilename || ''),
    );

    const images: { name: string; url: string }[] = [];
    for (const doc of imageDocs.slice(0, 4)) {
      try {
        const url = await storageService.getDownloadUrl(doc.storageKey, 60 * 10);
        images.push({ name: doc.name, url });
      } catch (err) {
        logger.warn(`Could not sign image ${doc.name} for estimate generate:`, err);
      }
    }

    const [pdfExcerpts, history] = await Promise.all([
      extractPdfExcerpts(docs),
      loadHistoricalRates(req.user.organizationId),
    ]);

    const generated = await generateEstimateLines({
      projectName: estimate.project?.name || estimate.name,
      jobNumber: estimate.jobNumber,
      revision: estimate.revision,
      buildSystem: estimate.project?.buildSystem,
      currency: estimate.currency,
      totalArea: estimate.totalArea,
      documentNames,
      images,
      pdfExcerpts,
      historicalRates: history.rates,
      historicalJobs: history.jobs,
    });

    if (!generated.length) {
      throw createApiError('AI returned no estimate lines. Try again or add items manually.', 502);
    }

    await prisma.$transaction(async (tx) => {
      if (replace) {
        await tx.estimateLine.deleteMany({ where: { estimateId: estimate.id } });
      }
      const start =
        replace
          ? 0
          : ((
              await tx.estimateLine.findFirst({
                where: { estimateId: estimate.id },
                orderBy: { sortOrder: 'desc' },
                select: { sortOrder: true },
              })
            )?.sortOrder ?? 0);

      await tx.estimateLine.createMany({
        data: generated.map((line, i) => ({
          estimateId: estimate.id,
          bill: line.bill,
          description: line.description,
          unit: line.unit,
          qty: line.qty,
          mode: 'FULL' as const,
          materialCost: line.unitCost,
          sortOrder: start + i + 1,
        })),
      });

      const stamp = new Date().toISOString().slice(0, 10);
      await tx.estimate.update({
        where: { id: estimate.id },
        data: {
          notes: [
            estimate.notes,
            `Auto-generated ${generated.length} line(s) on ${stamp} from ${documentNames.length} input(s), ${pdfExcerpts.length} PDF text extract(s), ${history.rates.length} historical rate(s).`,
          ]
            .filter(Boolean)
            .join(' '),
        },
      });
    });

    const result = await loadAndPrice(estimate.id);
    if (result) await persistTotals(result);
    logger.info(
      `Estimate ${estimate.jobNumber} ${estimate.revision} auto-generated ${generated.length} lines by ${req.user.email}`,
    );
    res.json(serialize(result));
  }),
);

/** DELETE /api/estimates/:id — drop a revision and its lines. */
router.delete(
  '/:id',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw createApiError('Authentication required', 401);

    const existing = await prisma.estimate.findFirst({
      where: { id: req.params.id, organizationId: req.user.organizationId },
      select: { id: true, jobNumber: true, revision: true, status: true },
    });
    if (!existing) throw createApiError('Estimate not found', 404);

    if (existing.status === 'ISSUED' || existing.status === 'WON') {
      throw createApiError(
        `Cannot delete an ${existing.status.toLowerCase()} revision. Mark it superseded first.`,
        409,
      );
    }

    await prisma.estimate.delete({ where: { id: existing.id } });
    logger.info(
      `Estimate ${existing.jobNumber} ${existing.revision} deleted by ${req.user.email}`,
    );
    res.json({ ok: true, id: existing.id });
  }),
);

export default router;
