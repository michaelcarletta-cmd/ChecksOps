/**
 * Recipient report files (owner 2026-11-15: "We also need to be able to create excel and pdf reports
 * for this."): Excel (.xlsx, amounts stay numbers in currency format) and PDF (landscape letter,
 * header repeated on every page, totals on the last), as the Deposited Checks export does
 * (src/lib/depositedChecksExport.ts). Two reports:
 *  - one recipient: the drill-down rows as shown (direction filter and client search applied), with
 *    Sent, Received and Net totals;
 *  - the Per-Recipient Detail report: the recipient rows as shown (search and type filters applied),
 *    with a grand total.
 * The builders are pure and the writers return bytes; the caller downloads them (downloadReportFile).
 */
import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import { format } from "date-fns";
import { DEPOSITED_CHECKS_CURRENCY_FORMAT } from "../depositedChecksExport.ts";
import { drilldownTotals, type DrilldownFilter, type RecipientTransaction } from "./recipientDrilldown.ts";

export const RECIPIENT_REPORT_CURRENCY_FORMAT = DEPOSITED_CHECKS_CURRENCY_FORMAT;
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PDF_MIME = "application/pdf";

export type ReportCell = string | number;

export interface ReportColumn {
  label: string;
  /** Excel column width (characters). */
  width: number;
  /** Share of the PDF table width. */
  pdf: number;
  /** A money column: numbers in currency format, right aligned. */
  money?: boolean;
}

export interface ReportTable {
  sheetName: string;
  /** Company, report and recipient. */
  title: string;
  /** Filters and the date range. */
  subtitle: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  /** Shown after the rows, in bold (the last page of the PDF). */
  totals: ReportCell[][];
  note?: string;
}

const centsOf = (n: number) => Math.round(Number(n || 0) * 100);

/** "$1,234.50", "-$75.00". */
export const reportMoney = (n: number): string => {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${abs}`;
};

const reportDate = (at: string | null | undefined): string => {
  const d = at ? new Date(at) : null;
  return d && Number.isFinite(d.getTime()) ? format(d, "MM/dd/yyyy") : "";
};

/** A safe file name: lower-case words joined by "-", at most 120 characters, then the extension. */
export function reportFileName(parts: Array<string | null | undefined>, ext: "xlsx" | "pdf"): string {
  const slug = parts
    .map((p) => String(p ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-")
    .slice(0, 120)
    .replace(/-+$/g, "");
  return `${slug || "report"}.${ext}`;
}

const joinTitle = (...parts: Array<string | null | undefined>) => parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(" – ");

export const DRILLDOWN_FILTER_LABELS: Record<DrilldownFilter, string> = {
  all: "All transactions",
  sent: "Sent only",
  received: "Received only",
};

export const RECIPIENT_DRILLDOWN_COLUMNS: ReportColumn[] = [
  { label: "Date", width: 12, pdf: 70 },
  { label: "Direction", width: 11, pdf: 62 },
  { label: "Client", width: 28, pdf: 150 },
  { label: "Amount", width: 14, pdf: 82, money: true },
  { label: "Method", width: 16, pdf: 90 },
  { label: "Status", width: 12, pdf: 70 },
  { label: "Reference", width: 30, pdf: 188 },
];

/**
 * One recipient's transactions as the drill-down shows them (pass the rows after the client search
 * and the direction filter). Amounts are positive with the direction beside them; totals count what
 * the sheet counts (settled sent, received not returned), so a returned row is listed, not totaled.
 */
export function recipientDrilldownTable(input: {
  recipient: string;
  transactions: RecipientTransaction[];
  filter: DrilldownFilter;
  search?: string | null;
  rangeLabel: string;
  companyName?: string | null;
}): ReportTable {
  const totals = drilldownTotals(input.transactions);
  const search = String(input.search ?? "").trim();
  const amountCol = RECIPIENT_DRILLDOWN_COLUMNS.findIndex((c) => c.label === "Amount");
  const totalRow = (label: string, value: number): ReportCell[] =>
    RECIPIENT_DRILLDOWN_COLUMNS.map((_c, i) => (i === 0 ? label : i === amountCol ? value : ""));
  const out: ReportCell[][] = [];
  if (input.filter !== "received") out.push(totalRow(`Total sent (${totals.sent.count})`, totals.sent.total));
  if (input.filter !== "sent") out.push(totalRow(`Total received (${totals.received.count})`, totals.received.total));
  out.push(totalRow("Net (received - sent)", totals.net));
  return {
    sheetName: "Recipient",
    title: joinTitle(input.companyName, `Recipient: ${input.recipient}`),
    subtitle: joinTitle(DRILLDOWN_FILTER_LABELS[input.filter], search ? `matching "${search}"` : null, input.rangeLabel),
    columns: RECIPIENT_DRILLDOWN_COLUMNS,
    rows: input.transactions.map((t) => [
      reportDate(t.date),
      t.direction === "sent" ? "Sent" : "Received",
      t.clientName ?? "",
      Number(t.amount || 0),
      t.methodLabel,
      t.counted ? t.statusLabel : `${t.statusLabel} (not totaled)`,
      t.reference ?? "",
    ]),
    totals: out,
    note: "Totals count settled payments sent and payments received that were not returned.",
  };
}

/** A Per-Recipient Detail row as the report lists it. */
export interface RecipientSummaryRow {
  name: string;
  type?: string | null;
  types?: string[] | null;
  count: number;
  total: number;
  last?: string | null;
}

export const RECIPIENT_REPORT_COLUMNS: ReportColumn[] = [
  { label: "Recipient", width: 34, pdf: 230 },
  { label: "Type(s)", width: 24, pdf: 170 },
  { label: "Payments", width: 11, pdf: 70 },
  { label: "Total Paid", width: 16, pdf: 120, money: true },
  { label: "Last Paid", width: 13, pdf: 122 },
];

/** The Per-Recipient Detail report as shown (search and type filters applied), with a grand total. */
export function recipientReportTable(input: {
  rows: RecipientSummaryRow[];
  typeLabel: (type: string) => string;
  rangeLabel: string;
  typeFilterLabel?: string | null;
  search?: string | null;
  companyName?: string | null;
}): ReportTable {
  const search = String(input.search ?? "").trim();
  const cents = input.rows.reduce((sum, r) => sum + centsOf(r.total), 0);
  const count = input.rows.reduce((sum, r) => sum + Number(r.count || 0), 0);
  return {
    sheetName: "Per-Recipient Detail",
    title: joinTitle(input.companyName, "Per-Recipient Detail"),
    subtitle: joinTitle(input.typeFilterLabel || "All types", search ? `matching "${search}"` : null, input.rangeLabel),
    columns: RECIPIENT_REPORT_COLUMNS,
    rows: input.rows.map((r) => [
      r.name,
      (r.types?.length ? r.types : [r.type ?? "other"]).map((t) => input.typeLabel(String(t))).join(" / "),
      Number(r.count || 0),
      Number(r.total || 0),
      reportDate(r.last),
    ]),
    totals: [[`Grand total (${input.rows.length} recipient${input.rows.length === 1 ? "" : "s"})`, "", count, cents / 100, ""]],
    note: "Total Paid counts settled payments.",
  };
}

/** Rows of the sheet: title, subtitle, header, then the rows, the totals and the note. */
export const REPORT_FIRST_ROW = 4;

export async function reportTableXlsx(table: ReportTable): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  book.title = table.title;
  const sheet = book.addWorksheet(table.sheetName);
  sheet.columns = table.columns.map((c) => ({ width: c.width }));
  sheet.addRow([table.title]).font = { bold: true, size: 13 };
  sheet.addRow([table.subtitle]);
  sheet.addRow(table.columns.map((c) => c.label)).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: REPORT_FIRST_ROW - 1 }];
  for (const row of table.rows) sheet.addRow(row);
  for (const row of table.totals) sheet.addRow(row).font = { bold: true };
  if (table.note) sheet.addRow([table.note]).font = { italic: true };
  const last = REPORT_FIRST_ROW + table.rows.length + table.totals.length - 1;
  table.columns.forEach((c, i) => {
    if (!c.money) return;
    for (let r = REPORT_FIRST_ROW; r <= last; r += 1) {
      const cell = sheet.getCell(r, i + 1);
      if (typeof cell.value === "number") cell.numFmt = RECIPIENT_REPORT_CURRENCY_FORMAT;
    }
  });
  return new Uint8Array(await book.xlsx.writeBuffer());
}

export function reportTablePdf(table: ReportTable): Uint8Array {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const usable = pageWidth - margin * 2;
  const share = table.columns.reduce((s, c) => s + c.pdf, 0) || 1;
  const widths = table.columns.map((c) => (c.pdf / share) * usable);
  const xs = widths.reduce<number[]>((acc, _w, i) => [...acc, i === 0 ? margin : acc[i - 1] + widths[i - 1]], []);
  const rowHeight = 18;
  const fit = (value: string, width: number) => {
    const max = width - 8;
    if (doc.getTextWidth(value) <= max) return value;
    let cut = value;
    while (cut.length > 1 && doc.getTextWidth(`${cut}…`) > max) cut = cut.slice(0, -1);
    return `${cut}…`;
  };
  /** `width` lets a total's label run over the empty cells after it. */
  const cell = (value: ReportCell, col: number, y: number, width = widths[col]) => {
    const column = table.columns[col];
    const text = typeof value === "number" && column.money ? reportMoney(value) : String(value ?? "");
    if (!text) return;
    const shown = fit(text, width);
    if (column.money || typeof value === "number") doc.text(shown, xs[col] + widths[col] - 6, y, { align: "right" });
    else doc.text(shown, xs[col] + 2, y);
  };
  const headerCell = (col: number, y: number) => {
    const column = table.columns[col];
    if (column.money || column.label === "Payments") doc.text(column.label, xs[col] + widths[col] - 6, y, { align: "right" });
    else doc.text(column.label, xs[col] + 2, y);
  };

  let page = 1;
  let y = margin;
  const header = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    const lines = doc.splitTextToSize(table.title, usable) as string[];
    doc.text(lines, margin, y);
    y += lines.length * 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(fit(table.subtitle, usable - 170), margin, y);
    doc.text(`Generated ${new Date().toLocaleDateString("en-US")}  ·  Page ${page}`, pageWidth - margin, y, { align: "right" });
    y += 22;
    doc.setFont("helvetica", "bold");
    table.columns.forEach((_c, i) => headerCell(i, y));
    doc.setLineWidth(0.5);
    doc.line(margin, y + 5, pageWidth - margin, y + 5);
    doc.setFont("helvetica", "normal");
    y += rowHeight;
  };
  const newPage = () => {
    doc.addPage();
    page += 1;
    y = margin;
    header();
  };
  header();

  if (table.rows.length === 0) {
    doc.text("No rows for this selection.", margin, y);
    y += rowHeight;
  }
  for (const row of table.rows) {
    if (y > pageHeight - margin - rowHeight) newPage();
    row.forEach((value, i) => cell(value, i, y));
    y += rowHeight;
  }
  // The totals stay together on the last page.
  const needed = rowHeight * (table.totals.length + (table.note ? 1 : 0)) + 6;
  if (y + needed > pageHeight - margin) newPage();
  doc.line(margin, y - rowHeight + 6, pageWidth - margin, y - rowHeight + 6);
  doc.setFont("helvetica", "bold");
  for (const row of table.totals) {
    row.forEach((value, i) => {
      if (typeof value === "number") return cell(value, i, y);
      let end = i + 1;
      while (end < row.length && row[end] === "") end += 1;
      cell(value, i, y, widths.slice(i, end).reduce((sum, w) => sum + w, 0));
    });
    y += rowHeight;
  }
  if (table.note) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.text(table.note, margin, y);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
