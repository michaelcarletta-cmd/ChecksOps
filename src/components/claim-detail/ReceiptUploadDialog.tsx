import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { Camera, FileUp, Loader2, Receipt, AlertTriangle, CheckCircle2, Copy } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { CrudDropdown } from "./CrudDropdown";
import { PaymentMethodForm } from "./PaymentMethodForm";

interface ExtractedReceipt {
  vendor_name: string | null;
  date: string | null;
  total: number | null;
  suggested_category: string;
  needs_review: boolean;
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
  const [extracted, setExtracted] = useState<ExtractedReceipt | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [editVendor, setEditVendor] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editTotal, setEditTotal] = useState("");
  const [editCategory, setEditCategory] = useState("other");
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [selectedPayeeId, setSelectedPayeeId] = useState("");
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = () => {
    setExtracted(null);
    setPreviewUrl(null);
    setReceiptFile(null);
    setExtracting(false);
    setSaving(false);
    setDuplicateWarning(null);
    setEditVendor("");
    setEditDate("");
    setEditTotal("");
    setEditCategory("other");
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
      const base64 = await fileToBase64(file);
      const response = await supabase.functions.invoke('extract-receipt', {
        body: { imageBase64: base64, mimeType: file.type },
      });
      if (response.error) throw new Error(response.error.message);
      const result = response.data;
      if (!result.success) throw new Error(result.error || 'Extraction failed');

      const data = result.data as ExtractedReceipt;
      setExtracted(data);
      setEditVendor(data.vendor_name || "");
      setEditDate(data.date || format(new Date(), "yyyy-MM-dd"));
      setEditTotal(data.total != null ? data.total.toFixed(2) : "");
      setEditCategory(data.suggested_category || "other");

      // Check for duplicate
      const dupMsg = checkForDuplicate(data.vendor_name, data.date, data.total);
      setDuplicateWarning(dupMsg);

      if (dupMsg) {
        toast.warning("Possible duplicate receipt detected");
      } else if (data.needs_review) {
        toast.warning("Total unclear — please verify before saving");
      } else {
        toast.success("Receipt extracted successfully");
      }
    } catch (err: any) {
      console.error("Receipt extraction error:", err);
      toast.error("Failed to extract receipt: " + (err.message || "Unknown error"));
    } finally {
      setExtracting(false);
    }
  };

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

  const totalValue = parseFloat(editTotal);
  const canSave = editTotal !== "" && !isNaN(totalValue) && totalValue > 0;

  const handleSaveExpense = async () => {
    if (!canSave) {
      toast.error("Please enter a valid total amount");
      return;
    }

    // Re-check duplicate with edited values
    const dupMsg = checkForDuplicate(editVendor, editDate, totalValue);
    if (dupMsg) {
      const confirmed = window.confirm(`${dupMsg}\n\nDo you still want to add this expense?`);
      if (!confirmed) return;
    }

    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const expenseDate = editDate || format(new Date(), "yyyy-MM-dd");

      let receiptFilePath: string | null = null;
      if (receiptFile) {
        // Check for duplicate file (same name + size)
        const { data: existingFiles } = await supabase
          .from('claim_files')
          .select('id, file_name, file_path, folder_id')
          .eq('claim_id', claimId)
          .eq('file_name', receiptFile.name)
          .eq('file_size', receiptFile.size);

        if (existingFiles && existingFiles.length > 0) {
          receiptFilePath = existingFiles[0].file_path;
          toast.info("File already exists in claim — linking existing copy");
        } else {
          const fileExt = receiptFile.name.split('.').pop();
          const fileName = `${claimId}/receipts/${Date.now()}.${fileExt}`;
          const { error: uploadError } = await supabase.storage
            .from('claim-files')
            .upload(fileName, receiptFile);
          if (!uploadError) {
            receiptFilePath = fileName;

            const receiptDate = editDate ? new Date(editDate) : new Date();
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

      const catInfo = EXPENSE_CATEGORIES.find(c => c.value === editCategory);
      const { error } = await supabase.from("claim_loss_of_use_expenses").insert({
        claim_id: claimId,
        expense_category: editCategory,
        expense_date: expenseDate,
        vendor_name: editVendor || null,
        description: editVendor
          ? `${catInfo?.label || editCategory} — ${editVendor}`
          : catInfo?.label || editCategory,
        amount: totalValue,
        receipt_file_path: receiptFilePath,
        receipt_file_name: receiptFile?.name || null,
        created_by: userData.user?.id,
      } as any);

      if (error) throw error;

      toast.success(`Added $${totalValue.toFixed(2)} expense from ${editVendor || 'receipt'}`);
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

        {!extracted && !extracting && (
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

        {extracted && (
          <div className="space-y-4">
            {/* Duplicate warning */}
            {duplicateWarning && (
              <div className="flex items-center gap-2 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 rounded-lg p-3 text-sm">
                <Copy className="h-4 w-4 flex-shrink-0" />
                <span>{duplicateWarning}</span>
              </div>
            )}

            {/* Needs Review banner */}
            {extracted.needs_review && !duplicateWarning && (
              <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 rounded-lg p-3 text-sm">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                <span>Total unclear or ambiguous — please verify the amount below before saving.</span>
              </div>
            )}

            {!extracted.needs_review && !duplicateWarning && extracted.total != null && (
              <div className="flex items-center gap-2 bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300 rounded-lg p-3 text-sm">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                <span>Extracted successfully. Review and confirm.</span>
              </div>
            )}

            {receiptFile && (
              <div className="text-xs text-muted-foreground bg-muted/50 rounded px-2.5 py-1.5 truncate">
                📄 Document: <span className="font-medium text-foreground">{receiptFile.name}</span>
              </div>
            )}

            {previewUrl && (
              <div className="flex justify-center">
                <img src={previewUrl} alt="Receipt" className="max-h-40 rounded-lg border" />
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Vendor Name</Label>
                <Input value={editVendor} onChange={(e) => setEditVendor(e.target.value)} placeholder="Store name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Date</Label>
                  <Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Total Charged *</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={editTotal}
                    onChange={(e) => setEditTotal(e.target.value)}
                    className={extracted.needs_review && !editTotal ? "border-amber-400" : ""}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={editCategory} onValueChange={setEditCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EXPENSE_CATEGORIES.map(cat => (
                      <SelectItem key={cat.value} value={cat.value}>{cat.icon} {cat.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={resetState}>Upload Different Receipt</Button>
              <Button
                className="flex-1"
                onClick={handleSaveExpense}
                disabled={saving || !canSave}
                variant={duplicateWarning ? "destructive" : "default"}
              >
                {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                {duplicateWarning ? "Add Anyway" : `Add Expense — $${canSave ? totalValue.toFixed(2) : '0.00'}`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
