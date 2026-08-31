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
import { Separator } from "@/components/ui/separator";
import { Loader2, Save, ShieldCheck, AlertTriangle, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";
import { formatPhoneNumber } from "@/lib/utils";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";
import { VerificationDocumentsPanel } from "@/components/payments/VerificationDocumentsPanel";
import { PaymentAccountPanel } from "@/components/payments/PaymentAccountPanel";
import { PaymentReadinessPanel } from "@/components/payments/PaymentReadinessPanel";
import { useProviderProfile } from "@/hooks/useProviderProfile";








type AddressParts = { street: string; city: string; state: string; zip: string };

function parseAddress(combined: string): AddressParts {
  const empty = { street: "", city: "", state: "", zip: "" };
  if (!combined) return empty;
  const parts = combined.split(",").map((p) => p.trim());
  if (parts.length >= 3) {
    const stateZip = parts[parts.length - 1].split(/\s+/);
    const zip = stateZip.length > 1 ? stateZip[stateZip.length - 1] : "";
    const state = stateZip.length > 1 ? stateZip.slice(0, -1).join(" ") : stateZip[0] ?? "";
    const city = parts[parts.length - 2] ?? "";
    const street = parts.slice(0, parts.length - 2).join(", ");
    return { street, city, state, zip };
  }
  return { ...empty, street: combined };
}

function joinAddress(a: AddressParts): string {
  const tail = [a.state, a.zip].filter(Boolean).join(" ").trim();
  return [a.street, a.city, tail].filter(Boolean).join(", ");
}

export function ComplianceSettings({ tenantId: tenantIdOverride }: { tenantId?: string } = {}) {
  const { tenant: ctxTenant } = useTenant();
  // Platform admins render this inside tenant management for a specific org.
  const tenant = (tenantIdOverride ? { id: tenantIdOverride } : ctxTenant) as { id: string } | null;
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: t, isLoading } = useQuery({
    queryKey: ["compliance-tenant", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, legal_business_name, ein, business_address, business_phone, beneficial_owner_name, beneficial_owner_dob, beneficial_owner_id_url, kyc_completed_at, kyc_completed_by")
        .eq("id", tenant!.id)
        .single();
      if (error) throw error;
      return data as any;
    },
  });

  const [form, setForm] = useState({
    legal_business_name: "",
    ein: "",
    street: "",
    city: "",
    state: "",
    zip: "",
    business_phone: "",
    beneficial_owner_name: "",
    beneficial_owner_dob: "",
    beneficial_owner_id_url: "",
  });

  const { data: providerProfile } = useProviderProfile(tenant?.id);

  useEffect(() => {
    if (t) {
      const addr = parseAddress(t.business_address ?? "");
      const biz = providerProfile?.business;
      const controller =
        providerProfile?.representatives.find((r) => r.isController) ??
        providerProfile?.representatives[0];
      setForm({
        legal_business_name: t.legal_business_name ?? biz?.legalBusinessName ?? "",
        ein: t.ein ?? "",
        street: addr.street || (biz?.address.addressLine1 ?? ""),
        city: addr.city || (biz?.address.city ?? ""),
        state: addr.state || (biz?.address.stateOrProvince ?? ""),
        zip: addr.zip || (biz?.address.postalCode ?? ""),
        business_phone: t.business_phone
          ? formatPhoneNumber(t.business_phone)
          : biz?.phone
          ? formatPhoneNumber(biz.phone)
          : "",
        beneficial_owner_name:
          t.beneficial_owner_name ??
          (controller ? `${controller.firstName} ${controller.lastName}`.trim() : ""),
        beneficial_owner_dob: t.beneficial_owner_dob ?? "",
        beneficial_owner_id_url: t.beneficial_owner_id_url ?? "",
      });
    }
  }, [t, providerProfile]);


  const saveKyc = useMutation({
    mutationFn: async () => {
      const business_address = joinAddress({ street: form.street, city: form.city, state: form.state, zip: form.zip });
      if (!form.legal_business_name.trim() || !form.ein.trim() || !form.street.trim() || !form.city.trim() || !form.state.trim() || !form.zip.trim() || !form.business_phone.trim() || !form.beneficial_owner_name.trim() || !form.beneficial_owner_dob) {
        throw new Error("All KYC fields are required (ID document optional)");
      }
      const payload: any = {
        legal_business_name: form.legal_business_name,
        ein: form.ein,
        business_address,
        business_phone: form.business_phone,
        beneficial_owner_name: form.beneficial_owner_name,
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
        metadata: { legal_business_name: form.legal_business_name, ein_last_4: form.ein.slice(-4) },
      } as any);
    },
    onSuccess: () => {
      toast({ title: "KYC saved", description: "Your business identity has been recorded." });
      qc.invalidateQueries({ queryKey: ["compliance-tenant", tenant?.id] });
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const providerVerified = !!providerProfile?.verified;
  const kycDone = !!t?.kyc_completed_at || providerVerified;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="Compliance & Identity"
        description="Manage your KYC and vetting documents. All identity records sync directly with Moov for financial compliance."
        badge="Trust & Safety"
        icon={<ShieldCheck className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Compliance Status"
        accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
        icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}
        description="KYC and vetting document posture for this tenant."
      >
        <StatusPill label="KYC (Know Your Customer)" done={kycDone} />
      </SectionCard>

      <SectionCard
        title="Know Your Customer (KYC)"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<ShieldCheck className="h-4 w-4 text-primary" />}
        description={
          providerVerified
            ? "Your business identity is already verified with our payment provider. Nothing further is required — these details are shown for your records."
            : `Required under our AML program before originating ACH payments. Last completed: ${t?.kyc_completed_at ? format(new Date(t.kyc_completed_at), "PPp") : "Never"}`
        }
      >
        <div className="space-y-4">
          {providerVerified && (
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              <div className="text-xs">
                <p className="font-medium text-emerald-500">Identity verified — no re-entry needed</p>
                <p className="text-muted-foreground mt-0.5">
                  {providerProfile?.business?.legalBusinessName || t?.legal_business_name || "Your business"}
                  {providerProfile?.business?.taxIdProvided ? " • EIN on file" : ""}
                  {providerProfile?.representatives.length
                    ? ` • Controller: ${providerProfile.representatives
                        .filter((r) => r.isController)
                        .map((r) => `${r.firstName} ${r.lastName}`.trim())
                        .join(", ") || "on file"}`
                    : ""}
                  . Edit below only if something changed.
                </p>
              </div>
            </div>
          )}



          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Legal business name" value={form.legal_business_name} onChange={(v) => setForm({ ...form, legal_business_name: v })} />
            <Field label="EIN" value={form.ein} onChange={(v) => setForm({ ...form, ein: v })} placeholder="00-0000000" />
          </div>

          <div className="space-y-3">
            <Label className="text-[11px] uppercase text-muted-foreground tracking-wide">Business address</Label>
            <div className="grid gap-3">
              <Field label="Street" value={form.street} onChange={(v) => setForm({ ...form, street: v })} placeholder="123 Main St" />
              <div className="grid sm:grid-cols-3 gap-3">
                <Field label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
                <Field label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v.toUpperCase().slice(0, 2) })} placeholder="NJ" />
                <Field label="ZIP" value={form.zip} onChange={(v) => setForm({ ...form, zip: v.replace(/[^0-9-]/g, "").slice(0, 10) })} placeholder="07001" />
              </div>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <Field
              label="Business phone"
              value={form.business_phone}
              onChange={(v) => setForm({ ...form, business_phone: formatPhoneNumber(v) })}
              placeholder="123-456-7890"
            />
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
        </div>
      </SectionCard>

      {!tenantIdOverride && (
        <SectionCard
          title="Payment Account Setup"
          accent="bg-gradient-to-r from-primary/60 to-primary/10"
          icon={<ShieldCheck className="h-4 w-4 text-primary" />}
          description="Create and verify your payment account before sending or receiving funds."
        >
          <div className="space-y-4">
            <PaymentAccountPanel />
            <PaymentReadinessPanel />
            <UnderwritingQuestionnairePanel tenantId={tenant?.id} />

          </div>

        </SectionCard>
      )}


      <SectionCard
        title="Payment Provider Verification"
        accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        icon={<ShieldCheck className="h-4 w-4 text-sky-500" />}
        description="Upload every onboarding document here — identity and business verification plus W-9, license, insurance and signed agreements. Documents stream to the payment provider and stay visible to tenant management."
      >
        <VerificationDocumentsPanel tenantId={tenant?.id} />
      </SectionCard>


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
