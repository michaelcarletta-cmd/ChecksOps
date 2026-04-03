import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Loader2, Mail, Truck } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface OCWPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientName: string;
  recipientEmail?: string;
  recipientType: "contractor" | "client" | "referrer" | "other";
  claimId?: string;
  defaultAmount?: number;
  onSuccess?: () => void;
}

export function OCWPaymentDialog({
  open,
  onOpenChange,
  recipientName,
  recipientEmail,
  recipientType,
  claimId,
  defaultAmount,
  onSuccess,
}: OCWPaymentDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [deliveryMethod, setDeliveryMethod] = useState<"digital" | "physical">("digital");
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    amount: defaultAmount?.toString() || "",
    description: "",
    email: recipientEmail || "",
    line_1: "",
    line_2: "",
    city: "",
    state: "",
    zip: "",
  });

  useEffect(() => {
    if (open) {
      supabase.from("company_branding" as any).select("online_check_writer_bank_account_id").limit(1).maybeSingle().then(({ data }) => {
        if (data) setBankAccountId((data as any).online_check_writer_bank_account_id || null);
      });
    }
  }, [open]);

  const handleSend = async () => {
    if (!formData.amount || Number(formData.amount) <= 0) {
      toast.error("Enter a valid amount");
      return;
    }

    if (deliveryMethod === "digital" && !formData.email) {
      toast.error("Email is required for digital checks");
      return;
    }

    if (deliveryMethod === "physical" && (!formData.line_1 || !formData.city || !formData.state || !formData.zip)) {
      toast.error("Full mailing address is required for physical checks");
      return;
    }

    setIsLoading(true);
    try {
      const payload: Record<string, unknown> = {
        action: deliveryMethod === "digital" ? "send-digital" : "send-physical",
        recipientName,
        recipientEmail: formData.email,
        amount: Number(formData.amount),
        description: formData.description || undefined,
        recipientType,
        claimId,
      };

      if (deliveryMethod === "physical") {
        payload.recipientAddress = {
          line_1: formData.line_1,
          line_2: formData.line_2,
          city: formData.city,
          state: formData.state,
          zip: formData.zip,
        };
      }

      const { data, error } = await supabase.functions.invoke("ocw-send-check", {
        body: payload,
      });

      if (error) throw error;
      if (data?.success === false) throw new Error(data.error || "Failed to send check");

      toast.success(
        `Check #${data.checkNumber} sent to ${recipientName} via ${deliveryMethod === "digital" ? "email" : "mail"}!`
      );
      onOpenChange(false);
      onSuccess?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to send check";
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send Check — {recipientName}</DialogTitle>
        </DialogHeader>

        <Tabs value={deliveryMethod} onValueChange={(v) => setDeliveryMethod(v as "digital" | "physical")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="digital" className="flex items-center gap-2">
              <Mail className="h-4 w-4" /> Digital (Email)
            </TabsTrigger>
            <TabsTrigger value="physical" className="flex items-center gap-2">
              <Truck className="h-4 w-4" /> Physical (Mail)
            </TabsTrigger>
          </TabsList>

          <div className="space-y-4 mt-4">
            <div>
              <Label>Amount *</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
              />
            </div>

            <div>
              <Label>Description / Memo</Label>
              <Textarea
                placeholder="Payment memo"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <TabsContent value="digital" className="mt-0 space-y-4">
              <div>
                <Label>Recipient Email *</Label>
                <Input
                  type="email"
                  placeholder="recipient@email.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
            </TabsContent>

            <TabsContent value="physical" className="mt-0 space-y-4">
              <div>
                <Label>Address Line 1 *</Label>
                <Input
                  placeholder="123 Main St"
                  value={formData.line_1}
                  onChange={(e) => setFormData({ ...formData, line_1: e.target.value })}
                />
              </div>
              <div>
                <Label>Address Line 2</Label>
                <Input
                  placeholder="Suite 100"
                  value={formData.line_2}
                  onChange={(e) => setFormData({ ...formData, line_2: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label>City *</Label>
                  <Input
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  />
                </div>
                <div>
                  <Label>State *</Label>
                  <Input
                    maxLength={2}
                    placeholder="FL"
                    value={formData.state}
                    onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                  />
                </div>
                <div>
                  <Label>ZIP *</Label>
                  <Input
                    placeholder="33101"
                    value={formData.zip}
                    onChange={(e) => setFormData({ ...formData, zip: e.target.value })}
                  />
                </div>
              </div>
            </TabsContent>

            <Button onClick={handleSend} disabled={isLoading} className="w-full">
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Sending...
                </>
              ) : (
                `Send ${deliveryMethod === "digital" ? "Digital" : "Physical"} Check`
              )}
            </Button>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
