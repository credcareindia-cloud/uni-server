import { createOpenAI } from '@ai-sdk/openai'
import {
  isStepCount,
  pipeAgentUIStreamToResponse,
  ToolLoopAgent,
  tool,
} from 'ai'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { agentInstructionBody, foundationInstructionBody, planInstructionBody } from './agentCatalog.js'

const MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'] as const
const DEFAULT_MODEL = 'gpt-6.1-sol'

const READ_TOOLS = [
  'listFiles',
  'readPage',
  'searchDocuments',
  'searchRates',
  'web_search',
  'getProjectContext',
  'extractGeometry',
  'scanSheets',
  'traceFootprint',
  'getRules',
  'foundationEngine',
  'listMeasurements',
  'getEstimateSummary',
  'askUser',
] as const

/** The Foundation agent reads everything but writes only scale, measurements and project context. */
const FOUNDATION_TOOLS = [
  'scanSheets',
  'listFiles',
  'readPage',
  'searchDocuments',
  'getProjectContext',
  'extractGeometry',
  'traceFootprint',
  'getRules',
  'foundationEngine',
  'listMeasurements',
  'askUser',
  'setPageScale',
  'addMeasurement',
  'updateMeasurement',
  'removeMeasurement',
  'updateProjectContext',
] as const
const WRITE_TOOLS = [
  'setScale',
  'setPageScale',
  'addMeasurement',
  'updateMeasurement',
  'removeMeasurement',
  'updateProjectContext',
  'updateCommercials',
  'saveRevision',
  'upsertLine',
  'updateLine',
  'removeLine',
] as const

const ELEMENT_IDS = [
  'ext-wall',
  'int-wall',
  'bath-wall',
  'floor',
  'staircase',
  'railing',
  'ceiling',
  'wet-ceiling',
  'roof',
  'roof-deck',
  'door',
  'window',
  'column',
  'beam',
  'struct-wall',
  'iso-footing',
  'ground-beam',
  'strip-footing',
  'grid-footing',
  'ground-slab',
] as const

const pctField = (what: string) => z.number().min(0).max(100).optional().describe(`${what}, percent`)

const pointSchema = z.object({ x: z.number(), y: z.number() })

const fileRef = {
  fileId: z.string().optional().describe('Document id from listFiles'),
  fileName: z.string().optional().describe('File name if you do not have the id'),
}

const sizeFields = {
  lengthMm: z.number().positive().optional().describe('Stated length, when not drawn'),
  widthMm: z.number().positive().optional().describe('Width of an opening, footing, or beam section'),
  heightMm: z.number().positive().optional().describe('Wall or opening height. Walls default to the floor height.'),
  depthMm: z.number().positive().optional().describe('Footing or beam depth'),
  thicknessMm: z.number().positive().optional().describe('Slab thickness'),
  count: z.number().int().positive().optional().describe('Number of items for a stated count'),
}

const PLAN_TOOLS = ['revisePlan', 'askUser'] as const

const callOptionsSchema = z.object({
  mode: z.enum(['ask', 'execute']),
  model: z.enum(MODELS),
  context: z.string(),
  scope: z.enum(['general', 'foundation', 'plan']).default('general'),
})

function instructionsFor(mode: 'ask' | 'execute', context: string, scope: 'general' | 'foundation' | 'plan' = 'general') {
  const body = scope === 'plan' ? planInstructionBody() : scope === 'foundation' ? foundationInstructionBody() : agentInstructionBody(mode)
  return `${body}

PROJECT CONTEXT:
${context || '(no project context yet)'}`
}

function createAgent(apiKey: string) {
  const openai = createOpenAI({ apiKey })
  return new ToolLoopAgent({
    model: openai.responses(DEFAULT_MODEL),
    callOptionsSchema,
    stopWhen: isStepCount(48),
    instructions: instructionsFor('ask', ''),
    prepareCall: ({ options, ...settings }) => ({
      ...settings,
      model: openai.responses(options.model),
      activeTools:
        options.scope === 'plan'
          ? [...PLAN_TOOLS]
          : options.scope === 'foundation'
            ? [...FOUNDATION_TOOLS]
            : options.mode === 'execute'
              ? [...READ_TOOLS, ...WRITE_TOOLS]
              : [...READ_TOOLS],
      instructions: instructionsFor(options.mode, options.context, options.scope),
    }),
    tools: {
      listFiles: tool({
        description:
          'List the client PDFs already added in this session, with page counts and how much selectable text each page has.',
        inputSchema: z.object({}),
      }),
      readPage: tool({
        description:
          'Read one page of a client PDF. Attaches the original PDF file and the page number to use. Look at that page of the PDF.',
        inputSchema: z.object({
          fileId: z.string().optional().describe('Document id from listFiles'),
          fileName: z.string().optional().describe('File name if you do not have the id'),
          pageNumber: z.number().int().min(1),
        }),
        toModelOutput: ({ output }) => {
          const row =
            output && typeof output === 'object'
              ? (output as {
                  error?: string
                  fileName?: string
                  pageNumber?: number
                  note?: string
                  text?: string
                  pdf?: string
                })
              : {}
          const pageNumber = row.pageNumber ?? ''
          const text = [
            row.error,
            row.fileName
              ? `PDF attached: ${row.fileName}. Read page ${pageNumber} of this file.`
              : '',
            row.note,
            row.text ? `Extracted text from page ${pageNumber}:\n${row.text}` : '',
          ]
            .filter(Boolean)
            .join('\n\n')
          const parts: Array<
            | { type: 'text'; text: string }
            | { type: 'file'; mediaType: string; data: { type: 'data'; data: string } }
          > = [{ type: 'text', text }]
          if (typeof row.pdf === 'string' && row.pdf.startsWith('data:')) {
            const data = row.pdf.slice(row.pdf.indexOf(',') + 1)
            if (data) {
              parts.push({
                type: 'file',
                mediaType: 'application/pdf',
                data: { type: 'data', data },
              })
            }
          }
          return { type: 'content', value: parts }
        },
      }),
      searchDocuments: tool({
        description:
          'Search extracted text across every uploaded PDF for whatever the human asked about.',
        inputSchema: z.object({
          query: z.string().min(1),
        }),
      }),
      searchRates: tool({
        description:
          'Search the price sheet for unit rates. Call this before quoting a price or writing a unit price. Use a matching rate. Do not invent one.',
        inputSchema: z.object({
          query: z
            .string()
            .min(1)
            .describe('Material, component, or system to match, such as aluminium fixed window or LGS stud'),
        }),
      }),
      web_search: openai.tools.webSearch({
        externalWebAccess: true,
        searchContextSize: 'medium',
      }),
      askUser: tool({
        description:
          'Ask the human one question and wait. Use this when the scale, unit, revision, or a conflicting dimension is not on the drawing.',
        inputSchema: z.object({
          question: z.string().min(1),
          options: z
            .array(z.object({ id: z.string(), label: z.string() }))
            .optional()
            .describe('Short choices. The human can also type their own answer.'),
        }),
      }),
      setScale: tool({
        description:
          'Record the drawing scale or unit system the human confirmed, for example 1/4" = 1\'-0" or all dimensions are millimetres.',
        inputSchema: z.object({
          statement: z.string().min(1),
        }),
      }),
      upsertLine: tool({
        description:
          'Add or replace one takeoff line, keyed by tag. Use the unit, system, and quantity from the documents. Leave width and height at 0 when the item has no opening size. Leaves the line unconfirmed.',
        inputSchema: z.object({
          tag: z.string().min(1),
          system: z.string().default(''),
          widthMm: z.number().nonnegative(),
          heightMm: z.number().nonnegative(),
          type: z.string().default('Item'),
          quantity: z.number().positive().default(1),
          unit: z.string().default('Pieces'),
          unitPrice: z
            .number()
            .nonnegative()
            .default(0)
            .describe('From searchRates when a rate matches. Otherwise 0.'),
          notes: z.string().default(''),
          pageRef: z.number().int().positive().optional(),
        }),
      }),
      updateLine: tool({
        description: 'Change fields on an existing canvas line, found by tag.',
        inputSchema: z.object({
          tag: z.string().min(1),
          system: z.string().optional(),
          widthMm: z.number().nonnegative().optional(),
          heightMm: z.number().nonnegative().optional(),
          type: z.string().optional(),
          quantity: z.number().positive().optional(),
          unit: z.string().optional(),
          unitPrice: z.number().nonnegative().optional(),
          notes: z.string().optional(),
          pageRef: z.number().int().positive().optional(),
        }),
      }),
      removeLine: tool({
        description: 'Remove one canvas line by tag.',
        inputSchema: z.object({
          tag: z.string().min(1),
        }),
      }),
      getProjectContext: tool({
        description:
          'The job brief: building, units, floors with heights, elements in scope, build-up layers with rates, default sizes, and the page scales already set.',
        inputSchema: z.object({}),
      }),
      extractGeometry: tool({
        description:
          'Run the geometry engine on one page. Returns page size, scale candidates (and applies a confident auto-calibration), dimension strings with positions and mm values, closed rectangles, the longest vector lines, and text labels. Call before measuring anything on that page.',
        inputSchema: z.object({
          ...fileRef,
          pageNumber: z.number().int().min(1),
          detail: z.enum(['brief', 'standard', 'full']).optional().describe('How many items to return. Default standard.'),
        }),
      }),
      scanSheets: tool({
        description:
          'Index every page of every uploaded PDF: drawing number, title, kind (cover, plan, section, elevation, schedule), scale notes, auto-calibrated scale, levels (ROOF 3750 …), stated areas (BUILT-UP AREA = …), room areas, grid labels, and keyword hits (foundation, structure, blockwork, LGS, by others). Also says whether any foundation or structural sheet exists. Call this first.',
        inputSchema: z.object({}),
      }),
      traceFootprint: tool({
        description:
          'Trace the building outline on a plan sheet with the geometry engine: rasterises the wall lines inside the plan region (bounded by the written overall dimensions, dimension lines and grid lines excluded), closes gaps, floods the outside, and returns the footprint polygon in page points with its area (m²), perimeter (m), bounding box (mm), and a check against the written overall dimensions. Use the polygon as points for addMeasurement.',
        inputSchema: z.object({
          ...fileRef,
          pageNumber: z.number().int().min(1),
          region: z
            .object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() })
            .optional()
            .describe('Page-point box to trace inside. Default: the plan region from the written overall dimensions.'),
          closingRadiusPt: z.number().positive().optional().describe('Gap closing radius in points. Default ≈ 120 mm at page scale.'),
          openingRadiusPt: z.number().positive().optional().describe('Feature removal radius in points (door swings, ticks). Default ≈ 350 mm at page scale.'),
        }),
      }),
      getRules: tool({
        description:
          'Look up UNIQUBE estimation rules by id, category (SUBSTRUCTURE, SUPERSTRUCTURE, …) or free text. Returns id, name, unit, quantity logic, required inputs, validation check, status and release gate. Quality tests QA-01…QA-14 and the foundation engine rules (PI, SL, FZ, FD, SA, RG, WC, FT, T1, T2, T3, RB, BQ, VC ids; category FOUNDATION-ENGINE) can be fetched by id too. Use it to cite the rule behind a quantity.',
        inputSchema: z.object({
          ids: z.array(z.string()).optional(),
          category: z.string().optional(),
          query: z.string().optional(),
          limit: z.number().int().min(1).max(60).optional(),
        }),
      }),
      revisePlan: tool({
        description:
          'Apply one revision to the foundation plan and redraw it. Coordinates are millimetres in the plan axes from the context. Use only wall and zone ids from the context. Call this when the human asks to change foundation type, storeys, plinth, soil bearing, line load, a beam, a zone direction, a wall class, or a support line. Do not call it to move walls or redraw the outline.',
        inputSchema: z.object({
          summary: z.string().min(1).max(240).describe('One line for the change log naming what changed.'),
          foundationType: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
          storeyCount: z.number().int().min(1).max(20).optional(),
          plinthAboveNglMm: z.number().min(0).max(3000).nullable().optional(),
          soilBearingKpa: z.number().positive().nullable().optional(),
          lineLoadPerStoreyKnM: z.number().positive().nullable().optional(),
          addBeams: z
            .array(z.object({ axis: z.enum(['h', 'v']), pos: z.number(), a: z.number(), b: z.number() }))
            .max(8)
            .optional()
            .describe('h means a beam along x at y=pos, from a to b. v means along y at x=pos.'),
          removeBeamIds: z.array(z.string()).max(20).optional(),
          directions: z
            .array(z.object({ zoneId: z.string(), direction: z.enum(['x', 'y']).nullable() }))
            .max(30)
            .optional()
            .describe('null returns the zone to the automatic direction.'),
          wallClasses: z.array(z.object({ wallId: z.string(), class: z.enum(['LB', 'NLB']).nullable() })).max(40).optional(),
          promoteWallIds: z.array(z.string()).max(40).optional(),
          demoteWallIds: z.array(z.string()).max(40).optional(),
          clearEdits: z.boolean().optional().describe('Remove beams, directions, wall classes and promotions before applying the rest.'),
        }),
      }),
      foundationEngine: tool({
        description:
          'Run the deterministic UNIQUBE load-bearing wall & foundation engine (spec v0.1) on the ground-floor plan with the inputs and engineer overrides saved in the Engine view. Returns walls with classes (LB / SHEAR / NLB and the WC rule), support lines, framing zones with FD decisions, load-bearing lines, the review-gate state, flags (F-SPAN, F-INPUT, …), the BOQ rows (boq_code T1-01…, net and gross qty, unit, rule ids, basis formula) for the chosen foundation type, reinforcement per element and diameter, and the VC checks. Rows are null, not zero, when a stop flag or a missing input blocks the run. Pass storeyCount, foundationType, plinthAboveNglMm only when the human gave them in chat; otherwise the saved inputs are used.',
        inputSchema: z.object({
          storeyCount: z.number().int().min(1).max(20).optional(),
          foundationType: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('1 strip + RCC wall, 2 isolated footings + stub columns + ground beams, 3 slab on grade with monolithic beams (S1 only).'),
          plinthAboveNglMm: z.number().min(0).max(3000).optional(),
          soilBearingKpa: z.number().positive().optional(),
          lineLoadPerStoreyKnM: z.number().positive().optional(),
          detail: z.enum(['summary', 'full']).optional().describe('summary (default) omits wall and zone lists.'),
        }),
      }),
      listMeasurements: tool({
        description: 'Measurements already taken in this project, with computed quantities and their canvas lines.',
        inputSchema: z.object({
          fileId: z.string().optional(),
          pageNumber: z.number().int().positive().optional(),
        }),
      }),
      setPageScale: tool({
        description:
          'Set the scale of one page in mm per PDF point. Give ratio (100 for 1:100, 48 for 1/4" = 1\'-0"), or two points with the known distance between them, or useCandidate to accept the auto-calibrated one.',
        inputSchema: z.object({
          ...fileRef,
          pageNumber: z.number().int().min(1),
          ratio: z.number().positive().optional(),
          mmPerPt: z.number().positive().optional(),
          points: z.array(pointSchema).length(2).optional(),
          knownLengthMm: z.number().positive().optional(),
          useCandidate: z.boolean().optional(),
          candidateIndex: z.number().int().nonnegative().optional(),
        }),
      }),
      addMeasurement: tool({
        description:
          'Measure one element on a page and write its priced canvas lines. Either give points (page coordinates from extractGeometry) with kind length, area, rect, or count, or give stated dims with kind dims. The engine applies the page scale, the floor height, the build-up layers, and the price sheet.',
        inputSchema: z.object({
          ...fileRef,
          pageNumber: z.number().int().min(1),
          elementId: z.enum(ELEMENT_IDS),
          label: z.string().min(1).describe('Short tag such as EW-GF-North or FTG-F1'),
          kind: z.enum(['length', 'area', 'rect', 'count', 'dims']).optional(),
          points: z.array(pointSchema).optional().describe('Page points. length: polyline; area: polygon; rect: two opposite corners; count: one point per item.'),
          floor: z.number().int().nullable().optional().describe('Floor level from the project context. 0 for substructure.'),
          ...sizeFields,
          deductM2: z.number().nonnegative().optional().describe('Openings or voids to subtract, in m²'),
          notes: z.string().optional().describe('Which dimension strings or lines this rests on'),
          toCanvas: z.boolean().optional().describe('Default true. False saves the measurement without writing lines.'),
        }),
      }),
      updateMeasurement: tool({
        description: 'Change a measurement by id. Its canvas lines refresh, except lines a person already confirmed.',
        inputSchema: z.object({
          id: z.string().min(1),
          elementId: z.enum(ELEMENT_IDS).optional(),
          label: z.string().optional(),
          kind: z.enum(['length', 'area', 'rect', 'count', 'dims']).optional(),
          points: z.array(pointSchema).optional(),
          floor: z.number().int().nullable().optional(),
          ...sizeFields,
          deductM2: z.number().nonnegative().optional(),
          notes: z.string().optional(),
        }),
      }),
      removeMeasurement: tool({
        description: 'Remove a measurement and its unconfirmed canvas lines.',
        inputSchema: z.object({ id: z.string().min(1) }),
      }),
      updateProjectContext: tool({
        description:
          'Edit the job brief: building, client, consultant, project number, units, floor count or floors with heights and built-up areas, elements in scope, build-up layers and default sizes per element, scope notes. Only the fields you pass change.',
        inputSchema: z.object({
          buildingType: z.string().optional(),
          location: z.string().optional(),
          description: z.string().optional(),
          client: z.string().optional(),
          consultant: z.string().optional(),
          projectNumber: z.string().optional().describe('Job number such as 5335'),
          units: z.enum(['mm', 'm', 'ft']).optional().describe('Unit the dimension strings use when they carry no suffix'),
          floorCount: z.number().int().min(1).max(60).optional(),
          floors: z
            .array(
              z.object({
                level: z.number().int().min(1),
                name: z.string().optional(),
                heightMm: z.number().positive().optional(),
                areaM2: z.number().positive().optional().describe('Built-up area of the floor in m², when stated on the drawing or by the client'),
              }),
            )
            .optional(),
          elements: z.array(z.enum(ELEMENT_IDS)).optional(),
          buildUps: z
            .record(
              z.string(),
              z.object({
                layers: z.array(z.object({ id: z.string().optional(), name: z.string(), thicknessMm: z.number().nonnegative().optional(), priceRowId: z.string().optional() })).optional(),
                heightMm: z.number().positive().optional(),
                widthMm: z.number().positive().optional(),
                depthMm: z.number().positive().optional(),
                thicknessMm: z.number().positive().optional(),
                notes: z.string().optional(),
              }),
            )
            .optional()
            .describe('Keyed by element id'),
          scopeNotes: z.string().optional(),
        }),
      }),
      getEstimateSummary: tool({
        description:
          'The live estimate built from the canvas: built-up area per floor, direct cost split material/fabrication/installation, steel, installation, logistics and preliminaries allowances, markup stack and multiplier, selling price in AED and USD, AED per sqft, systems table, client BOQ lump sums, cost breakdown (CBD), QTO by floor, benchmark checks against recent UNIQUBE projects, warnings, saved revisions. Call it before quoting any total or rate.',
        inputSchema: z.object({}),
      }),
      updateCommercials: tool({
        description:
          'Change the commercial assumptions used to turn direct cost into the selling price and to size the allowances. Only the fields you pass change. Percentages are whole numbers (15 = 15%).',
        inputSchema: z.object({
          currency: z.string().optional(),
          usdRate: z.number().positive().optional().describe('AED per USD, 3.67'),
          overheadPct: pctField('Head office overhead on direct cost'),
          marginPct: pctField('Margin as share of selling price'),
          financePct: pctField('Finance charge'),
          contingencyPct: pctField('Contingency'),
          designPct: pctField('Design and engineering'),
          commissionPct: pctField('Commission'),
          customsPct: pctField('Customs and duties'),
          corporateTaxPct: pctField('Corporate tax'),
          lgsKgPerM2: z.number().nonnegative().optional().describe('LGS steel kg per m² of built-up area'),
          hrsKgPerM2: z.number().nonnegative().optional().describe('Hot-rolled steel kg per m²'),
          lgsRatePerKg: z.number().nonnegative().optional(),
          hrsRatePerKg: z.number().nonnegative().optional(),
          screwsPerM2: z.number().nonnegative().optional(),
          screwRate: z.number().nonnegative().optional(),
          connectorsPerKgLgs: z.number().nonnegative().optional(),
          anchorsCount: z.number().nonnegative().optional(),
          anchorRate: z.number().nonnegative().optional(),
          installPerM2: z.number().nonnegative().optional().describe('Site installation AED per m² of built-up area'),
          m2PerContainer: z.number().positive().optional(),
          trailerPerContainer: z.number().nonnegative().optional(),
          palletPerContainer: z.number().nonnegative().optional(),
          prelimsPct: pctField('Preliminaries as share of direct cost (used when lump sum is 0)'),
          prelimsLumpSum: z.number().nonnegative().optional().describe('Preliminaries lump sum in AED'),
          mepPanelsPerM2: z.number().nonnegative().optional(),
          mepRatePerPanel: z.number().nonnegative().optional(),
          includeSteelAllowance: z.boolean().optional(),
          includeInstallation: z.boolean().optional(),
          includeLogistics: z.boolean().optional(),
          includePrelims: z.boolean().optional(),
          includeMep: z.boolean().optional(),
        }),
      }),
      saveRevision: tool({
        description: 'Snapshot the current estimate as a revision (R0, R1, ...) so later changes can be compared against it. Use after the person agrees the numbers.',
        inputSchema: z.object({
          label: z.string().optional().describe('Defaults to the next R-number'),
          note: z.string().optional().describe('What changed in this revision'),
        }),
      }),
    },
  })
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export async function handleAgentPost(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string,
) {
  if (!apiKey) {
    sendJson(res, 503, {
      error: 'OPENAI_API_KEY is not configured on the server.',
    })
    return
  }

  let payload: {
    messages?: unknown
    mode?: unknown
    model?: unknown
    context?: unknown
    scope?: unknown
  }
  try {
    payload = JSON.parse((await readBody(req)).toString('utf8')) as typeof payload
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' })
    return
  }

  if (!Array.isArray(payload.messages)) {
    sendJson(res, 400, { error: 'messages required' })
    return
  }

  const mode = payload.mode === 'execute' ? 'execute' : 'ask'
  const requested = typeof payload.model === 'string' ? payload.model : DEFAULT_MODEL
  const model = (MODELS as readonly string[]).includes(requested) ? requested : DEFAULT_MODEL
  const context = typeof payload.context === 'string' ? payload.context : ''
  const scope = payload.scope === 'foundation' ? 'foundation' : 'general'

  req.setTimeout(600_000)
  res.setTimeout(600_000)

  try {
    await pipeAgentUIStreamToResponse({
      response: res,
      agent: createAgent(apiKey),
      uiMessages: payload.messages,
      options: {
        mode,
        model: model as (typeof MODELS)[number],
        context,
        scope,
      },
    })
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : 'Agent failed' })
  }
}
