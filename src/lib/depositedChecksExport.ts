/**
 * Deposited Checks report files: Excel (.xlsx, amounts stay numbers) and PDF (landscape letter,
 * repeated header on every page, total on the last). Both return bytes; the caller downloads them.
 */
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import {
  DEPOSITED_CHECKS_COLUMNS,
  depositedChecksSheetRows,
  depositedChecksTotal,
  formatReportDay,
  formatReportMoney,
  type DepositedCheckRow,
} from "./depositedChecksReport.ts";

export function depositedChecksXlsx(rows: DepositedCheckRow[], title: string): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet(depositedChecksSheetRows(rows));
  // Amount column (C) as currency, from the first check row to the total row.
  for (let r = 1; r <= rows.length + 1; r += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c: 2 })];
    if (cell && typeof cell.v === "number") cell.z = '"$"#,##0.00';
  }
  sheet["!cols"] = [{ wch: 34 }, { wch: 15 }, { wch: 14 }, { wch: 16 }, { wch: 22 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Deposited Checks");
  book.Props = { Title: title };
  return new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}

export function depositedChecksPdf(rows: DepositedCheckRow[], title: string, companyName = ""): Uint8Array {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  // Column x positions and widths: insured name, date, amount (right aligned), check #, claim #.
  const widths = [250, 100, 110, 110, pageWidth - margin * 2 - 570];
  const xs = widths.reduce<number[]>((acc, _w, i) => [...acc, i === 0 ? margin : acc[i - 1] + widths[i - 1]], []);
  const rowHeight = 18;
  const fit = (value: string, width: number) => {
    const max = width - 8;
    if (doc.getTextWidth(value) <= max) return value;
    let cut = value;
    while (cut.length > 1 && doc.getTextWidth(`${cut}…`) > max) cut = cut.slice(0, -1);
    return `${cut}…`;
  };
  const cell = (value: string, col: number, y: number) => {
    const shown = fit(value, widths[col]);
    if (col === 2) doc.text(shown, xs[col] + widths[col] - 6, y, { align: "right" });
    else doc.text(shown, xs[col] + 2, y);
  };

  let page = 1;
  let y = margin;
  const header = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(title, margin, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const sub = [companyName, `Generated ${new Date().toLocaleDateString("en-US")}`, `Page ${page}`].filter(Boolean).join("  ·  ");
    doc.text(sub, pageWidth - margin, y, { align: "right" });
    y += 24;
    doc.setFont("helvetica", "bold");
    DEPOSITED_CHECKS_COLUMNS.forEach((label, i) => cell(label, i, y));
    doc.setLineWidth(0.5);
    doc.line(margin, y + 5, pageWidth - margin, y + 5);
    doc.setFont("helvetica", "normal");
    y += rowHeight;
  };
  header();

  if (rows.length === 0) {
    doc.text("No deposited checks for this selection.", margin, y);
  }
  for (const r of rows) {
    if (y > pageHeight - margin - rowHeight * 2) {
      doc.addPage();
      page += 1;
      y = margin;
      header();
    }
    cell(r.insuredName || "—", 0, y);
    cell(formatReportDay(r.depositedOn), 1, y);
    cell(formatReportMoney(r.amount), 2, y);
    cell(r.checkNumber || "—", 3, y);
    cell(r.claimNumber || "—", 4, y);
    y += rowHeight;
  }
  doc.line(margin, y - rowHeight + 6, pageWidth - margin, y - rowHeight + 6);
  doc.setFont("helvetica", "bold");
  cell(`Total (${rows.length} check${rows.length === 1 ? "" : "s"})`, 0, y);
  cell(formatReportMoney(depositedChecksTotal(rows)), 2, y);
  return new Uint8Array(doc.output("arraybuffer"));
}

/** Browser download of report bytes. */
export function downloadReportFile(bytes: Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
