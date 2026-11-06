/**
 * Gathers everything Auto Generate needs beyond the estimate row itself:
 * text pulled out of uploaded PDFs, and a rate memory built from past jobs.
 */

import { createRequire } from 'module';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { logger } from '../utils/logger.js';

// pdf-parse is CommonJS; load it this way so tsx/ESM don't trip on the default export.
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse') as (
  data: Buffer,
) => Promise<{ text: string; numpages: number }>;

export interface PdfExcerpt {
  name: string;
  text: string;
  pages: number;
}

export interface HistoricalRate {
  bill: string;
  description: string;
  unit: string | null;
  /** Average direct unit cost seen on past estimates. */
  unitCost: number;
  /** How often this description appears — higher = more trusted. */
  uses: number;
}

export interface HistoricalJob {
  jobNumber: string;
  name: string;
  revision: string;
  totalArea: number | null;
  totalAmount: number | null;
  lineCount: number;
}

const PDF_TEXT_CAP = 12_000; // chars per file kept for the prompt
const TOTAL_PDF_CAP = 28_000; // across all files
const RATE_SEED_LIMIT = 80;

function isPdf(mimeType: string, filename: string) {
  return (
    mimeType === 'application/pdf' ||
    mimeType === 'application/x-pdf' ||
    /\.pdf$/i.test(filename)
  );
}

/**
 * Downloads each PDF drawing and extracts plain text.
 *
 * Scanned drawings often yield little or no text — those still contribute their
 * filename; image uploads are handled separately via vision.
 */
export async function extractPdfExcerpts(
  docs: { name: string; originalFilename: string; mimeType: string; storageKey: string }[],
): Promise<PdfExcerpt[]> {
  const pdfs = docs.filter((d) => isPdf(d.mimeType, d.originalFilename || d.name));
  const excerpts: PdfExcerpt[] = [];
  let budget = TOTAL_PDF_CAP;

  for (const doc of pdfs.slice(0, 8)) {
    if (budget <= 500) break;
    try {
      const buffer = await storageService.downloadFile(doc.storageKey);
      // Skip huge files — takeoff PDFs are usually modest; multi-hundred-MB
      // sets are drawings that won't yield useful text anyway.
      if (buffer.length > 25 * 1024 * 1024) {
        logger.info(`Skipping oversized PDF for text extract: ${doc.name}`);
        continue;
      }

      const parsed = await pdfParse(buffer);
      const cleaned = (parsed.text || '')
        .replace(/\u0000/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (!cleaned) continue;

      const slice = cleaned.slice(0, Math.min(PDF_TEXT_CAP, budget));
      budget -= slice.length;
      excerpts.push({
        name: doc.originalFilename || doc.name,
        text: slice,
        pages: parsed.numpages || 0,
      });
    } catch (err) {
      logger.warn(`PDF text extract failed for ${doc.name}:`, err);
    }
  }

  return excerpts;
}

/**
 * Builds a rate library from every priced line the organization has already issued.
 *
 * Past jobs are the estimators' real rate book — averaging material cost per
 * description keeps Auto Generate on the company's numbers instead of inventing AED rates.
 */
export async function loadHistoricalRates(organizationId: string): Promise<{
  rates: HistoricalRate[];
  jobs: HistoricalJob[];
}> {
  // Raw aggregate keeps the rate book cheap to build and ordered by how often
  // estimators actually used each description.
  const lines = await prisma.$queryRaw<
    { bill: string; description: string; unit: string | null; unit_cost: number; uses: bigint }[]
  >`
    SELECT l.bill,
           l.description,
           l.unit,
           AVG(l.material_cost)::float8 AS unit_cost,
           COUNT(*)::bigint AS uses
    FROM estimate_lines l
    INNER JOIN estimates e ON e.id = l.estimate_id
    WHERE e.organization_id = ${organizationId}
      AND l.material_cost > 0
    GROUP BY l.bill, l.description, l.unit
    ORDER BY COUNT(*) DESC, AVG(l.material_cost) DESC
    LIMIT ${RATE_SEED_LIMIT}
  `;

  const rates: HistoricalRate[] = lines
    .map((row) => ({
      bill: row.bill,
      description: row.description,
      unit: row.unit,
      unitCost: Number(row.unit_cost ?? 0),
      uses: Number(row.uses ?? 0),
    }))
    .filter((r) => r.unitCost > 0 && r.description.trim().length > 0);

  const estimates = await prisma.estimate.findMany({
    where: {
      organizationId,
      totalAmount: { gt: 0 },
      totalArea: { gt: 0 },
    },
    orderBy: { updatedAt: 'desc' },
    take: 8,
    select: {
      jobNumber: true,
      name: true,
      revision: true,
      totalArea: true,
      totalAmount: true,
      _count: { select: { lines: true } },
    },
  });

  const jobs: HistoricalJob[] = estimates.map((e) => ({
    jobNumber: e.jobNumber,
    name: e.name,
    revision: e.revision,
    totalArea: e.totalArea,
    totalAmount: e.totalAmount,
    lineCount: e._count.lines,
  }));

  return { rates, jobs };
}

/** Collapse punctuation/case so "12mm Gypsum Board" matches "12 mm gypsum board". */
export function normalizeDesc(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Prefer the company's historical unit cost when the AI reused a known description.
 *
 * Exact match wins; otherwise the longest historical description contained in the
 * generated one (or vice versa) is used, so "12 mm Gypsum Board-NR" can price
 * "12mm gypsum board".
 */
export function applyHistoricalRates<T extends { description: string; unit: string; unitCost: number; bill: string }>(
  lines: T[],
  rates: HistoricalRate[],
): T[] {
  if (!rates.length) return lines;

  const indexed = rates.map((r) => ({ ...r, key: normalizeDesc(r.description) }));

  return lines.map((line) => {
    const key = normalizeDesc(line.description);
    if (!key) return line;

    let best: HistoricalRate | null = null;
    let bestScore = 0;

    for (const rate of indexed) {
      if (!rate.key) continue;
      let score = 0;
      if (rate.key === key) score = 1000 + rate.uses;
      else if (key.includes(rate.key) || rate.key.includes(key)) {
        score = Math.min(key.length, rate.key.length) + rate.uses;
      }
      if (score > bestScore) {
        bestScore = score;
        best = rate;
      }
    }

    if (!best || bestScore < 12) return line;
    return {
      ...line,
      unitCost: best.unitCost,
      unit: line.unit || best.unit || 'nos',
      bill: line.bill || best.bill,
    };
  });
}
