/**
 * Drafts estimate lines with OpenAI, grounded in uploaded drawing text and the
 * company's historical rate book.
 *
 * Filenames alone produced optimistic guesses. This pass feeds PDF text excerpts
 * and past unit costs into the prompt, then rewrites any matching descriptions to
 * the organisation's real averages before the cost model prices the lines.
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger.js';
import {
  applyHistoricalRates,
  type HistoricalJob,
  type HistoricalRate,
  type PdfExcerpt,
} from './estimateInputs.js';

export interface GeneratedLine {
  bill: string;
  description: string;
  unit: string;
  qty: number;
  /** Direct unit cost in the estimate currency, before commercial uplifts. */
  unitCost: number;
}

export interface GenerateEstimateInput {
  projectName: string;
  jobNumber: string;
  revision: string;
  buildSystem?: string | null;
  currency: string;
  totalArea?: number | null;
  documentNames: string[];
  /** Optional image payloads (data URLs or https URLs) for vision. */
  images?: { name: string; url: string }[];
  /** Text extracted from uploaded PDFs. */
  pdfExcerpts?: PdfExcerpt[];
  /** Averaged unit costs from past estimates in this organisation. */
  historicalRates?: HistoricalRate[];
  /** Recent priced jobs, used as scale references. */
  historicalJobs?: HistoricalJob[];
}

const BILL_HINT = [
  'LGS Structure',
  'Wall structure',
  'Roofing',
  'Ceiling',
  'Flooring',
  'Openings',
  'Moisture Protection',
  'Sanitary Wares',
  'MEP Works',
  'Additional works',
  'Installation charges',
].join(', ');

function client() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured on the server');
  }
  return new OpenAI({ apiKey: key });
}

function formatRateBook(rates: HistoricalRate[]): string {
  if (!rates.length) return 'No historical rates available.';
  return rates
    .slice(0, 60)
    .map(
      (r) =>
        `- [${r.bill}] ${r.description} | ${r.unit || 'unit'} | ${r.unitCost.toFixed(2)} (${r.uses}x)`,
    )
    .join('\n');
}

function formatJobs(jobs: HistoricalJob[]): string {
  if (!jobs.length) return 'No prior priced jobs.';
  return jobs
    .map((j) => {
      const perSqft =
        j.totalArea && j.totalAmount && j.totalArea > 0
          ? (j.totalAmount / j.totalArea).toFixed(1)
          : '?';
      return `- Job ${j.jobNumber} ${j.revision} "${j.name}": ${j.totalArea ?? '?'} sqft, total ${j.totalAmount?.toFixed(0) ?? '?'}, ~${perSqft}/sqft, ${j.lineCount} lines`;
    })
    .join('\n');
}

function formatPdfExcerpts(excerpts: PdfExcerpt[]): string {
  if (!excerpts.length) return 'No extractable PDF text (filenames and images only).';
  return excerpts
    .map(
      (e) =>
        `--- PDF: ${e.name} (${e.pages} pages) ---\n${e.text}`,
    )
    .join('\n\n');
}

/**
 * Produces a draft bill of quantities for the estimate.
 *
 * Returns an empty array rather than throwing when the model replies with no
 * usable lines, so the caller can tell the user to try again or add items by hand.
 */
export async function generateEstimateLines(
  input: GenerateEstimateInput,
): Promise<GeneratedLine[]> {
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  const openai = client();
  const rates = input.historicalRates ?? [];
  const jobs = input.historicalJobs ?? [];
  const excerpts = input.pdfExcerpts ?? [];

  const system = `You are a UAE modular / LGS / precast construction estimator for UNIQUBE.
Return ONLY valid JSON of the form:
{"lines":[{"bill":"string","description":"string","unit":"sqft|nos|lm|kg|lot","qty":number,"unitCost":number}],"assumedAreaSqft":number|null,"notes":"string"}

Rules:
- unitCost is the DIRECT supply/labour unit cost in ${input.currency}, BEFORE overhead, margin, financing, contingency, design or commission.
- Prefer descriptions and unitCosts from the HISTORICAL RATE BOOK when they fit. Reuse those exact description strings when possible so rates can be matched.
- Use bills from this set when possible: ${BILL_HINT}.
- Read the PDF TEXT carefully for areas, room schedules, wall types, roofing, openings, and materials. Quantities must be grounded in that text when present.
- If total floor area is known or stated in the drawings, ground all area-based quantities in it. Put your assumed area in assumedAreaSqft.
- Scale against PRIOR JOBS when helpful (per-sqft and trade mix).
- Include structure, walls, roofing, openings and installation as a minimum when the project looks like a building.
- Do not invent client names or commercial percentages.
- Keep descriptions short and estimator-like.
- Cap at 45 lines.
- If the PDFs are schedules/BOQ fragments, translate them into lines rather than ignoring them.`;

  const userText = [
    `Project: ${input.projectName}`,
    `Job: ${input.jobNumber}  Revision: ${input.revision}`,
    `Build system: ${input.buildSystem || 'unknown'}`,
    `Currency: ${input.currency}`,
    input.totalArea ? `Recorded total area: ${input.totalArea} sqft` : 'Recorded total area: unknown',
    '',
    'UPLOADED FILES:',
    input.documentNames.length
      ? input.documentNames.map((n) => `- ${n}`).join('\n')
      : '- (none)',
    '',
    'PRIOR JOBS (scale references):',
    formatJobs(jobs),
    '',
    'HISTORICAL RATE BOOK (prefer these descriptions + unitCosts):',
    formatRateBook(rates),
    '',
    'PDF TEXT EXTRACTS:',
    formatPdfExcerpts(excerpts),
    '',
    'Produce the estimate lines JSON now.',
  ].join('\n');

  const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
  for (const image of input.images?.slice(0, 4) ?? []) {
    content.push({
      type: 'image_url',
      image_url: { url: image.url, detail: 'low' },
    });
  }

  logger.info(
    `Generating estimate for job ${input.jobNumber} ${input.revision} with ${model} ` +
      `(${input.documentNames.length} docs, ${excerpts.length} PDFs with text, ` +
      `${input.images?.length ?? 0} images, ${rates.length} historical rates)`,
  );

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  let parsed: { lines?: unknown; assumedAreaSqft?: unknown; notes?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error('OpenAI returned non-JSON for estimate generation');
    return [];
  }

  if (!Array.isArray(parsed.lines)) return [];

  const drafted = parsed.lines
    .map((row): GeneratedLine | null => {
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const description = String(r.description || '').trim();
      if (!description) return null;
      const qty = Number(r.qty);
      const unitCost = Number(r.unitCost);
      return {
        bill: String(r.bill || 'General').trim() || 'General',
        description,
        unit: String(r.unit || 'nos').trim() || 'nos',
        qty: Number.isFinite(qty) && qty >= 0 ? qty : 0,
        unitCost: Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : 0,
      };
    })
    .filter((l): l is GeneratedLine => l != null);

  // Snap AI costs onto the company's book whenever the description matches.
  const priced = applyHistoricalRates(drafted, rates);

  if (typeof parsed.notes === 'string' && parsed.notes.trim()) {
    logger.info(`Generate notes: ${parsed.notes.trim().slice(0, 240)}`);
  }
  if (typeof parsed.assumedAreaSqft === 'number' && parsed.assumedAreaSqft > 0) {
    logger.info(`Generate assumed area: ${parsed.assumedAreaSqft} sqft`);
  }

  return priced;
}
