import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { AlertCircle, CheckCircle2, Clock, FileText, Lock, ExternalLink, Ban, Calendar } from "lucide-react";

interface InvoiceLineItem {
  name: string;
  unit_price: number;
  quantity: number;
}

interface PublicInvoice {
  id: string;
  public_token: string;
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
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
}

interface TenantBranding {
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_domain: string | null;
  invoice_letterhead_url: string | null;
  invoice_footer_note: string | null;
  invoice_default_terms: string | null;
  invoice_accent_color?: string | null;
  invoice_theme?: string | null;
}

const currency = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);

const STATUS_META: Record<string, { label: string; icon: React.ElementType; className: string }> = {
  draft: { label: "Draft", icon: FileText, className: "bg-muted text-muted-foreground" },
  unpaid: { label: "Unpaid", icon: Clock, className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  sent: { label: "Awaiting Payment", icon: Clock, className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  partially_paid: { label: "Partially Paid", icon: Clock, className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  paid: { label: "Paid", icon: CheckCircle2, className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  overdue: { label: "Overdue", icon: AlertCircle, className: "bg-destructive/15 text-destructive" },
  canceled: { label: "Canceled", icon: Ban, className: "bg-muted text-muted-foreground" },
  void: { label: "Void", icon: Ban, className: "bg-muted text-muted-foreground" },
};

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [tenant, setTenant] = useState<TenantBranding | null>(null);

  const primary = tenant?.invoice_accent_color || tenant?.primary_color || "#3B82F6";
  const secondary = tenant?.secondary_color || "#1E293B";
  const invoiceTheme = tenant?.invoice_theme === "dark" ? "dark" : "light";

  useEffect(() => {
    if (!token) {
      setError("Invoice token is missing.");
      setLoading(false);
      return;
    }

    supabase.functions
      .invoke("public-invoice", { body: { token } })
      .then(({ data, error: fnErr }) => {
        if (fnErr || (data as any)?.error) {
          setError((data as any)?.error || fnErr?.message || "Could not load invoice.");
        } else {
          setInvoice((data as any).invoice);
          setTenant((data as any).tenant);
        }
      })
      .catch((e) => setError(e.message || "Could not load invoice."))
      .finally(() => setLoading(false));
  }, [token]);

  const balanceDue = useMemo(
    () => Math.max((invoice?.total_amount || 0) - (invoice?.paid_amount || 0), 0),
    [invoice],
  );

  const statusMeta = invoice ? STATUS_META[invoice.status] || STATUS_META.draft : null;
  const StatusIcon = statusMeta?.icon || FileText;

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-2xl space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !invoice || !tenant) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center space-y-4">
            <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
            <h1 className="text-xl font-semibold">Invoice unavailable</h1>
            <p className="text-muted-foreground text-sm">
              {error || "We couldn't find that invoice. It may have been removed or the link may be incorrect."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isPaid = invoice.status === "paid";
  const isCanceled = invoice.status === "canceled" || invoice.status === "void";
  const canPay = !isPaid && !isCanceled && invoice.payment_link_url;

  return (
    <div className="min-h-screen bg-background py-6 px-4 sm:py-12">
      <style>{`
        .invoice-accent { color: ${primary}; }
        .invoice-accent-bg { background-color: ${primary}; }
        .invoice-accent-border { border-color: ${primary}; }
        .invoice-accent-ring { --tw-ring-color: ${primary}; }
      `}</style>

      <div className="mx-auto max-w-3xl">
        {/* Header / Letterhead */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          {tenant.invoice_letterhead_url ? (
            <img
              src={tenant.invoice_letterhead_url}
              alt={tenant.name}
              className="max-h-20 object-contain"
            />
          ) : tenant.logo_url ? (
            <img
              src={tenant.logo_url}
              alt={tenant.name}
              className="max-h-14 object-contain"
            />
          ) : (
            <div className="text-2xl font-bold" style={{ color: primary }}>
              {tenant.name}
            </div>
          )}

          <div className="text-left sm:text-right">
            <div className="text-sm font-semibold invoice-accent">Invoice</div>
            <div className="text-2xl font-bold text-foreground">
              {invoice.invoice_number || "—"}
            </div>
          </div>
        </div>

        <Card className="border border-border/60 shadow-sm overflow-hidden">
          <div className="h-1.5 w-full invoice-accent-bg" />
          <CardContent className="p-5 sm:p-8 space-y-6">
            {/* Status + meta */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="space-y-1">
                <h1 className="text-lg font-semibold text-foreground">
                  {isPaid ? "Thank you for your payment" : "Please review your invoice"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {isPaid
                    ? `Paid on ${formatDate(invoice.paid_at)}`
                    : `Sent on ${formatDate(invoice.sent_at || invoice.created_at)}`}
                </p>
              </div>
              <Badge className={`w-fit gap-1.5 px-2.5 py-1 text-xs ${statusMeta?.className || ""}`}>
                <StatusIcon className="h-3.5 w-3.5" />
                {statusMeta?.label || invoice.status}
              </Badge>
            </div>

            {/* Bill to */}
            <div className="grid gap-4 sm:grid-cols-2 border-t border-border/60 pt-5">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                  Bill to
                </div>
                <div className="font-medium text-foreground">{invoice.customer_name}</div>
                <div className="text-sm text-muted-foreground">{invoice.customer_email}</div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                    Invoice date
                  </div>
                  <div className="text-sm text-foreground flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                    {formatDate(invoice.invoice_date || invoice.created_at)}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                    Due date
                  </div>
                  <div className="text-sm text-foreground flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    {formatDate(invoice.due_date)}
                  </div>
                </div>
              </div>
            </div>

            {invoice.description && (
              <div className="border-t border-border/60 pt-5">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                  Description
                </div>
                <p className="text-sm text-foreground">{invoice.description}</p>
              </div>
            )}

            {/* Line items */}
            <div className="border-t border-border/60 pt-5">
              <div className="hidden sm:grid grid-cols-12 gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                <div className="col-span-7">Item</div>
                <div className="col-span-2 text-right">Qty</div>
                <div className="col-span-3 text-right">Amount</div>
              </div>
              <div className="space-y-3">
                {invoice.line_items.map((item, idx) => {
                  const amount = (Number(item.unit_price) || 0) * (Number(item.quantity) || 0);
                  return (
                    <div
                      key={idx}
                      className="grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 sm:py-2 sm:px-3"
                    >
                      <div className="sm:col-span-7 font-medium text-foreground">{item.name}</div>
                      <div className="sm:col-span-2 sm:text-right text-sm text-muted-foreground">
                        {item.quantity}
                      </div>
                      <div className="sm:col-span-3 sm:text-right font-medium text-foreground">
                        {currency(amount)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Totals */}
            <div className="border-t border-border/60 pt-5">
              <div className="flex justify-between py-1 text-sm text-muted-foreground">
                <span>Subtotal</span>
                <span>{currency(invoice.total_amount)}</span>
              </div>
              {invoice.paid_amount > 0 && (
                <div className="flex justify-between py-1 text-sm text-emerald-600">
                  <span>Amount paid</span>
                  <span>-{currency(invoice.paid_amount)}</span>
                </div>
              )}
              <div className="flex justify-between py-2 mt-1 border-t border-border/60 text-lg font-semibold text-foreground">
                <span>Balance due</span>
                <span className="invoice-accent">{currency(balanceDue)}</span>
              </div>
            </div>

            {/* CTA */}
            {canPay && (
              <div className="border-t border-border/60 pt-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5" />
                  Secure payment powered by Moov
                </div>
                <Button
                  size="lg"
                  className="w-full sm:w-auto invoice-accent-bg hover:opacity-90 text-white"
                  style={{ backgroundColor: primary }}
                  onClick={() => window.open(invoice.payment_link_url!, "_blank", "noopener")}
                >
                  Pay now
                  <ExternalLink className="ml-2 h-4 w-4" />
                </Button>
              </div>
            )}

            {isPaid && (
              <div className="border-t border-border/60 pt-5 text-center">
                <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-4 py-2 text-emerald-600 text-sm font-medium">
                  <CheckCircle2 className="h-4 w-4" />
                  This invoice has been paid in full.
                </div>
              </div>
            )}

            {isCanceled && (
              <div className="border-t border-border/60 pt-5 text-center">
                <div className="inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2 text-muted-foreground text-sm font-medium">
                  <Ban className="h-4 w-4" />
                  This invoice has been canceled.
                </div>
              </div>
            )}

            {/* Footer */}
            {(tenant.invoice_footer_note || tenant.invoice_default_terms) && (
              <div className="border-t border-border/60 pt-5 text-center text-xs text-muted-foreground space-y-1">
                {tenant.invoice_footer_note && <p>{tenant.invoice_footer_note}</p>}
                {tenant.invoice_default_terms && <p>{tenant.invoice_default_terms}</p>}
              </div>
            )}
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Invoice from {tenant.name}
          {tenant.custom_domain && ` · ${tenant.custom_domain}`}
        </p>
      </div>
    </div>
  );
}
