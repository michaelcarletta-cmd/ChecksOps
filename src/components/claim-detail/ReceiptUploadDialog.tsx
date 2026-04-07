import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import { Camera, FileUp, Loader2, Receipt, AlertTriangle, CheckCircle2, Copy } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { CrudDropdown } from "./CrudDropdown";
import { PaymentMethodForm } from "./PaymentMethodForm";
import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

const PDF_MIME_TYPE = "application/pdf";

const PDF_PAGE_RENDER_SCALE = 1.1;
const PDF_PAGE_MAX_DIMENSION = 1400;

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] || result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

const renderPdfPageToImageBase64 = async (page: any): Promise<string> => {
  const baseViewport = page.getViewport({ scale: PDF_PAGE_RENDER_SCALE });
  const largestDimension = Math.max(baseViewport.width, baseViewport.height);
  const adjustedScale = largestDimension > PDF_PAGE_MAX_DIMENSION
    ? (PDF_PAGE_RENDER_SCALE * PDF_PAGE_MAX_DIMENSION) / largestDimension
    : PDF_PAGE_RENDER_SCALE;

  const viewport = page.getViewport({ scale: adjustedScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to prepare PDF page for receipt extraction");
  }

  await page.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.72);

  canvas.width = 0;
  canvas.height = 0;
  page.cleanup?.();

  return dataUrl.split(",")[1] || dataUrl;
};

interface ReceiptExtractionPayload {
  imageBase64?: string;
  pageImages?: string[];
  mimeType: string;
}

const buildReceiptExtractionPayloads = async (file: File): Promise<ReceiptExtractionPayload[]> => {
  const isPdf = file.type === PDF_MIME_TYPE || file.name.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return [{
      imageBase64: await fileToBase64(file),
      mimeType: file.type || "image/jpeg",
    }];
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const payloads: ReceiptExtractionPayload[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const imageBase64 = await renderPdfPageToImageBase64(page);
    payloads.push({
      pageImages: [imageBase64],
      mimeType: "image/jpeg",
    });
  }

  return payloads;
};
interface ExtractedReceipt {
  vendor_name: string | null;
  date: string | null;
  total: number | null;
  suggested_category: string;
  needs_review: boolean;
}

interface EditableReceipt extends ExtractedReceipt {
  editVendor: string;
  editDate: string;
  editTotal: string;
  editCategory: string;
  included: boolean;
  duplicateWarning: string | null;
}

interface ExistingExpense {
  vendor_name: string | null;
  expense_date: string;
  amount: number;
}

const EXPENSE_CATEGORIES = [
  { value: "lodging", label: "Lodging (Hotel/Rental)", icon: "🏨" },
  { value: "meals", label: "Meals & Food", icon: "🍽️" },
  { value: "storage", label: "Storage", icon: "📦" },
  { value: "transportation", label: "Transportation/Gas", icon: "🚗" },
  { value: "laundry", label: "Laundry", icon: "🧺" },
  { value: "pet_boarding", label: "Pet Boarding", icon: "🐕" },
  { value: "other", label: "Other ALE", icon: "📋" },
];

interface ReceiptUploadDialogProps {
  claimId: string;
  onExpensesAdded: () => void;
  existingExpenses?: ExistingExpense[];
}

export const ReceiptUploadDialog = ({ claimId, onExpensesAdded, existingExpenses = [] }: ReceiptUploadDialogProps) => {
  const [open, setOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [receipts, setReceipts] = useState<EditableReceipt[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [selectedPayeeId, setSelectedPayeeId] = useState("");
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = () => {
    setReceipts([]);
    setPreviewUrl(null);
    setReceiptFile(null);
    setExtracting(false);
    setSaving(false);
    setSelectedCategoryId("");
    setSelectedPayeeId("");
    setSelectedPaymentMethodId("");
  };

  const checkForDuplicate = (vendor: string | null, date: string | null, total: number | null): string | null => {
    if (!date || total == null) return null;
    const match = existingExpenses.find((e) => {
      const sameDate = e.expense_date === date;
      const sameAmount = Math.abs(e.amount - total) < 0.01;
      const sameVendor = !vendor || !e.vendor_name ||
        e.vendor_name.toLowerCase().trim() === vendor.toLowerCase().trim();
      return sameDate && sameAmount && sameVendor;
    });
    if (match) {
      return `Possible duplicate: $${total.toFixed(2)} on ${date}${match.vendor_name ? ` at ${match.vendor_name}` : ""} already exists.`;
    }
    return null;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setReceiptFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    await extractReceipt(file);
  };

  const extractReceipt = async (file: File) => {
    setExtracting(true);
    try {
      const payloads = await buildReceiptExtractionPayloads(file);
      const extractedReceipts: ExtractedReceipt[] = [];

      for (let i = 0; i < payloads.length; i++) {
        const response = await supabase.functions.invoke("extract-receipt", {
          body: payloads[i],
        });

        if (response.error) {
          const message = await getFunctionErrorMessage(response.error, "Failed to extract receipt");
          throw new Error(payloads.length > 1 ? `Failed on page ${i + 1} of ${payloads.length}: ${message}` : message);
        }

        const result = response.data;
        if (!result.success) {
          throw new Error(result.error || "Extraction failed");
        }

        const pageReceipts: ExtractedReceipt[] = result.data?.receipts || (result.data ? [result.data] : []);
        extractedReceipts.push(...pageReceipts);
      }

      if (extractedReceipts.length === 0) {
        throw new Error("No receipts were found in this file");
      }

      const editableReceipts: EditableReceipt[] = extractedReceipts.map((r: ExtractedReceipt) => ({
        ...r,
        editVendor: r.vendor_name || "",
        editDate: r.date || format(new Date(), "yyyy-MM-dd"),
        editTotal: r.total != null ? r.total.toFixed(2) : "",
        editCategory: r.suggested_category || "other",
        included: true,
        duplicateWarning: checkForDuplicate(r.vendor_name, r.date, r.total),
      }));

      setReceipts(editableReceipts);

      const dupeCount = editableReceipts.filter(r => r.duplicateWarning).length;
      const reviewCount = editableReceipts.filter(r => r.needs_review).length;
      if (dupeCount > 0) toast.warning(`${dupeCount} possible duplicate(s) detected`);
      else if (reviewCount > 0) toast.warning(`${reviewCount} receipt(s) need review`);
      else toast.success(`Extracted ${editableReceipts.length} receipt(s) successfully`);
    } catch (err: any) {
      console.error("Receipt extraction error:", err);
      toast.error("Failed to extract receipt: " + (err.message || "Unknown error"));
    } finally {
      setExtracting(false);
    }
  };

  const updateReceipt = (idx: number, updates: Partial<EditableReceipt>) => {
    setReceipts(prev => prev.map((r, i) => i === idx ? { ...r, ...updates } : r));
  };

  const includedReceipts = receipts.filter(r => r.included);
  const canSave = includedReceipts.length > 0 && includedReceipts.every(r => {
    const v = parseFloat(r.editTotal);
    return r.editTotal !== "" && !isNaN(v) && v > 0;
  });
  const grandTotal = includedReceipts.reduce((sum, r) => sum + (parseFloat(r.editTotal) || 0), 0);

  const handleSaveExpense = async () => {
    if (!canSave) {
      toast.error("Please enter a valid total for all included receipts");
      return;
    }

    const dupeReceipts = includedReceipts.filter(r => {
      const v = parseFloat(r.editTotal);
      return checkForDuplicate(r.editVendor, r.editDate, v);
    });
    if (dupeReceipts.length > 0) {
      const confirmed = window.confirm(
        `${dupeReceipts.length} receipt(s) look like duplicates. Add them anyway?`
      );
      if (!confirmed) return;  
    }

    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();

      // Upload the source file once
      let receiptFilePath: string | null = null;
      if (receiptFile) {
        const { data: existingFiles } = await supabase
          .from('claim_files')
          .select('id, file_name, file_path, folder_id')
          .eq('claim_id', claimId)
          .eq('file_name', receiptFile.name)
          .eq('file_size', receiptFile.size);

        if (existingFiles && existingFiles.length > 0) {
          receiptFilePath = existingFiles[0].file_path;
        } else {
          const fileExt = receiptFile.name.split('.').pop();
          const fileName = `${claimId}/receipts/${Date.now()}.${fileExt}`;
          const { error: uploadError } = await supabase.storage
            .from('claim-files')
            .upload(fileName, receiptFile);
          if (!uploadError) {
            receiptFilePath = fileName;

            const receiptDate = includedReceipts[0]?.editDate ? new Date(includedReceipts[0].editDate) : new Date();
            const monthLabel = receiptDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });
            const subfolderName = `Receipts - ${monthLabel}`;

            let folderId: string | null = null;
            const { data: existingFolder } = await supabase
              .from('claim_folders')
              .select('id')
              .eq('claim_id', claimId)
              .eq('name', subfolderName)
              .maybeSingle();

            if (existingFolder) {
              folderId = existingFolder.id;
            } else {
              const { data: newFolder } = await supabase
                .from('claim_folders')
                .insert({ claim_id: claimId, name: subfolderName, created_by: userData.user?.id })
                .select('id')
                .single();
              folderId = newFolder?.id || null;
            }

            await supabase.from('claim_files').insert({
              claim_id: claimId,
              file_name: receiptFile.name,
              file_path: fileName,
              file_type: receiptFile.type,
              file_size: receiptFile.size,
              folder_id: folderId,
              uploaded_by: userData.user?.id,
              source: 'receipt_scan',
            });
          }
        }
      }

      // Insert all included receipts
      const rows = includedReceipts.map(r => {
        const catInfo = EXPENSE_CATEGORIES.find(c => c.value === r.editCategory);
        const total = parseFloat(r.editTotal);
        return {
          claim_id: claimId,
          expense_category: r.editCategory,
          expense_date: r.editDate || format(new Date(), "yyyy-MM-dd"),
          vendor_name: r.editVendor || null,
          description: r.editVendor
            ? `${catInfo?.label || r.editCategory} — ${r.editVendor}`
            : catInfo?.label || r.editCategory,
          amount: total,
          receipt_file_path: receiptFilePath,
          receipt_file_name: receiptFile?.name || null,
          created_by: userData.user?.id,
        };
      });

      const { error } = await supabase.from("claim_loss_of_use_expenses").insert(rows as any);

      if (error) throw error;

      toast.success(`Added ${rows.length} expense(s) totaling $${grandTotal.toFixed(2)}`);
      resetState();
      setOpen(false);
      onExpensesAdded();
    } catch (err: any) {
      console.error("Save error:", err);
      toast.error("Failed to save expense");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetState(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Camera className="h-4 w-4 mr-1" /> Scan Receipt
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Scan Receipt
          </DialogTitle>
        </DialogHeader>

        {receipts.length === 0 && !extracting && (
          <div className="space-y-4">
            <div
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <FileUp className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="font-medium">Click to upload a receipt</p>
              <p className="text-sm text-muted-foreground mt-1">Supports images (JPG, PNG) and PDFs</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,.pdf"
              onChange={handleFileSelect}
            />
          </div>
        )}

        {extracting && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Analyzing receipt…</p>
            {previewUrl && (
              <img src={previewUrl} alt="Receipt preview" className="max-h-32 rounded-lg opacity-50 mt-2" />
            )}
          </div>
        )}

        {receipts.length > 0 && (
          <div className="space-y-3">
            {receiptFile && (
              <div className="text-xs text-muted-foreground bg-muted/50 rounded px-2.5 py-1.5 truncate">
                📄 Document: <span className="font-medium text-foreground">{receiptFile.name}</span>
                {" · "}{receipts.length} receipt(s) found
              </div>
            )}

            <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
              {receipts.map((r, idx) => {
                const totalVal = parseFloat(r.editTotal);
                const isValid = r.editTotal !== "" && !isNaN(totalVal) && totalVal > 0;
                return (
                  <div
                    key={idx}
                    className={`border rounded-lg p-3 space-y-2 transition-opacity ${r.included ? '' : 'opacity-40'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                        <input
                          type="checkbox"
                          checked={r.included}
                          onChange={(e) => updateReceipt(idx, { included: e.target.checked })}
                          className="rounded"
                        />
                        Receipt {idx + 1}
                        {r.editVendor && <span className="text-muted-foreground font-normal">— {r.editVendor}</span>}
                      </label>
                      {isValid && (
                        <Badge variant="secondary" className="font-mono">${totalVal.toFixed(2)}</Badge>
                      )}
                    </div>

                    {r.duplicateWarning && (
                      <div className="flex items-center gap-1.5 text-xs text-destructive">
                        <Copy className="h-3 w-3" /> {r.duplicateWarning}
                      </div>
                    )}
                    {r.needs_review && !r.duplicateWarning && (
                      <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="h-3 w-3" /> Verify total
                      </div>
                    )}

                    {r.included && (
                      <div className="space-y-2">
                        <Input
                          value={r.editVendor}
                          onChange={(e) => updateReceipt(idx, { editVendor: e.target.value })}
                          placeholder="Vendor name"
                          className="h-8 text-sm"
                        />
                        <div className="grid grid-cols-3 gap-2">
                          <Input
                            type="date"
                            value={r.editDate}
                            onChange={(e) => updateReceipt(idx, { editDate: e.target.value })}
                            className="h-8 text-sm"
                          />
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="Total"
                            value={r.editTotal}
                            onChange={(e) => updateReceipt(idx, { editTotal: e.target.value })}
                            className={`h-8 text-sm ${r.needs_review && !r.editTotal ? "border-amber-400" : ""}`}
                          />
                          <Select value={r.editCategory} onValueChange={(v) => updateReceipt(idx, { editCategory: v })}>
                            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {EXPENSE_CATEGORIES.map(cat => (
                                <SelectItem key={cat.value} value={cat.value}>{cat.icon} {cat.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Shared fields */}
            <div className="space-y-2 border-t pt-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Custom Category</Label>
                  <CrudDropdown
                    table="expenses_categories"
                    labelField="name"
                    value={selectedCategoryId}
                    onValueChange={setSelectedCategoryId}
                    placeholder="Category…"
                    emptyText="No categories yet"
                    dialogTitle="Category"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Paid To</Label>
                  <CrudDropdown
                    table="expenses_payees"
                    labelField="name"
                    value={selectedPayeeId}
                    onValueChange={setSelectedPayeeId}
                    placeholder="Payee…"
                    emptyText="No payees yet"
                    dialogTitle="Payee"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Payment Method</Label>
                  <CrudDropdown
                    table="payment_methods"
                    labelField="label"
                    value={selectedPaymentMethodId}
                    onValueChange={setSelectedPaymentMethodId}
                    placeholder="Method…"
                    emptyText="No methods yet"
                    dialogTitle="Payment Method"
                    transformRow={(row: any) => ({
                      id: row.id,
                      label: row.label,
                      sublabel: row.method_type,
                    })}
                    buildCustomInsert={(fields, userId) => ({
                      label: fields.label,
                      method_type: fields.method_type,
                      card_last_four: fields.card_last_four || null,
                      created_by: userId,
                    })}
                    renderAddForm={(props) => (
                      <PaymentMethodForm
                        onSave={props.onSave}
                        onCancel={props.onCancel}
                        saving={props.saving}
                      />
                    )}
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={resetState}>Upload Different Receipt</Button>
              <Button
                className="flex-1"
                onClick={handleSaveExpense}
                disabled={saving || !canSave || includedReceipts.length === 0}
              >
                {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                {`Add ${includedReceipts.length} Expense(s) — $${canSave ? grandTotal.toFixed(2) : '0.00'}`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
