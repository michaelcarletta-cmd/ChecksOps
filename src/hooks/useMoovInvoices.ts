import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { useToast } from "@/hooks/use-toast";

export interface InvoiceLineItem {
  name: string;
  unit_price: number;
  quantity: number;
}

export interface MoovInvoice {
  id: string;
  tenant_id: string;
  moov_invoice_id: string | null;
  invoice_number: string | null;
  customer_name: string;
  customer_email: string;
  description: string | null;
  line_items: InvoiceLineItem[];
  total_amount: number;
  paid_amount: number;
  status: string;
  invoice_date: string | null;
  due_date: string | null;
  payment_link_url: string | null;
  public_token: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
}

async function callInvoiceFn(payload: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("moov-invoice", { body: payload });
  if (error) {
    // Edge functions return the reason in the body even on non-2xx.
    const detail = (data as any)?.error ?? error.message;
    throw new Error(detail || "Invoice request failed");
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as any;
}

export function useMoovInvoices() {
  const { tenantId } = useTenantFilter();
  const qc = useQueryClient();
  const { toast } = useToast();

  const invalidate = () => qc.invalidateQueries({ queryKey: ["moov-invoices", tenantId] });

  const invoices = useQuery<MoovInvoice[]>({
    queryKey: ["moov-invoices", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("moov_invoices")
        .select("*")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []).map((row: any) => ({
        ...row,
        line_items: Array.isArray(row.line_items) ? row.line_items : [],
        total_amount: Number(row.total_amount ?? 0),
        paid_amount: Number(row.paid_amount ?? 0),
      })) as MoovInvoice[];
    },
  });

  const onError = (e: Error) =>
    toast({ title: "Invoice error", description: e.message, variant: "destructive" });

  const createInvoice = useMutation({
    mutationFn: (input: {
      customer_name: string;
      customer_email: string;
      customer_type: "business" | "individual";
      description?: string;
      due_date?: string | null;
      invoice_date?: string | null;
      line_items: InvoiceLineItem[];
      send: boolean;
    }) =>
      callInvoiceFn({
        action: input.send ? "create_and_send" : "create",
        tenant_id: tenantId,
        ...input,
      }),
    onSuccess: (_d, vars) => {
      invalidate();
      toast({
        title: vars.send ? "Invoice sent" : "Invoice created",
        description: vars.send
          ? `${vars.customer_email} was emailed a secure payment link.`
          : "Saved as a draft — send it when you're ready.",
      });
    },
    onError,
  });

  const sendInvoice = useMutation({
    mutationFn: (invoiceId: string) =>
      callInvoiceFn({ action: "send", tenant_id: tenantId, invoice_id: invoiceId }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Invoice sent", description: "The customer was emailed a payment link." });
    },
    onError,
  });

  const resendInvoice = useMutation({
    mutationFn: (invoiceId: string) =>
      callInvoiceFn({ action: "resend", tenant_id: tenantId, invoice_id: invoiceId }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Invoice resent", description: "The payment link was emailed again." });
    },
    onError,
  });

  const cancelInvoice = useMutation({
    mutationFn: (invoiceId: string) =>
      callInvoiceFn({ action: "cancel", tenant_id: tenantId, invoice_id: invoiceId }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Invoice canceled" });
    },
    onError,
  });

  const syncInvoices = useMutation({
    mutationFn: () => callInvoiceFn({ action: "sync", tenant_id: tenantId }),
    onSuccess: (data: any) => {
      invalidate();
      toast({ title: "Invoices refreshed", description: `${data?.synced ?? 0} updated from the payment provider.` });
    },
    onError,
  });

  return { tenantId, invoices, createInvoice, sendInvoice, resendInvoice, cancelInvoice, syncInvoices };
}

