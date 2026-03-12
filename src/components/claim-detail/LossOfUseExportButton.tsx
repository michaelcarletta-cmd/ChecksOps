import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";

interface LossOfUseExpense {
  id: string;
  expense_category: string;
  expense_date: string;
  vendor_name: string | null;
  description: string;
  amount: number;
  receipt_file_path: string | null;
  is_submitted_to_insurer: boolean;
  submitted_date: string | null;
  is_reimbursed: boolean;
  reimbursed_amount: number | null;
  notes: string | null;
  is_paid: boolean;
  paid_date: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  lodging: "Lodging (Hotel/Rental)",
  meals: "Meals & Food",
  storage: "Storage",
  transportation: "Transportation/Gas",
  laundry: "Laundry",
  pet_boarding: "Pet Boarding",
  other: "Other ALE",
};

interface LossOfUseExportButtonProps {
  expenses: LossOfUseExpense[];
  claimNumber?: string;
}

export const LossOfUseExportButton = ({ expenses, claimNumber }: LossOfUseExportButtonProps) => {
  const [exporting, setExporting] = useState(false);

  const fetchReceiptImage = async (filePath: string): Promise<ArrayBuffer | null> => {
    try {
      const { data, error } = await supabase.storage
        .from("claim-files")
        .download(filePath);
      if (error || !data) return null;
      return await data.arrayBuffer();
    } catch {
      return null;
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Freedom Claims";
      workbook.created = new Date();

      const sheet = workbook.addWorksheet("ALE Expenses", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      // Define columns
      sheet.columns = [
        { header: "Date", key: "date", width: 14 },
        { header: "Month", key: "month", width: 16 },
        { header: "Category", key: "category", width: 22 },
        { header: "Vendor", key: "vendor", width: 22 },
        { header: "Description", key: "description", width: 30 },
        { header: "Amount", key: "amount", width: 14 },
        { header: "Paid", key: "paid", width: 10 },
        { header: "Submitted", key: "submitted", width: 12 },
        { header: "Reimbursed", key: "reimbursed", width: 14 },
        { header: "Notes", key: "notes", width: 25 },
        { header: "Receipt", key: "receipt", width: 20 },
      ];

      // Style header row
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
      headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2563EB" },
      };
      headerRow.alignment = { vertical: "middle" };

      // Sort expenses by date
      const sorted = [...expenses].sort(
        (a, b) => new Date(a.expense_date).getTime() - new Date(b.expense_date).getTime()
      );

      // Add rows and embed receipt images
      for (let i = 0; i < sorted.length; i++) {
        const exp = sorted[i];
        const expDate = new Date(exp.expense_date);
        const monthLabel = expDate.toLocaleString("en-US", { month: "long", year: "numeric" });

        const row = sheet.addRow({
          date: exp.expense_date,
          month: monthLabel,
          category: CATEGORY_LABELS[exp.expense_category] || exp.expense_category,
          vendor: exp.vendor_name || "",
          description: exp.description,
          amount: exp.amount,
          paid: exp.is_paid ? "Yes" : "No",
          submitted: exp.is_submitted_to_insurer ? "Yes" : "No",
          reimbursed: exp.is_reimbursed ? `$${(exp.reimbursed_amount || 0).toFixed(2)}` : "No",
          notes: exp.notes || "",
          receipt: "",
        });

        // Format amount as currency
        row.getCell("amount").numFmt = '$#,##0.00';

        // Try to embed receipt image
        if (exp.receipt_file_path) {
          const imgBuffer = await fetchReceiptImage(exp.receipt_file_path);
          if (imgBuffer) {
            const ext = exp.receipt_file_path.split(".").pop()?.toLowerCase();
            const extension = ext === "png" ? "png" as const : "jpeg" as const;

            const imageId = workbook.addImage({
              buffer: imgBuffer,
              extension,
            });

            // Row index is i+1 (0-based for data rows, +1 for header)
            const rowNum = i + 2;
            sheet.getRow(rowNum).height = 60;

            sheet.addImage(imageId, {
              tl: { col: 10, row: rowNum - 1 },
              ext: { width: 80, height: 55 },
            });
          }
        }
      }

      // Add totals row
      const totalRow = sheet.addRow({
        date: "",
        month: "",
        category: "",
        vendor: "",
        description: "TOTAL",
        amount: expenses.reduce((s, e) => s + e.amount, 0),
        paid: "",
        submitted: "",
        reimbursed: "",
        notes: "",
        receipt: "",
      });
      totalRow.font = { bold: true };
      totalRow.getCell("amount").numFmt = '$#,##0.00';

      // Category summary sheet
      const summarySheet = workbook.addWorksheet("By Category");
      summarySheet.columns = [
        { header: "Category", key: "category", width: 25 },
        { header: "Count", key: "count", width: 10 },
        { header: "Total", key: "total", width: 16 },
      ];
      const summaryHeader = summarySheet.getRow(1);
      summaryHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
      summaryHeader.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2563EB" },
      };

      const catGroups: Record<string, { count: number; total: number }> = {};
      expenses.forEach((e) => {
        if (!catGroups[e.expense_category]) catGroups[e.expense_category] = { count: 0, total: 0 };
        catGroups[e.expense_category].count++;
        catGroups[e.expense_category].total += e.amount;
      });
      Object.entries(catGroups).forEach(([cat, data]) => {
        const r = summarySheet.addRow({
          category: CATEGORY_LABELS[cat] || cat,
          count: data.count,
          total: data.total,
        });
        r.getCell("total").numFmt = '$#,##0.00';
      });

      // Monthly summary sheet
      const monthSheet = workbook.addWorksheet("By Month");
      monthSheet.columns = [
        { header: "Month", key: "month", width: 22 },
        { header: "Count", key: "count", width: 10 },
        { header: "Total", key: "total", width: 16 },
      ];
      const monthHeader = monthSheet.getRow(1);
      monthHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
      monthHeader.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2563EB" },
      };

      const monthGroups: Record<string, { count: number; total: number }> = {};
      expenses.forEach((e) => {
        const d = new Date(e.expense_date);
        const key = d.toLocaleString("en-US", { month: "long", year: "numeric" });
        if (!monthGroups[key]) monthGroups[key] = { count: 0, total: 0 };
        monthGroups[key].count++;
        monthGroups[key].total += e.amount;
      });
      Object.entries(monthGroups).forEach(([month, data]) => {
        const r = monthSheet.addRow({ month, count: data.count, total: data.total });
        r.getCell("total").numFmt = '$#,##0.00';
      });

      // Generate and download
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const fileName = `ALE_Expenses${claimNumber ? `_${claimNumber}` : ""}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      saveAs(blob, fileName);
      toast.success("Excel exported with receipt images");
    } catch (err: any) {
      console.error("Export error:", err);
      toast.error("Failed to export: " + (err.message || "Unknown error"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting || expenses.length === 0}>
      {exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 mr-1" />}
      Export Excel
    </Button>
  );
};
