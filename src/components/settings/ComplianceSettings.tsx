import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, Save, ShieldCheck, FileText, AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { format } from "date-fns";

const ACH_POLICY_VERSION = "2026-06-22";

export function ComplianceSettings() {
  const { tenant } = useTenant();
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: t, isLoading } = useQuery({
    queryKey: ["compliance-tenant", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, legal_business_name, ein, business_address, business_phone, beneficial_owner_name, beneficial_owner_dob, beneficial_owner_id_url, kyc_completed_at, kyc_completed_by, wisp_acknowledged_at, wisp_acknowledged_by, ach_policy_acknowledged_at, ach_policy_acknowledged_by, ach_policy_version")
        .eq("id", tenant!.id)
        .single();
      if (error) throw error;
      return data as any;
    },
  });

  const [form, setForm] = useState({
    legal_business_name: "",
    ein: "",
    business_address: "",
    business_phone: "",
    beneficial_owner_name: "",
    beneficial_owner_dob: "",
    beneficial_owner_id_url: "",
  });

  useEffect(() => {
    if (t) {
      setForm({
        legal_business_name: t.legal_business_name ?? "",
        ein: t.ein ?? "",
        business_address: t.business_address ?? "",
        business_phone: t.business_phone ?? "",
        beneficial_owner_name: t.beneficial_owner_name ?? "",
        beneficial_owner_dob: t.beneficial_owner_dob ?? "",
        beneficial_owner_id_url: t.beneficial_owner_id_url ?? "",
      });
    }
  }, [t]);

  const saveKyc = useMutation({
    mutationFn: async () => {
      if (!form.legal_business_name.trim() || !form.ein.trim() || !form.business_address.trim() || !form.business_phone.trim() || !form.beneficial_owner_name.trim() || !form.beneficial_owner_dob) {
        throw new Error("All KYC fields are required (ID document optional)");
      }
      const payload: any = {
        ...form,
        beneficial_owner_dob: form.beneficial_owner_dob || null,
        beneficial_owner_id_url: form.beneficial_owner_id_url || null,
        kyc_completed_at: new Date().toISOString(),
        kyc_completed_by: user?.id,
      };
      const { error } = await supabase.from("tenants").update(payload).eq("id", tenant!.id);
      if (error) throw error;
      await supabase.from("glba_security_events").insert({
        tenant_id: tenant!.id,
        event_type: "kyc.completed",
        actor_user_id: user?.id,
        details: { legal_business_name: form.legal_business_name, ein_last_4: form.ein.slice(-4) },
      } as any);
    },
    onSuccess: () => {
      toast({ title: "KYC saved", description: "Your business identity has been recorded." });
      qc.invalidateQueries({ queryKey: ["compliance-tenant", tenant?.id] });
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const ackPolicy = useMutation({
    mutationFn: async (kind: "wisp" | "ach") => {
      const patch: any = {};
      if (kind === "wisp") {
        patch.wisp_acknowledged_at = new Date().toISOString();
        patch.wisp_acknowledged_by = user?.id;
      } else {
        patch.ach_policy_acknowledged_at = new Date().toISOString();
        patch.ach_policy_acknowledged_by = user?.id;
        patch.ach_policy_version = ACH_POLICY_VERSION;
      }
      const { error } = await supabase.from("tenants").update(patch).eq("id", tenant!.id);
      if (error) throw error;
      await supabase.from("glba_security_events").insert({
        tenant_id: tenant!.id,
        event_type: kind === "wisp" ? "policy.wisp_acknowledged" : "policy.ach_acknowledged",
        actor_user_id: user?.id,
        details: kind === "ach" ? { version: ACH_POLICY_VERSION } : {},
      } as any);
      return kind;
    },
    onSuccess: (kind) => {
      toast({ title: "Acknowledged", description: kind === "wisp" ? "WISP acknowledgment recorded." : "ACH policy acknowledgment recorded." });
      qc.invalidateQueries({ queryKey: ["compliance-tenant", tenant?.id] });
    },
    onError: (e: any) => toast({ title: "Could not record", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const kycDone = !!t?.kyc_completed_at;
  const wispDone = !!t?.wisp_acknowledged_at;
  const achDone = !!t?.ach_policy_acknowledged_at && t?.ach_policy_version === ACH_POLICY_VERSION;

  return (
    <div className="space-y-6">
      {/* Status summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" /> Compliance status
          </CardTitle>
          <CardDescription>GLBA, AML, and NACHA compliance posture for this tenant.</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-3 gap-3">
          <StatusPill label="KYC" done={kycDone} />
          <StatusPill label="WISP acknowledged" done={wispDone} />
          <StatusPill label={`ACH policy (${ACH_POLICY_VERSION})`} done={achDone} />
        </CardContent>
      </Card>

      {/* KYC */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Know Your Customer (KYC)</CardTitle>
          <CardDescription>
            Required under our AML program before originating ACH payments. Last completed: {t?.kyc_completed_at ? format(new Date(t.kyc_completed_at), "PPp") : "Never"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Legal business name" value={form.legal_business_name} onChange={(v) => setForm({ ...form, legal_business_name: v })} />
            <Field label="EIN" value={form.ein} onChange={(v) => setForm({ ...form, ein: v })} placeholder="00-0000000" />
            <Field label="Business address" value={form.business_address} onChange={(v) => setForm({ ...form, business_address: v })} className="sm:col-span-2" />
            <Field label="Business phone" value={form.business_phone} onChange={(v) => setForm({ ...form, business_phone: v })} />
          </div>
          <Separator />
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Beneficial owner full name" value={form.beneficial_owner_name} onChange={(v) => setForm({ ...form, beneficial_owner_name: v })} />
            <Field label="Beneficial owner DOB" type="date" value={form.beneficial_owner_dob} onChange={(v) => setForm({ ...form, beneficial_owner_dob: v })} />
            <Field label="ID document URL (optional)" value={form.beneficial_owner_id_url} onChange={(v) => setForm({ ...form, beneficial_owner_id_url: v })} className="sm:col-span-2" placeholder="Upload separately and paste the URL" />
          </div>
          <Button onClick={() => saveKyc.mutate()} disabled={saveKyc.isPending} size="sm">
            {saveKyc.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
            Save KYC
          </Button>
        </CardContent>
      </Card>

      {/* Policy acknowledgments */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Policy acknowledgments</CardTitle>
          <CardDescription>Acknowledge that you have read and will operate under each policy.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <PolicyRow
            title="Written Information Security Program (WISP)"
            subtitle={wispDone ? `Acknowledged ${format(new Date(t.wisp_acknowledged_at), "PPp")}` : "Not yet acknowledged"}
            done={wispDone}
            onAck={() => ackPolicy.mutate("wisp")}
            pending={ackPolicy.isPending}
          />
          <PolicyRow
            title={`ACH Risk & Fraud Monitoring Policy (${ACH_POLICY_VERSION})`}
            subtitle={achDone ? `Acknowledged ${format(new Date(t.ach_policy_acknowledged_at), "PPp")}` : "Not yet acknowledged — required by NACHA effective 2026-06-22"}
            done={achDone}
            onAck={() => ackPolicy.mutate("ach")}
            pending={ackPolicy.isPending}
          />
        </CardContent>
      </Card>

      {/* Reference links */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4" /> Reference documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <DocLink href="/privacy-notice" label="Consumer Privacy Notice (live page)" external />
          <p className="text-xs text-muted-foreground pt-2">
            Internal policies (WISP, Data Retention, Incident Response, ACH Risk & Fraud Monitoring, AML Program) live in <code className="text-[11px]">docs/</code> in the codebase and are maintained by the Qualified Individual.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusPill({ label, done }: { label: string; done: boolean }) {
  return (
    <div className={`flex items-center gap-2 p-3 rounded-md border ${done ? "bg-emerald-500/5 border-emerald-500/30" : "bg-amber-500/5 border-amber-500/30"}`}>
      {done ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, className = "" }: any) {
  return (
    <div className={`space-y-1 ${className}`}>
      <Label className="text-[11px] uppercase text-muted-foreground tracking-wide">{label}</Label>
      <Input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-9" />
    </div>
  );
}

function PolicyRow({ title, subtitle, done, onAck, pending }: { title: string; subtitle: string; done: boolean; onAck: () => void; pending: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 p-3 rounded-md border">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {done ? (
        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 border-emerald-500/20">Acknowledged</Badge>
      ) : (
        <Button size="sm" variant="outline" onClick={onAck} disabled={pending}>
          {pending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          Acknowledge
        </Button>
      )}
    </div>
  );
}

function DocLink({ href, label, external }: { href: string; label: string; external?: boolean }) {
  return (
    <a href={href} target={external ? "_blank" : undefined} rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
      {label} {external && <ExternalLink className="h-3 w-3" />}
    </a>
  );
}
