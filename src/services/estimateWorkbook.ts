import ExcelJS from 'exceljs';
import type { Estimate } from '@prisma/client';
import type { PricedEstimate } from './estimating.js';

/** Characters Excel rejects in a sheet name, plus the ones that break a download filename. */
const UNSAFE = /[\\/?*[\]:]/g;

/**
 * Renders a priced estimate as a two-sheet workbook: a bill summary the client sees
 * and the full priced breakdown behind it.
 *
 * Values are written as numbers, not formulas. The engine already resolved every
 * uplift, and shipping literals is what makes the file safe to hand over — the
 * recipient cannot accidentally recalculate it against their own settings.
 */
export async function buildEstimateWorkbook(estimate: Estimate, priced: PricedEstimate) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'UNIQUBE';
  wb.created = new Date();

  const currency = estimate.currency;
  const moneyFormat = '#,##0.00';

  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: '', key: 'label', width: 42 },
    { header: '', key: 'value', width: 22 },
  ];

  const header: [string, string | number | null][] = [
    ['Job number', estimate.jobNumber],
    ['Revision', estimate.revision],
    ['Project', estimate.name],
    ['Client', estimate.client],
    ['Location', estimate.location],
    ['Consultant', estimate.consultant],
    ['Status', estimate.status],
    ['Area (sqft)', estimate.totalArea],
  ];
  for (const [label, value] of header) {
    if (value === null || value === '') continue;
    const row = summary.addRow({ label, value });
    row.getCell('label').font = { bold: true };
  }

  summary.addRow({});
  const billsHeading = summary.addRow({ label: 'Bill', value: `Amount (${currency})` });
  billsHeading.font = { bold: true };

  for (const bill of priced.bills) {
    const row = summary.addRow({ label: bill.bill, value: bill.amount });
    row.getCell('value').numFmt = moneyFormat;
  }

  const totalRow = summary.addRow({ label: 'Total excluding VAT', value: priced.total });
  totalRow.font = { bold: true };
  totalRow.getCell('value').numFmt = moneyFormat;

  if (priced.perSqft != null) {
    const rate = summary.addRow({ label: `Rate per sqft (${currency})`, value: priced.perSqft });
    rate.getCell('value').numFmt = moneyFormat;
  }

  const detail = wb.addWorksheet('Priced breakdown');
  detail.columns = [
    { header: 'Bill', key: 'bill', width: 26 },
    { header: 'Item', key: 'slNo', width: 8 },
    { header: 'Description', key: 'description', width: 58 },
    { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Qty', key: 'qty', width: 12 },
    { header: `Direct cost (${currency})`, key: 'directTotal', width: 16 },
    { header: `Rate (${currency})`, key: 'sellRate', width: 14 },
    { header: `Amount (${currency})`, key: 'amount', width: 16 },
  ];
  detail.getRow(1).font = { bold: true };
  detail.views = [{ state: 'frozen', ySplit: 1 }];

  for (const bill of priced.bills) {
    for (const line of bill.lines) {
      const row = detail.addRow({
        bill: bill.bill,
        slNo: line.slNo ?? '',
        description: line.description,
        unit: line.unit ?? '',
        qty: line.qty,
        directTotal: line.directTotal,
        sellRate: line.sellRate,
        amount: line.amount,
      });
      for (const key of ['directTotal', 'sellRate', 'amount']) {
        row.getCell(key).numFmt = moneyFormat;
      }
    }
  }

  const margins = wb.addWorksheet('Margins');
  margins.columns = [
    { header: 'Uplift', key: 'label', width: 24 },
    { header: 'Applied', key: 'value', width: 12 },
  ];
  margins.getRow(1).font = { bold: true };
  const uplifts: [string, number][] = [
    ['Overhead', estimate.overheadPct],
    ['Margin', estimate.marginPct],
    ['Financing', estimate.financingPct],
    ['Contingency', estimate.contingencyPct],
    ['Customs', estimate.customsPct],
    ['Corporate tax', estimate.corporateTaxPct],
    ['Design', estimate.designPct],
    ['Commission', estimate.commissionPct],
  ];
  for (const [label, value] of uplifts) {
    const row = margins.addRow({ label, value });
    row.getCell('value').numFmt = '0.00%';
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const stem = `${estimate.jobNumber} ${estimate.revision} ${estimate.name}`.replace(UNSAFE, '-');
  return { buffer, filename: `${stem.trim()}.xlsx` };
}
