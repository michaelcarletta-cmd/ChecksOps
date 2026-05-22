import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Save, Plus, Trash2 } from "lucide-react";

const WORK_TYPES = [
  "roof", "siding", "gutters", "windows", "doors",
  "interior", "painting", "flooring", "hvac",
  "plumbing", "electrical", "landscaping", "other"
];

const WORK_TYPE_LABELS: Record<string, string> = {
  roof: "Roof", siding: "Siding", gutters: "Gutters", windows: "Windows",
  doors: "Doors", interior: "Interior", painting: "Painting", flooring: "Flooring",
  hvac: "HVAC", plumbing: "Plumbing", electrical: "Electrical",
  landscaping: "Landscaping", other: "Other",
};

interface LineItem {
  description: string;
  quantity: string;
  unit_price: string;
}

interface Props {
  onSave: () => void;
  onCancel: () => void;
  initialData?: any;
}

export function CashJobForm({ onSave, onCancel, initialData }: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();

  const [form, setForm] = useState({
    job_name: initialData?.job_name ?? "",
    work_type: initialData?.work_type ?? "roof",
    customer_name: initialData?.customer_name ?? "",
    customer_phone: initialData?.customer_phone ?? "",
    customer_email: initialData?.customer_email ?? "",
    property_address: initialData?.property_address ?? "",
    property_city: initialData?.property_city ?? "",
    property_state: initialData?.property_state ?? "",
    property_zip: initialData?.property_zip ?? "",
    contract_amount: initialData?.contract_amount ? String(initialData.contract_amount) : "",
    estimate_date: initialData?.estimate_date ?? "",
    start_date: initialData?.start_date ?? "",
    completion_date: initialData?.completion_date ?? "",
    description: initialData?.description ?? "",
    notes: initialData?.notes ?? "",
  });

  const [lineItems, setLineItems] = useState<LineItem[]>(
    initialData?.line_items ?? [{ description: "", quantity: "1", unit_price: "" }]
  );

  const lineTotal = lineItems.reduce((s, item) => {
    const qty = parseFloat(item.quantity || "0");
    const price = parseFloat(item.unit_price || "0");
    return s + (isNaN(qty) || isNaN(price) ? 0 : qty * price);
  }, 0);

  const addLineItem = () => setLineItems([...lineItems, { description: "", quantity: "1", unit_price: "" }]);
  const removeLineItem = (i: number) => setLineItems(lineItems.filter((_, idx) => idx !== i));
  const updateLineItem = (i: number, field: keyof LineItem, value: string) => {
    setLineItems(lineItems.map((item, idx) => idx === i ? { ...item, [field]: value } : item));
  };

  const saveJob = useMutation({
    mutationFn: async () => {
      if (!user || !tenant) throw new Error("Not authenticated");
      if (!form.job_name.trim()) throw new Error("Job name is required");
      if (!form.customer_name.trim()) throw new Error("Customer name is required");

      const contractAmount = lineTotal > 0
        ? lineTotal
        : parseFloat(form.contract_amount || "0");

      if (initialData?.id) {
        const { error } = await supabase
          .from("cash_jobs")
          .update({
            ...form,
            contract_amount: contractAmount,
            estimate_date: form.estimate_date || null,
            start_date: form.start_date || null,
            completion_date: form.completion_date || null,
          })
          .eq("id", initialData.id);
        if (error) throw error;

        // Update line items
        await supabase.from("cash_job_line_items").delete().eq("cash_job_id", initialData.id);
      } else {
        const { data: job, error: jobErr } = await supabase
          .from("cash_jobs")
          .insert({
            ...form,
            tenant_id: tenant.id,
            created_by: user.id,
            contract_amount: contractAmount,
            estimate_date: form.estimate_date || null,
            start_date: form.start_date || null,
            completion_date: form.completion_date || null,
          })
          .select("id")
          .single();

        if (jobErr) throw jobErr;

        // Insert line items
        const validItems = lineItems.filter(item => item.description.trim());
        if (validItems.length > 0) {
          await supabase.from("cash_job_line_items").insert(
            validItems.map((item, i) => ({
              cash_job_id: job.id,
              tenant_id: tenant.id,
              description: item.description,
              quantity: parseFloat(item.quantity || "1"),
              unit_price: parseFloat(item.unit_price || "0"),
              sort_order: i,
            }))
          );
        }
      }
    },
    onSuccess: () => {
      toast({ title: initialData ? "Job updated" : "Job created" });
      onSave();
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4 p-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-8" onClick={onCancel}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <h2 className="text-base font-semibold">{initialData ? "Edit Job" : "New Cash Job"}</h2>
      </div>

      {/* Job details */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Job Details</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Job name *</Label>
              <Input className="h-8 text-sm" placeholder="e.g. Smith Roof Replacement" value={form.job_name} onChange={(e) => setForm({ ...form, job_name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Work type</Label>
              <Select value={form.work_type} onValueChange={(v) => setForm({ ...form, work_type: v })}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WORK_TYPES.map(t => <SelectItem key={t} value={t} className="text-xs">{WORK_TYPE_LABELS[t]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Contract amount ($)</Label>
              <Input className="h-8 text-sm" type="number" placeholder="0.00" value={form.contract_amount} onChange={(e) => setForm({ ...form, contract_amount: e.target.value })} />
              {lineTotal > 0 && <p className="text-[10px] text-muted-foreground">Line item total: ${lineTotal.toFixed(2)}</p>}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Estimate date</Label>
              <Input className="h-8 text-sm" type="date" value={form.estimate_date} onChange={(e) => setForm({ ...form, estimate_date: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Start date</Label>
              <Input className="h-8 text-sm" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Completion date</Label>
              <Input className="h-8 text-sm" type="date" value={form.completion_date} onChange={(e) => setForm({ ...form, completion_date: e.target.value })} />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Description</Label>
            <Textarea className="text-sm min-h-16" placeholder="Scope of work..." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        </CardContent>
      </Card>

      {/* Customer */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Customer</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Customer name *</Label>
              <Input className="h-8 text-sm" placeholder="Full name" value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Phone</Label>
              <Input className="h-8 text-sm" placeholder="(555) 000-0000" value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email</Label>
              <Input className="h-8 text-sm" type="email" placeholder="email@example.com" value={form.customer_email} onChange={(e) => setForm({ ...form, customer_email: e.target.value })} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Property address</Label>
              <Input className="h-8 text-sm" placeholder="Street address" value={form.property_address} onChange={(e) => setForm({ ...form, property_address: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">City</Label>
              <Input className="h-8 text-sm" value={form.property_city} onChange={(e) => setForm({ ...form, property_city: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">State</Label>
                <Input className="h-8 text-sm" maxLength={2} placeholder="TX" value={form.property_state} onChange={(e) => setForm({ ...form, property_state: e.target.value.toUpperCase() })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">ZIP</Label>
                <Input className="h-8 text-sm" maxLength={5} value={form.property_zip} onChange={(e) => setForm({ ...form, property_zip: e.target.value })} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Line items */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Line Items</CardTitle>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addLineItem}>
              <Plus className="h-3 w-3 mr-1" />
              Add line
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {lineItems.map((item, i) => (
            <div key={i} className="flex gap-2 items-start">
              <Input
                className="h-8 text-sm flex-1"
                placeholder="Description"
                value={item.description}
                onChange={(e) => updateLineItem(i, "description", e.target.value)}
              />
              <Input
                className="h-8 text-sm w-16"
                placeholder="Qty"
                type="number"
                value={item.quantity}
                onChange={(e) => updateLineItem(i, "quantity", e.target.value)}
              />
              <Input
                className="h-8 text-sm w-24"
                placeholder="Unit $"
                type="number"
                value={item.unit_price}
                onChange={(e) => updateLineItem(i, "unit_price", e.target.value)}
              />
              <span className="text-xs text-muted-foreground w-20 pt-2 text-right">
                ${((parseFloat(item.quantity || "0")) * (parseFloat(item.unit_price || "0"))).toFixed(2)}
              </span>
              {lineItems.length > 1 && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => removeLineItem(i)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
          {lineTotal > 0 && (
            <div className="flex justify-end pt-2 border-t">
              <span className="text-sm font-semibold">Total: ${lineTotal.toFixed(2)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      <Card>
        <CardContent className="pt-3">
          <div className="space-y-1">
            <Label className="text-xs">Notes</Label>
            <Textarea className="text-sm min-h-16" placeholder="Internal notes..." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2 pb-8">
        <Button className="flex-1" onClick={() => saveJob.mutate()} disabled={saveJob.isPending || !form.job_name || !form.customer_name}>
          <Save className="h-4 w-4 mr-1" />
          {saveJob.isPending ? "Saving..." : "Save job"}
        </Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
