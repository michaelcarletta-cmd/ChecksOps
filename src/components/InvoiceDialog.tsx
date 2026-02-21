import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { FileText, Plus, Trash2, Download, Send, Loader2, Link, Copy, CheckCircle } from "lucide-react";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

interface CompanyBranding {
  company_name: string | null;
  company_address: string | null;
  company_phone: string | null;
  company_email: string | null;
  letterhead_url: string | null;
}

interface InvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  claimId?: string;
  claimNumber?: string;
  defaultRecipient?: {
    name: string;
    email?: string;
    address?: string;
  };
  onSuccess?: () => void;
}

export function InvoiceDialog({
  open,
  onOpenChange,
  claimId,
  claimNumber,
  defaultRecipient,
  onSuccess,
}: InvoiceDialogProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isCreatingPaymentLink, setIsCreatingPaymentLink] = useState(false);
  const [paymentLink, setPaymentLink] = useState<string | null>(null);
  const [companyBranding, setCompanyBranding] = useState<CompanyBranding | null>(null);
  const [formData, setFormData] = useState({
    invoiceNumber: `INV-${Date.now().toString().slice(-8)}`,
    invoiceDate: format(new Date(), "yyyy-MM-dd"),
    dueDate: format(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), "yyyy-MM-dd"),
    recipientName: defaultRecipient?.name || "",
    recipientEmail: defaultRecipient?.email || "",
    recipientAddress: defaultRecipient?.address || "",
    notes: "",
  });
  const [lineItems, setLineItems] = useState<InvoiceLineItem[]>([
    { description: "", quantity: 1, unitPrice: 0 },
  ]);
  const [generatedPdfUrl, setGeneratedPdfUrl] = useState<string | null>(null);

  // Load company branding on mount
  useEffect(() => {
    const loadBranding = async () => {
      const { data } = await supabase
        .from('company_branding')
        .select('company_name, company_address, company_phone, company_email, letterhead_url')
        .limit(1)
        .single();
      
      if (data) {
        setCompanyBranding(data);
      }
    };
    loadBranding();
  }, []);

  const addLineItem = () => {
    setLineItems([...lineItems, { description: "", quantity: 1, unitPrice: 0 }]);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) {
      setLineItems(lineItems.filter((_, i) => i !== index));
    }
  };

  const updateLineItem = (index: number, field: keyof InvoiceLineItem, value: string | number) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], [field]: value };
    setLineItems(updated);
  };

  const calculateSubtotal = () => {
    return lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  };

  const generateInvoicePdf = async () => {
    if (!formData.recipientName || lineItems.some(item => !item.description || item.unitPrice <= 0)) {
      toast.error("Please fill in recipient name and all line item details");
      return;
    }

    setIsGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-invoice", {
        body: {
          invoiceNumber: formData.invoiceNumber,
          invoiceDate: formData.invoiceDate,
          dueDate: formData.dueDate,
          // Send company branding as sender
          sender: companyBranding ? {
            name: companyBranding.company_name || '',
            email: companyBranding.company_email || '',
            phone: companyBranding.company_phone || '',
            address: companyBranding.company_address || '',
            logoUrl: companyBranding.letterhead_url || '',
          } : null,
          recipient: {
            name: formData.recipientName,
            email: formData.recipientEmail,
            address: formData.recipientAddress,
          },
          lineItems,
          subtotal: calculateSubtotal(),
          notes: formData.notes,
          claimNumber,
          claimId,
        },
      });

      if (error) throw error;

      if (data?.pdfUrl) {
        setGeneratedPdfUrl(data.pdfUrl);
        toast.success("Invoice generated successfully");
      }
    } catch (err: any) {
      console.error("Invoice generation error:", err);
      toast.error(err.message || "Failed to generate invoice");
    } finally {
      setIsGenerating(false);
    }
  };

  const generatePaymentLink = async () => {
    const total = calculateSubtotal();
    if (total <= 0) {
      toast.error("Total must be greater than $0");
      return;
    }

    setIsCreatingPaymentLink(true);
    try {
      const { data, error } = await supabase.functions.invoke("collect-payment", {
        body: {
          amount: total,
          description: `Invoice ${formData.invoiceNumber}`,
          customerEmail: formData.recipientEmail || undefined,
          customerName: formData.recipientName,
          invoiceNumber: formData.invoiceNumber,
          claimNumber,
        },
      });

      if (error) throw error;
      if (data?.success === false) throw new Error(data.error);

      setPaymentLink(data.url);
      await navigator.clipboard.writeText(data.url);
      toast.success("Payment link created & copied to clipboard!");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create payment link";
      toast.error(message);
    } finally {
      setIsCreatingPaymentLink(false);
    }
  };

  const sendInvoiceEmail = async () => {
    if (!formData.recipientEmail) {
      toast.error("Recipient email is required to send invoice");
      return;
    }

    setIsSending(true);
    try {
      const paymentButton = paymentLink
        ? `<p style="margin: 24px 0;"><a href="${paymentLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Pay Online — $${calculateSubtotal().toFixed(2)}</a></p>`
        : "";

      const emailBody = `<h2>Invoice ${formData.invoiceNumber}</h2>
<p>Dear ${formData.recipientName},</p>
<p>Please find your invoice details below.</p>
<p><strong>Amount Due:</strong> $${calculateSubtotal().toFixed(2)}</p>
<p><strong>Due Date:</strong> ${format(new Date(formData.dueDate), "MMMM d, yyyy")}</p>
${formData.notes ? `<p><strong>Notes:</strong> ${formData.notes}</p>` : ""}
${paymentButton}
${!paymentLink ? "" : `<p style="font-size: 12px; color: #666;">Or copy this link: ${paymentLink}</p>`}
<p>Thank you for your business.</p>`;

      const { error } = await supabase.functions.invoke("send-email", {
        body: {
          to: formData.recipientEmail,
          recipientName: formData.recipientName,
          subject: `Invoice ${formData.invoiceNumber}${claimNumber ? ` - Claim ${claimNumber}` : ""}`,
          body: emailBody,
          claimId,
        },
      });

      if (error) throw error;

      toast.success(`Invoice${paymentLink ? " with payment link" : ""} sent to ${formData.recipientEmail}`);
      onOpenChange(false);
      onSuccess?.();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to send invoice";
      toast.error(message);
    } finally {
      setIsSending(false);
    }
  };

  const downloadInvoice = () => {
    if (generatedPdfUrl) {
      // Fetch the HTML and open in a new window with print styling
      fetch(generatedPdfUrl)
        .then(res => res.text())
        .then(html => {
          const printWindow = window.open('', '_blank');
          if (printWindow) {
            printWindow.document.write(html);
            printWindow.document.close();
          }
        })
        .catch(() => {
          // Fallback to direct open
          window.open(generatedPdfUrl, "_blank");
        });
    }
  };

  const resetForm = () => {
    setFormData({
      invoiceNumber: `INV-${Date.now().toString().slice(-8)}`,
      invoiceDate: format(new Date(), "yyyy-MM-dd"),
      dueDate: format(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), "yyyy-MM-dd"),
      recipientName: defaultRecipient?.name || "",
      recipientEmail: defaultRecipient?.email || "",
      recipientAddress: defaultRecipient?.address || "",
      notes: "",
    });
    setLineItems([{ description: "", quantity: 1, unitPrice: 0 }]);
    setGeneratedPdfUrl(null);
    setPaymentLink(null);
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { onOpenChange(value); if (!value) resetForm(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Create Invoice
            {claimNumber && <span className="text-muted-foreground text-sm ml-2">Claim #{claimNumber}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Invoice Details */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label>Invoice Number</Label>
              <Input
                value={formData.invoiceNumber}
                onChange={(e) => setFormData({ ...formData, invoiceNumber: e.target.value })}
              />
            </div>
            <div>
              <Label>Invoice Date</Label>
              <Input
                type="date"
                value={formData.invoiceDate}
                onChange={(e) => setFormData({ ...formData, invoiceDate: e.target.value })}
              />
            </div>
            <div>
              <Label>Due Date</Label>
              <Input
                type="date"
                value={formData.dueDate}
                onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
              />
            </div>
          </div>

          {/* Recipient Details */}
          <div className="space-y-4">
            <h3 className="font-medium">Bill To</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name *</Label>
                <Input
                  value={formData.recipientName}
                  onChange={(e) => setFormData({ ...formData, recipientName: e.target.value })}
                  placeholder="Recipient name"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  value={formData.recipientEmail}
                  onChange={(e) => setFormData({ ...formData, recipientEmail: e.target.value })}
                  placeholder="Email for sending invoice"
                />
              </div>
            </div>
            <div>
              <Label>Address</Label>
              <Textarea
                value={formData.recipientAddress}
                onChange={(e) => setFormData({ ...formData, recipientAddress: e.target.value })}
                placeholder="Billing address"
                rows={2}
              />
            </div>
          </div>

          {/* Line Items */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-medium">Line Items</h3>
              <Button variant="outline" size="sm" onClick={addLineItem}>
                <Plus className="h-4 w-4 mr-1" />
                Add Item
              </Button>
            </div>
            <div className="space-y-3">
              {lineItems.map((item, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-6">
                    {index === 0 && <Label className="text-xs">Description</Label>}
                    <Input
                      value={item.description}
                      onChange={(e) => updateLineItem(index, "description", e.target.value)}
                      placeholder="Service or item description"
                    />
                  </div>
                  <div className="col-span-2">
                    {index === 0 && <Label className="text-xs">Qty</Label>}
                    <Input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => updateLineItem(index, "quantity", parseInt(e.target.value) || 1)}
                    />
                  </div>
                  <div className="col-span-2">
                    {index === 0 && <Label className="text-xs">Unit Price</Label>}
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={item.unitPrice}
                      onChange={(e) => updateLineItem(index, "unitPrice", parseFloat(e.target.value) || 0)}
                    />
                  </div>
                  <div className="col-span-1 text-right font-medium text-sm py-2">
                    ${(item.quantity * item.unitPrice).toFixed(2)}
                  </div>
                  <div className="col-span-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeLineItem(index)}
                      disabled={lineItems.length === 1}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end pt-2 border-t">
              <div className="text-right">
                <span className="text-muted-foreground mr-4">Total:</span>
                <span className="text-xl font-bold">${calculateSubtotal().toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label>Notes (optional)</Label>
            <Textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Additional notes or payment instructions..."
              rows={2}
            />
          </div>

          {/* Payment Link */}
          {paymentLink && (
            <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg border">
              <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
              <span className="text-sm truncate flex-1">{paymentLink}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(paymentLink);
                  toast.success("Payment link copied!");
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-4 border-t">
            <Button
              variant="outline"
              onClick={generatePaymentLink}
              disabled={isCreatingPaymentLink || calculateSubtotal() <= 0 || !formData.recipientName}
              className="flex-1"
            >
              {isCreatingPaymentLink ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : paymentLink ? (
                <>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Link Created
                </>
              ) : (
                <>
                  <Link className="h-4 w-4 mr-2" />
                  Collect Payment
                </>
              )}
            </Button>

            <Button
              onClick={generateInvoicePdf}
              disabled={isGenerating || !formData.recipientName}
              variant="outline"
              className="flex-1"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <FileText className="h-4 w-4 mr-2" />
                  Generate PDF
                </>
              )}
            </Button>

            {generatedPdfUrl && (
              <Button variant="outline" onClick={downloadInvoice}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            )}

            <Button
              onClick={sendInvoiceEmail}
              disabled={isSending || !formData.recipientEmail}
              className="flex-1"
            >
              {isSending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  {paymentLink ? "Send with Payment Link" : "Send Invoice"}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
