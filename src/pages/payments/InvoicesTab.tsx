import { useMemo, useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";

import { useMoovInvoices, type InvoiceLineItem } from "@/hooks/useMoovInvoices";
import { usePaymentAccount } from "@/hooks/usePaymentAccount";
import { supabase } from "@/integrations/aws/client";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Plus, Trash2, Send, Link2, MoreHorizontal, RefreshCw, Loader2, FileText, Clock, CheckCircle2, Ban, Settings,
} from "lucide-react";

const currency = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  unpaid: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  partially_paid: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  paid: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  overdue: "bg-destructive/15 text-destructive",
  canceled: "bg-muted text-muted-foreground line-through",
};

const label = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const emptyItem = (): InvoiceLineItem => ({ name: "", unit_price: 0, quantity: 1 });

export function InvoicesTab() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { invoices, createInvoice, sendInvoice, resendInvoice, cancelInvoice, deleteInvoice, syncInvoices } = useMoovInvoices();
  const { account } = usePaymentAccount();
  const isMobile = useIsMobile();


  const [open, setOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerType, setCustomerType] = useState<"business" | "individual">("business");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [items, setItems] = useState<InvoiceLineItem[]>([emptyItem()]);
  const [branding, setBranding] = useState<{
    invoice_letterhead_url: string | null;
    invoice_footer_note: string | null;
    invoice_default_terms: string | null;
  } | null>(null);

  const [customDomain, setCustomDomain] = useState<string | null>(null);

  // Custom domain decides whether we can send a fully white-labeled invoice link.
  // Without one we fall back to the provider-hosted (Moov-branded) payment link.
  useEffect(() => {
    const loadDomain = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: tenantUser } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!tenantUser) return;
      const { data: tenant } = await supabase
        .from("tenants")
        .select("custom_domain")
        .eq("id", tenantUser.tenant_id)
        .maybeSingle();
      setCustomDomain((tenant as any)?.custom_domain?.trim() || null);
    };
    loadDomain();
  }, []);

  useEffect(() => {
    if (open) {
      const loadBranding = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: tenantUser } = await supabase
            .from("tenant_users")
            .select("tenant_id")
            .eq("user_id", user.id)
            .maybeSingle();
          
          if (tenantUser) {
            const { data: tenant } = await supabase
              .from("tenants")
              .select("invoice_letterhead_url, invoice_footer_note, invoice_default_terms")
              .eq("id", tenantUser.tenant_id)
              .maybeSingle();
            
            if (tenant) {
              setBranding(tenant);
              if (tenant.invoice_default_terms) {
                setDescription(tenant.invoice_default_terms);
              }
            }
          }
        }
      };
      loadBranding();
    }
  }, [open]);


  const rows = invoices.data ?? [];

  const totals = useMemo(() => {
    let outstanding = 0, paid = 0, drafts = 0, overdue = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const r of rows) {
      if (r.status === "paid") paid += r.total_amount;
      else if (r.status === "draft") drafts += 1;
      else if (r.status !== "canceled") {
        outstanding += Math.max(r.total_amount - r.paid_amount, 0);
        if (r.due_date && r.due_date < today) overdue += 1;
      }
    }
    return { outstanding, paid, drafts, overdue };
  }, [rows]);

  const draftTotal = useMemo(
    () => items.reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0),
    [items],
  );

  const reset = () => {
    setCustomerName(""); setCustomerEmail(""); setCustomerType("business");
    setDescription(""); setDueDate(""); setItems([emptyItem()]);
  };

  const submit = async (send: boolean) => {
    try {
      await createInvoice.mutateAsync({
        customer_name: customerName,
        customer_email: customerEmail,
        customer_type: customerType,
        description: description || undefined,
        due_date: dueDate || null,
        line_items: items.map((i) => ({
          name: i.name.trim(),
          unit_price: Number(i.unit_price),
          quantity: Number(i.quantity),
        })),
        send,
      });
      setOpen(false);
      reset();
    } catch {
      /* toast handled in the hook */
    }
  };

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url);
    toast({ title: "Payment link copied", description: "Share it with your customer to get paid." });
  };

  const brandedInvoiceUrl = (inv: typeof rows[number]) => {
    // No custom domain configured → use the provider-hosted payment link so the
    // customer still gets a working (Moov-branded) checkout page.
    if (!customDomain) return inv.payment_link_url || (inv.public_token ? `${window.location.origin}/invoice/${inv.public_token}` : "");
    if (!inv.public_token) return inv.payment_link_url || "";
    const host = customDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${host}/invoice/${inv.public_token}`;
  };


  const canSubmit =
    customerName.trim().length > 1 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail.trim()) &&
    items.length > 0 &&
    items.every((i) => i.name.trim() && Number(i.unit_price) > 0 && Number(i.quantity) > 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile icon={Clock} title="Outstanding" value={currency(totals.outstanding)} hint={`${totals.overdue} past due`} />
        <SummaryTile icon={CheckCircle2} title="Paid" value={currency(totals.paid)} hint="Settled to your wallet" />
        <SummaryTile icon={FileText} title="Drafts" value={String(totals.drafts)} hint="Not sent yet" />
        <SummaryTile icon={Send} title="Invoices" value={String(rows.length)} hint="Last 200" />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <CardTitle className="text-base">Invoices</CardTitle>
            <CardDescription className="break-words">
              Send an invoice with a secure payment link. Customers pay by bank transfer or card and funds
              land directly in your wallet.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const isWhiteLabel = location.pathname.includes('/wl/');
                const base = isWhiteLabel ? location.pathname.split('/payments')[0] : '/freedom';
                const tab = isWhiteLabel ? 'branding' : 'organization';
                const section = isWhiteLabel ? '' : '&section=branding';
                navigate(`${base}/settings?tab=${tab}${section}`);
              }}
              className="hidden sm:flex"
            >
              <Settings className="h-4 w-4 mr-2" />
              Invoice Branding
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncInvoices.mutate()}
              disabled={syncInvoices.isPending}
            >
              {syncInvoices.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2 text-xs sm:text-sm">Refresh</span>
            </Button>
            <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="h-4 w-4" />
                  <span className="ml-2">New invoice</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="w-[95vw] max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>New invoice</DialogTitle>
                  <DialogDescription>
                    The customer gets an emailed payment link. Payments settle into your wallet.
                  </DialogDescription>
                </DialogHeader>

                {branding?.invoice_letterhead_url && (
                  <div className="mb-4 flex justify-center border-b pb-4">
                    <img 
                      src={branding.invoice_letterhead_url} 
                      alt="Invoice Letterhead" 
                      className="max-h-16 object-contain opacity-80" 
                    />
                  </div>
                )}


                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Customer name</Label>
                      <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Acme Restoration LLC" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Customer email</Label>
                      <Input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="billing@acme.com" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Customer type</Label>
                      <Select value={customerType} onValueChange={(v) => setCustomerType(v as any)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="business">Business</SelectItem>
                          <SelectItem value="individual">Individual</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Due date</Label>
                      <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Description</Label>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Mitigation services — claim #12345"
                      rows={2}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Line items</Label>
                    {items.map((item, idx) => (
                      <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                        <Input
                          className="col-span-6"
                          placeholder="Description"
                          value={item.name}
                          onChange={(e) => setItems((prev) => prev.map((p, i) => i === idx ? { ...p, name: e.target.value } : p))}
                        />
                        <Input
                          className="col-span-3"
                          type="number" min="0" step="0.01" placeholder="0.00"
                          value={item.unit_price || ""}
                          onChange={(e) => setItems((prev) => prev.map((p, i) => i === idx ? { ...p, unit_price: Number(e.target.value) } : p))}
                        />
                        <Input
                          className="col-span-2"
                          type="number" min="1" step="1"
                          value={item.quantity}
                          onChange={(e) => setItems((prev) => prev.map((p, i) => i === idx ? { ...p, quantity: Number(e.target.value) } : p))}
                        />
                        <Button
                          variant="ghost" size="icon" className="col-span-1" aria-label="Remove line item"
                          onClick={() => setItems((prev) => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx))}
                          disabled={items.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={() => setItems((p) => [...p, emptyItem()])}>
                      <Plus className="h-4 w-4" />
                      <span className="ml-2">Add line item</span>
                    </Button>
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
                    <span className="text-sm text-muted-foreground">Invoice total</span>
                    <span className="text-lg font-semibold">{currency(draftTotal)}</span>
                  </div>

                  {branding?.invoice_footer_note && (
                    <div className="rounded-md border border-dashed border-border p-3 text-center">
                      <p className="text-xs italic text-muted-foreground">
                        Footer: "{branding.invoice_footer_note}"
                      </p>
                    </div>
                  )}
                </div>


                <DialogFooter className="gap-2">
                  <Button variant="outline" onClick={() => submit(false)} disabled={!canSubmit || createInvoice.isPending}>
                    Save draft
                  </Button>
                  <Button onClick={() => submit(true)} disabled={!canSubmit || createInvoice.isPending}>
                    {createInvoice.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span className="ml-2">Send invoice</span>
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>

        <CardContent>
          {account && account.status !== "active" && (
            <p className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Finish your payment account setup to start collecting invoice payments into your wallet.
            </p>
          )}

          {invoices.isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading invoices…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No invoices yet. Create one to get paid directly into your wallet.
            </div>
          ) : isMobile ? (
            <div className="space-y-3">
              {rows.map((inv) => (
                <div key={inv.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{inv.invoice_number ?? "Draft"}</div>
                      <div className="break-words text-xs text-muted-foreground">{inv.customer_name}</div>
                      <div className="break-all text-xs text-muted-foreground">{inv.customer_email}</div>
                    </div>
                    <InvoiceActions
                      inv={inv}
                      brandedInvoiceUrl={brandedInvoiceUrl}
                      copyLink={copyLink}
                      sendInvoice={sendInvoice}
                      resendInvoice={resendInvoice}
                      cancelInvoice={cancelInvoice}
                      deleteInvoice={deleteInvoice}
                    />
                  </div>
                  {inv.description && (
                    <p className="mt-1 break-words text-xs text-muted-foreground">{inv.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className={STATUS_STYLES[inv.status] ?? ""}>
                      {label(inv.status)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Due {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : "—"}
                    </span>
                    <span className="ml-auto text-sm font-semibold">{currency(inv.total_amount)}</span>
                  </div>
                  {inv.paid_amount > 0 && (
                    <div className="mt-1 text-xs text-muted-foreground">Paid {currency(inv.paid_amount)}</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">
                      {inv.invoice_number ?? "Draft"}
                      {inv.description && (
                        <div className="text-xs text-muted-foreground line-clamp-1">{inv.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="break-words">{inv.customer_name}</div>
                      <div className="break-all text-xs text-muted-foreground">{inv.customer_email}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">{currency(inv.total_amount)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{currency(inv.paid_amount)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={STATUS_STYLES[inv.status] ?? ""}>
                        {label(inv.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <InvoiceActions
                        inv={inv}
                        brandedInvoiceUrl={brandedInvoiceUrl}
                        copyLink={copyLink}
                        sendInvoice={sendInvoice}
                        resendInvoice={resendInvoice}
                        cancelInvoice={cancelInvoice}
                        deleteInvoice={deleteInvoice}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}

        </CardContent>
      </Card>
    </div>
  );
}

function InvoiceActions({
  inv, brandedInvoiceUrl, copyLink, sendInvoice, resendInvoice, cancelInvoice, deleteInvoice,
}: {
  inv: any;
  brandedInvoiceUrl: (inv: any) => string;
  copyLink: (url: string) => void;
  sendInvoice: { mutate: (id: string) => void };
  resendInvoice: { mutate: (id: string) => void };
  cancelInvoice: { mutate: (id: string) => void };
  deleteInvoice: { mutate: (id: string) => void };
}) {
  const canResend = !["draft", "paid", "canceled"].includes(inv.status);
  const canDelete = inv.status === "canceled" || inv.status === "draft";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Invoice actions"><MoreHorizontal className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-50 bg-popover">
        {inv.status === "draft" && (
          <DropdownMenuItem onClick={() => sendInvoice.mutate(inv.id)}>
            <Send className="mr-2 h-4 w-4" /> Send invoice
          </DropdownMenuItem>
        )}
        {canResend && (
          <DropdownMenuItem onClick={() => resendInvoice.mutate(inv.id)}>
            <Send className="mr-2 h-4 w-4" /> Resend invoice
          </DropdownMenuItem>
        )}
        {(inv.public_token || inv.payment_link_url) && (
          <>
            <DropdownMenuItem onClick={() => copyLink(brandedInvoiceUrl(inv))}>
              <Link2 className="mr-2 h-4 w-4" /> Copy payment link
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.open(brandedInvoiceUrl(inv), "_blank", "noopener")}>
              <FileText className="mr-2 h-4 w-4" /> Open invoice page
            </DropdownMenuItem>
          </>
        )}
        {inv.status !== "paid" && inv.status !== "canceled" && (
          <DropdownMenuItem className="text-destructive" onClick={() => cancelInvoice.mutate(inv.id)}>
            <Ban className="mr-2 h-4 w-4" /> Cancel invoice
          </DropdownMenuItem>
        )}
        {canDelete && (
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => {
              if (window.confirm("Delete this invoice permanently? This cannot be undone.")) {
                deleteInvoice.mutate(inv.id);
              }
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" /> Delete invoice
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


function SummaryTile({
  icon: Icon, title, value, hint,
}: { icon: React.ElementType; title: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{title}</div>
          <div className="truncate text-lg font-semibold">{value}</div>
          <div className="truncate text-xs text-muted-foreground">{hint}</div>
        </div>
      </CardContent>
    </Card>
  );
}
