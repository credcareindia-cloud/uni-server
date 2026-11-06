/**
 * Prices a stored estimate.
 *
 * Lines hold their direct costs as a snapshot, and the revision holds its own set of
 * commercial percentages, so an estimate always reprices to the same number no matter
 * what procurement has published since. Bills are derived by grouping rather than
 * stored, so moving a line between bills needs no migration.
 */

import type { Estimate, EstimateLine } from '@prisma/client';
import { priceLine, type DirectCosts, type Margins } from './costModel.js';

export interface PricedLine {
  id: string;
  slNo: string | null;
  bill: string;
  description: string;
  unit: string | null;
  qty: number;
  mode: EstimateLine['mode'];
  direct: DirectCosts;
  /** Sum of the direct components, before any uplift. */
  directTotal: number;
  sellRate: number;
  amount: number;
}

export interface PricedBill {
  bill: string;
  lines: PricedLine[];
  amount: number;
}

export interface PricedEstimate {
  lines: PricedLine[];
  bills: PricedBill[];
  /** Direct cost of everything, the figure margin is earned on. */
  directCost: number;
  total: number;
  totalUsd: number | null;
  perSqft: number | null;
  perSqftUsd: number | null;
}

export function marginsOf(estimate: Estimate): Margins {
  return {
    overhead: estimate.overheadPct,
    margin: estimate.marginPct,
    financing: estimate.financingPct,
    contingency: estimate.contingencyPct,
    customs: estimate.customsPct,
    corporateTax: estimate.corporateTaxPct,
    design: estimate.designPct,
    commission: estimate.commissionPct,
  };
}

function directOf(line: EstimateLine): DirectCosts {
  return {
    material: line.materialCost,
    fabrication: line.fabricationCost,
    installation: line.installationCost,
    prelims: line.prelimsCost,
    shipping: line.shippingCost,
    packaging: line.packagingCost,
    loading: line.loadingCost,
  };
}

export function priceEstimate(estimate: Estimate, lines: EstimateLine[]): PricedEstimate {
  const margins = marginsOf(estimate);

  const priced: PricedLine[] = lines.map((line) => {
    const direct = directOf(line);
    const { unit, rate, total } = priceLine(line.qty, direct, margins, line.mode);
    return {
      id: line.id,
      slNo: line.slNo,
      bill: line.bill,
      description: line.description,
      unit: line.unit,
      qty: line.qty,
      mode: line.mode,
      direct,
      directTotal: unit.direct * line.qty,
      sellRate: rate,
      amount: total,
    };
  });

  // Preserve the order bills first appear in, which is the estimator's bill order.
  const bills: PricedBill[] = [];
  const byName = new Map<string, PricedBill>();
  for (const line of priced) {
    let bill = byName.get(line.bill);
    if (!bill) {
      bill = { bill: line.bill, lines: [], amount: 0 };
      byName.set(line.bill, bill);
      bills.push(bill);
    }
    bill.lines.push(line);
    bill.amount += line.amount;
  }

  const total = bills.reduce((sum, b) => sum + b.amount, 0);
  const directCost = priced.reduce((sum, l) => sum + l.directTotal, 0);
  const area = estimate.totalArea && estimate.totalArea > 0 ? estimate.totalArea : null;
  const totalUsd = estimate.fxRate > 0 ? total / estimate.fxRate : null;

  return {
    lines: priced,
    bills,
    directCost,
    total,
    totalUsd,
    perSqft: area ? total / area : null,
    perSqftUsd: area && totalUsd != null ? totalUsd / area : null,
  };
}
