/**
 * The UNIQUBE estimating cost model, extracted from the estimators' workbook template.
 *
 * Every priced line is built from seven direct cost components, then walked through a
 * fixed chain of uplifts to a sell rate. The chain is reproduced here exactly as the
 * Costing sheet computes it (columns O through X), so that a parsed workbook can be
 * recomputed from its raw components and checked against what Excel cached.
 *
 * Nothing in here knows about spreadsheets. It is the calculator on its own.
 */

/** Direct cost components, all per single unit of the line's unit of measure. */
export interface DirectCosts {
  material: number;
  fabrication: number;
  installation: number;
  prelims: number;
  shipping: number;
  packaging: number;
  loading: number;
}

/**
 * Commercial uplifts, as fractions. Held per estimate rather than per line: the
 * workbook keeps them in a single row and every line references it absolutely.
 */
export interface Margins {
  overhead: number;
  /** Target margin on sell, applied as a gross-up rather than a markup. */
  margin: number;
  financing: number;
  contingency: number;
  customs: number;
  corporateTax: number;
  design: number;
  commission: number;
}

/**
 * How a line earns its sell rate.
 *
 * `FULL` walks the whole commercial chain. `PASS_THROUGH` is used for preliminaries
 * and logistics, which carry no overhead, margin, financing or contingency — they are
 * recovered at cost and only pick up design and commission.
 */
export type PricingMode = 'FULL' | 'PASS_THROUGH';

/**
 * Which point in the chain a line bills at.
 *
 * `SELL` is the intended one. The others exist because individual cells in the
 * workbook occasionally reference an earlier column, quietly dropping design charges
 * or commission from that line; reproducing them faithfully is what lets the
 * reconciler prove a match and still flag the deviation.
 */
export type RateStage = 'SELL' | 'AFTER_DESIGN' | 'SUBTOTAL';

export function rateAt(breakdown: UnitCostBreakdown, stage: RateStage): number {
  switch (stage) {
    case 'SELL':
      return breakdown.sellRate;
    case 'AFTER_DESIGN':
      return breakdown.afterDesign;
    case 'SUBTOTAL':
      return breakdown.subtotal;
  }
}

/** Every intermediate in the uplift chain, kept so a quote can be explained line by line. */
export interface UnitCostBreakdown {
  direct: number;
  overhead: number;
  margin: number;
  financing: number;
  contingency: number;
  customs: number;
  corporateTax: number;
  /** Sell rate before design and commission. */
  subtotal: number;
  afterDesign: number;
  /** The rate actually used to price the line. */
  sellRate: number;
}

export const ZERO_DIRECT: DirectCosts = {
  material: 0,
  fabrication: 0,
  installation: 0,
  prelims: 0,
  shipping: 0,
  packaging: 0,
  loading: 0,
};

export function sumDirect(d: DirectCosts): number {
  return (
    d.material + d.fabrication + d.installation + d.prelims + d.shipping + d.packaging + d.loading
  );
}

/**
 * Walks one unit through the uplift chain.
 *
 * Margin is a gross-up, not a markup: the result is grossed so that `margin` is the
 * fraction of the *sell* price, which is why it divides by (1 - margin) rather than
 * multiplying. Financing and contingency then apply to the grossed figure, while
 * customs is charged on the direct cost alone and corporate tax on the margin alone.
 */
export function priceUnit(
  direct: DirectCosts,
  m: Margins,
  mode: PricingMode = 'FULL',
): UnitCostBreakdown {
  const o = sumDirect(direct);
  const commercial = mode === 'FULL';

  const overhead = commercial ? o * m.overhead : 0;
  const base = o + overhead;
  const margin = commercial ? base / (1 - m.margin) - base : 0;
  const grossed = base + margin;

  const financing = commercial ? grossed * m.financing : 0;
  const contingency = commercial ? grossed * m.contingency : 0;
  const customs = commercial ? o * m.customs : 0;
  const corporateTax = commercial ? margin * m.corporateTax : 0;

  const subtotal = grossed + financing + contingency + customs + corporateTax;
  const afterDesign = subtotal * (1 + m.design);
  const sellRate = afterDesign * (1 + m.commission);

  return {
    direct: o,
    overhead,
    margin,
    financing,
    contingency,
    customs,
    corporateTax,
    subtotal,
    afterDesign,
    sellRate,
  };
}

export function priceLine(
  qty: number,
  direct: DirectCosts,
  m: Margins,
  mode: PricingMode = 'FULL',
  stage: RateStage = 'SELL',
) {
  const unit = priceUnit(direct, m, mode);
  const rate = rateAt(unit, stage);
  return { unit, rate, total: rate * qty };
}
