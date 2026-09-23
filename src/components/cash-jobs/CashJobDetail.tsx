import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Plus, DollarSign, Home, Phone, Mail, Pencil, Trash2, Receipt, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";
import { CashJobForm } from "./CashJobForm";
import { CashJobCheckUpload } from "./CashJobCheckUpload";

const PAYMENT_METHODS: Record<string, string> = {
  cash: "Cash", check: "Check", zelle: "Zelle",
  venmo: "Venmo", cashapp: "Cash App",
  credit_card: "Credit Card", bank_transfer: "Bank Transfer", other: "Other",
};

const STATUS_COLORS: Record<string, string> = {
  estimate: "text-muted-foreground border-border",
  deposit_received: "text-blue-600 border-blue-500/30 bg-blue-500/10",
  in_progress: "text-amber-600 border-amber-500/30 bg-amber-500/10",
  final_payment_due: "text-orange-600 border-orange-500/30 bg-orange-500/10",
  paid_in_full: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
  cancelled: "text-red-600 border-red-500/30 bg-red-500/10",
};

const STATUS_LABELS: Record<string, string> = {
  estimate: "Estimate", deposit_received: "Deposit Received",
  in_progress: "In Progress", final_payment_due: "Final Payment Due",
  paid_in_full: "Paid in Full", cancelled: "Cancelled",
};

interface Props {
  jobId: string;
  onBack: () => void;
}

export function CashJobDetail({ jobId, onBack }: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    payment_method: "check",
    payment_date: format(new Date(), "yyyy-MM-dd"),
    reference_number: "",
    notes: "",
  });

  const { data: job, isLoading } = useQuery({
    queryKey: ["cash-job", jobId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cash_jobs")
        .select(`
          *,
          cash_job_payments (*),
          cash_job_line_items (*)
        `)
        .eq("id", jobId)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const recordPayment = useMutation({
    mutationFn: async () => {
      if (!user || !tenant) throw new Error("Not authenticated");
      const amount = parseFloat(paymentForm.amount);
      if (isNaN(amount) || amount <= 0) throw new Error("Enter a valid amount");

      const { error } = await supabase.from("cash_job_payments").insert({
        tenant_id: tenant.id,
        cash_job_id: jobId,
        created_by: user.id,
        amount,
        payment_method: paymentForm.payment_method as any,
        payment_date: paymentForm.payment_date,
        reference_number: paymentForm.reference_number || null,
        notes: paymentForm.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      qc.invalidateQueries({ queryKey: ["cash-job", jobId] });
      qc.invalidateQueries({ queryKey: ["cash-jobs"] });
      setShowPaymentForm(false);
      setPaymentForm({ amount: "", payment_method: "check", payment_date: format(new Date(), "yyyy-MM-dd"), reference_number: "", notes: "" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deletePayment = useMutation({
    mutationFn: async (paymentId: string) => {
      const { error } = await supabase.from("cash_job_payments").delete().eq("id", paymentId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Payment removed" });
      qc.invalidateQueries({ queryKey: ["cash-job", jobId] });
      qc.invalidateQueries({ queryKey: ["cash-jobs"] });
    },
  });

  if (showEditForm && job) {
    return (
      <CashJobForm
        initialData={job}
        onSave={() => {
          setShowEditForm(false);
          qc.invalidateQueries({ queryKey: ["cash-job", jobId] });
        }}
        onCancel={() => setShowEditForm(false)}
      />
    );
  }

  if (isLoading || !job) return <div className="p-4 text-sm text-muted-foreground">Loading...</div>;

  const pctPaid = job.contract_amount > 0
    ? Math.min(100, (job.total_paid / job.contract_amount) * 100)
    : 0;

  const payments = (job.cash_job_payments ?? []).sort((a: any, b: any) =>
    new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime()
  );

  const lineItems = (job.cash_job_line_items ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order);

  return (
    <div className="space-y-4 p-4 max-w-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setShowEditForm(true)}>
          <Pencil className="h-3.5 w-3.5 mr-1" />
          Edit
        </Button>
      </div>

      {/* Job overview */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold text-base">{job.job_name}</h2>
              <div className="flex items-center gap-1.5 mt-0.5">
                <Home className="h-3 w-3 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">{job.customer_name}</p>
                {job.property_address && (
                  <p className="text-xs text-muted-foreground hidden sm:block">· {job.property_address}{job.property_city ? `, ${job.property_city}` : ""}</p>
                )}
              </div>
              <div className="flex gap-3 mt-1">
                {job.customer_phone && (
                  <a href={`tel:${job.customer_phone}`} className="flex items-center gap-1 text-xs text-blue-500">
                    <Phone className="h-3 w-3" />{job.customer_phone}
                  </a>
                )}
                {job.customer_email && (
                  <a href={`mailto:${job.customer_email}`} className="flex items-center gap-1 text-xs text-blue-500">
                    <Mail className="h-3 w-3" />{job.customer_email}
                  </a>
                )}
              </div>
            </div>
            <Badge variant="outline" className={`text-xs flex-shrink-0 ${STATUS_COLORS[job.status]}`}>
              {STATUS_LABELS[job.status]}
            </Badge>
          </div>

          {/* Financial summary */}
          <div className="rounded-md bg-muted/40 p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Contract</span>
              <span className="font-medium">${Number(job.contract_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Paid</span>
              <span className="text-emerald-600 font-medium">${Number(job.total_paid).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between text-sm border-t pt-2">
              <span className="font-medium">Balance due</span>
              <span className={`font-semibold ${job.balance_due > 0 ? "text-amber-500" : "text-emerald-500"}`}>
                ${Number(job.balance_due ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
              </span>
            </div>
            {job.contract_amount > 0 && (
              <>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${pctPaid >= 100 ? "bg-emerald-500" : pctPaid >= 50 ? "bg-blue-500" : "bg-amber-500"}`}
                    style={{ width: `${pctPaid}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-right">{Math.round(pctPaid)}% paid</p>
              </>
            )}
          </div>

          {job.description && (
            <p className="text-xs text-muted-foreground">{job.description}</p>
          )}
        </CardContent>
      </Card>

      {/* Line items */}
      {lineItems.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Scope of Work</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left p-3 font-medium">Description</th>
                  <th className="text-right p-3 font-medium">Qty</th>
                  <th className="text-right p-3 font-medium">Unit</th>
                  <th className="text-right p-3 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item: any) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="p-3 text-xs">{item.description}</td>
                    <td className="p-3 text-xs text-right">{item.quantity}</td>
                    <td className="p-3 text-xs text-right">${Number(item.unit_price).toFixed(2)}</td>
                    <td className="p-3 text-xs text-right font-medium">${Number(item.total).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/20">
                  <td colSpan={3} className="p-3 text-xs font-medium">Total</td>
                  <td className="p-3 text-sm font-semibold text-right">
                    ${lineItems.reduce((s: number, i: any) => s + Number(i.total), 0).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Payments */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              Payments Received
            </CardTitle>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowPaymentForm(!showPaymentForm)}>
              <Plus className="h-3 w-3 mr-1" />
              Record payment
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">

          <CashJobCheckUpload
            cashJobId={jobId}
            customerName={job.customer_name}
            propertyAddress={job.property_address ?? undefined}
            propertyCity={job.property_city ?? undefined}
            propertyState={job.property_state ?? undefined}
          />
          <div className="border-t my-2" />


          {/* Record payment form */}
          {showPaymentForm && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <p className="text-xs font-medium">Record a payment</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Amount ($)</Label>
                  <Input className="h-8 text-sm" type="number" placeholder="0.00" value={paymentForm.amount} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Payment method</Label>
                  <Select value={paymentForm.payment_method} onValueChange={(v) => setPaymentForm({ ...paymentForm, payment_method: v })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(PAYMENT_METHODS).map(([v, l]) => (
                        <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Payment date</Label>
                  <Input className="h-8 text-sm" type="date" value={paymentForm.payment_date} onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Reference # (optional)</Label>
                  <Input className="h-8 text-sm" placeholder="Check #, transaction ID" value={paymentForm.reference_number} onChange={(e) => setPaymentForm({ ...paymentForm, reference_number: e.target.value })} />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-xs">Notes (optional)</Label>
                  <Input className="h-8 text-sm" placeholder="e.g. Initial deposit" value={paymentForm.notes} onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => recordPayment.mutate()} disabled={recordPayment.isPending || !paymentForm.amount}>
                  {recordPayment.isPending ? "Saving..." : "Record payment"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowPaymentForm(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Payment list */}
          {payments.length === 0 && !showPaymentForm ? (
            <p className="text-xs text-muted-foreground text-center py-3">No payments recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {payments.map((payment: any) => (
                <div key={payment.id} className="flex items-start justify-between p-2.5 rounded-md border bg-background">
                  <div>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      <span className="font-medium text-sm">${Number(payment.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                      <Badge variant="outline" className="text-[10px]">{PAYMENT_METHODS[payment.payment_method]}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {format(new Date(payment.payment_date), "MMM d, yyyy")}
                      {payment.reference_number && ` · Ref: ${payment.reference_number}`}
                    </p>
                    {payment.notes && <p className="text-xs text-muted-foreground italic">{payment.notes}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => deletePayment.mutate(payment.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {job.notes && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Notes</CardTitle></CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">{job.notes}</p>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
