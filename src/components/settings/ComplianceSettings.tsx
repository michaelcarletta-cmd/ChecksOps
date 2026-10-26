import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileText,
  FlaskConical,
  Landmark,
  Loader2,
  Lock,
  RefreshCw,
  Send,
  ShieldCheck,
  Users,
} from "lucide-react";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";
import { BusinessSection } from "./compliance/BusinessSection";
import { RepresentativesSection } from "./compliance/RepresentativesSection";
import { DocumentsSection } from "./compliance/DocumentsSection";
import { BankSection } from "./compliance/BankSection";
import { UnderwritingQuestionnairePanel } from "@/components/payments/UnderwritingQuestionnairePanel";
import { moovOnboardingQueryKey, useMoovOnboarding, useOnboardingApi } from "@/hooks/useMoovOnboarding";
import {
  OnboardingApiError,
  businessFormFrom,
  buildSavePayload,
  clearSecrets,
  describeRejectedFields,
  describeSyncStatus,
  normalizeOnboardingState,
  representativeFormFrom,
  resolveComplianceAccess,
  safeErrorMessage,
  validateOnboardingForm,
  type BusinessForm,
  type OnboardingState,
  type RepresentativeForm,
  type SaveResult,
  type SyncTone, isOnboardingUnavailableCode } from "@/lib/payments/moovOnboarding";

const SYNC_CLASS: Record<SyncTone, string> = {
  idle: "border-muted-foreground/30 text-muted-foreground",
  working: "border-sky-500/40 text-sky-500",
  ok: "border-emerald-500/40 text-emerald-500",
  warn: "border-amber-500/40 text-amber-500",
  error: "border-destructive/40 text-destructive",
};

/**
 * Compliance & Docs: the single tenant onboarding flow.
 *
 * Driven by `moov-onboarding-get`. Everything the tenant enters is saved in
 * ChecksOps and sent to Moov by `moov-onboarding-save`; documents go
 * upload-url -> PUT -> finalize. The server's `can_submit` decides who may
 * edit (any member of the tenant, and the platform owner); when it is false
 * the flow is status-only.
 *
 * `adminView` is Tenant Management: read-only by default, with an explicit
 * "Edit on behalf of tenant" toggle for the platform owner.
 */
export function ComplianceSettings({
  tenantId: tenantIdOverride,
  adminView = false,
}: { tenantId?: string; adminView?: boolean } = {}) {
  const { tenant: ctxTenant } = useTenant();
  const tenantId = tenantIdOverride ?? (ctxTenant as { id?: string } | null)?.id ?? null;
  const { toast } = useToast();
  const qc = useQueryClient();
  const api = useOnboardingApi();
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useMoovOnboarding(tenantId);

  const [editOnBehalf, setEditOnBehalf] = useState(false);
  const [business, setBusiness] = useState<BusinessForm>(() => businessFormFrom(null));
  const [reps, setReps] = useState<RepresentativeForm[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSave, setLastSave] = useState<(SaveResult & { at: number }) | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [tosBusy, setTosBusy] = useState(false);

  // Prefill from the server unless the user has unsaved edits.
  useEffect(() => {
    if (!data || dirty) return;
    setBusiness(businessFormFrom(data.business));
    setReps(data.representatives.map(representativeFormFrom));
  }, [data, dirty]);

  // Once the server reports Moov delivery finished, drop the one-shot save result.
  useEffect(() => {
    if (!lastSave || !data || saving) return;
    if (dataUpdatedAt > lastSave.at && !data.sync.pending) setLastSave(null);
  }, [data, dataUpdatedAt, lastSave, saving]);

  const access = resolveComplianceAccess({ canSubmit: data?.can_submit, adminView, editOnBehalf });
  const readOnly = access.readOnly;

  const onBusinessChange = (next: BusinessForm) => { setBusiness(next); setDirty(true); };
  const onRepsChange = (next: RepresentativeForm[]) => { setReps(next); setDirty(true); };

  async function reload() {
    await refetch();
  }

  async function handleSave() {
    if (!tenantId || readOnly) return;
    const problems = validateOnboardingForm(business, reps);
    setErrors(problems);
    if (problems.length) return;

    // SSN/EIN exist only in this request body from here on: form state is
    // cleared before the request is awaited and they are never cached.
    const payload = buildSavePayload(tenantId, business, reps);
    const cleared = clearSecrets(business, reps);
    setBusiness(cleared.business);
    setReps(cleared.representatives);

    setSaving(true);
    setLastSave(null);
    try {
      const res = await api.save(payload);
      // Strictly after the save returned; refetches older than this never clear it.
      setLastSave({ ...res, at: Date.now() + 1 });
      if (res.business || res.representatives) {
        const prev = qc.getQueryData<OnboardingState>(moovOnboardingQueryKey(tenantId));
        qc.setQueryData(
          moovOnboardingQueryKey(tenantId),
          normalizeOnboardingState({
            ...prev,
            ...res,
            sync: res.sync ?? { pending: res.pending, last_error_code: res.error_code },
            can_submit: res.can_submit ?? prev?.can_submit,
          }),
        );
      }
      setDirty(false);
      const status = describeSyncStatus({ saving: false, lastSave: res });
      const resubmit = (res.representatives ?? []).some((r) => r.ssn_resubmit_required);
      const rejected = describeRejectedFields(res.rejected_fields);
      toast({
        title: status.label,
        description: rejected
          ? `${rejected}${resubmit ? " The SSN also needs to be re-entered for one representative." : ""}`
          : resubmit
          ? "An SSN needs to be re-entered for one representative."
          : res.moov_synced
          ? "Your details are saved and submitted for verification."
          : "Your details are saved. Submitting them for verification will be retried.",
        variant: res.saved ? undefined : "destructive",
      });
      void refetch();
    } catch (e) {
      const code = e instanceof OnboardingApiError && e.code ? ` (${e.code})` : "";
      toast({
        title: "Could not save",
        description: `${safeErrorMessage(e)}${code} Re-enter any SSN or EIN you changed before trying again.`,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleAcceptTerms() {
    if (!tenantId || readOnly) return;
    setTosBusy(true);
    try {
      await api.acceptTerms(tenantId);
      await api.sync(tenantId).catch(() => null);
      toast({ title: "Terms accepted", description: "Your acceptance of the ChecksOps Terms of Service is recorded." });
      await reload();
    } catch (e) {
      toast({ title: "Couldn't record terms acceptance", description: safeErrorMessage(e), variant: "destructive" });
    } finally {
      setTosBusy(false);
    }
  }

  const hero = (
    <SettingsHero
      title="Compliance & Identity"
      description="Complete onboarding here. Everything you enter or upload is saved in ChecksOps and submitted for verification."
      badge="Trust & Safety"
      icon={<ShieldCheck className="h-4 w-4 text-primary" />}
    />
  );

  if (!tenantId) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        {hero}
        <p className="text-sm text-muted-foreground">Select an organization to manage compliance.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" role="status" aria-live="polite">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading compliance details…</span>
      </div>
    );
  }

  if (error || !data) {
    const status = error instanceof OnboardingApiError ? error.status : null;
    const code = error instanceof OnboardingApiError ? error.code : null;
    if (isOnboardingUnavailableCode(code)) {
      // Production onboarding is switched off on this deployment: not an error.
      return (
        <div className="space-y-6 max-w-7xl mx-auto">
          {hero}
          <div role="status" className="rounded-md border border-border/60 bg-muted/30 p-4 space-y-1">
            <p className="text-sm font-medium">Payment account setup is not available yet</p>
            <p className="text-xs text-muted-foreground">ChecksOps will turn on Compliance &amp; Docs for your organization soon. Nothing needs to be done now.</p>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        {hero}
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 space-y-2">
          <p className="text-sm font-medium text-destructive">
            {status === 403 ? "You don't have access to this organization's compliance record." : "Couldn't load compliance details."}
          </p>
          {status !== 403 && <p className="text-xs text-muted-foreground">{safeErrorMessage(error, "Please try again.")}</p>}
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Try again
          </Button>
        </div>
      </div>
    );
  }

  const sync = describeSyncStatus({ saving, lastSave, sync: data.sync, accountConnected: data.account.connected });
  const isSandbox = data.environment === "sandbox";

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {hero}

      <SectionCard
        title="Compliance Status"
        accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
        icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}
        description="Payment account onboarding status for this organization."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={`Payment account: ${data.account.connected ? data.account.status ?? "connected" : "not created yet"}`} done={data.account.connected} />
            <StatusPill label={data.account.tos_accepted ? "Terms accepted" : "Terms not accepted"} done={data.account.tos_accepted} />
            {isSandbox && (
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-500 gap-1">
                <FlaskConical className="h-3 w-3" /> Test mode
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2" aria-live="polite" role="status">
            <span className="text-xs text-muted-foreground">Sync:</span>
            <Badge variant="outline" className={`text-[11px] ${SYNC_CLASS[sync.tone]}`} data-testid="sync-status">
              {sync.tone === "working" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {sync.label}
            </Badge>
            <Button size="sm" variant="ghost" className="h-7 text-[11px] px-2" onClick={() => reload()} disabled={isFetching}>
              <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>

          {access.showEditOnBehalfToggle && (
            <div className="flex items-center gap-2 rounded-md border border-border p-2.5">
              <Switch id="edit-on-behalf" checked={editOnBehalf} onCheckedChange={setEditOnBehalf} />
              <Label htmlFor="edit-on-behalf" className="text-xs">Edit on behalf of tenant</Label>
            </div>
          )}

          {readOnly && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
              <Lock className="h-3.5 w-3.5 mt-px shrink-0" />
              {data.can_submit
                ? "Read-only. Turn on “Edit on behalf of tenant” to make changes."
                : "Read-only. Your account can't submit onboarding details for this organization."}
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Business"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<ShieldCheck className="h-4 w-4 text-primary" />}
        description="Legal identity of the business as it will be verified."
      >
        <BusinessSection
          form={business}
          onChange={onBusinessChange}
          einMasked={data.business.ein_masked}
          readOnly={readOnly}
          canRevealEin={access.canRevealEin}
          onRevealEin={() => api.revealEin(tenantId)}
          onLoadIndustries={() => api.listIndustries(tenantId)}
        />
      </SectionCard>

      <SectionCard
        title="Representatives"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<Users className="h-4 w-4 text-primary" />}
        description="The controller and every owner of 25% or more."
      >
        <RepresentativesSection representatives={reps} onChange={onRepsChange} readOnly={readOnly} />
      </SectionCard>

      {!readOnly && (
        <div className="space-y-2">
          {errors.length > 0 && (
            <ul role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-[11px] text-destructive space-y-0.5">
              {errors.map((e) => <li key={e}>• {e}</li>)}
            </ul>
          )}
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Send className="h-3 w-3 mr-1" />}
            Save and submit
          </Button>
        </div>
      )}

      <SectionCard
        title="Documents"
        accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        icon={<FileText className="h-4 w-4 text-sky-500" />}
        description="Identity, business and vetting documents. Stored in ChecksOps and submitted for verification."
      >
        <DocumentsSection tenantId={tenantId} documents={data.documents} readOnly={readOnly} api={api} onChanged={reload} />
      </SectionCard>

      <SectionCard
        title="Terms of Service"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<ClipboardList className="h-4 w-4 text-primary" />}
        description="The ChecksOps Terms of Service must be accepted before money can move."
      >
        {data.account.tos_accepted ? (
          <StatusPill label="Platform terms accepted" done />
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              By accepting, the account holder agrees to the{" "}
              <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">ChecksOps Terms of Service</a>,
              including the{" "}
              <a href="https://moov.io/legal/platform-agreement/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">payment processing terms</a>{" "}
              and{" "}
              <a href="https://moov.io/legal/privacy-policy/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">payments privacy policy</a>.
            </p>
            {readOnly || !access.canAcceptTerms ? (
              <StatusPill label="Not accepted yet" done={false} />
            ) : (
              <Button size="sm" className="h-8 text-xs" onClick={handleAcceptTerms} disabled={tosBusy || !data.account.connected}>
                {tosBusy ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Recording acceptance…</> : "Accept terms"}
              </Button>
            )}
            {!data.account.connected && access.canAcceptTerms && (
              <p className="text-[11px] text-muted-foreground">Save and send your business details first.</p>
            )}
          </div>
        )}
      </SectionCard>

      <UnderwritingQuestionnairePanel tenantId={tenantId} readOnly={readOnly} />

      <SectionCard
        title="Payment Account Setup"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<Landmark className="h-4 w-4 text-primary" />}
        description="Settlement bank account, verified with micro-deposits."
      >
        <BankSection
          tenantId={tenantId}
          banks={data.banks}
          environment={data.environment}
          readOnly={readOnly}
          accountConnected={data.account.connected}
          onChanged={reload}
        />
      </SectionCard>
    </div>
  );
}

function StatusPill({ label, done }: { label: string; done: boolean }) {
  return (
    <div className={`inline-flex items-center gap-2 px-3 py-2 rounded-md border ${done ? "bg-emerald-500/5 border-emerald-500/30" : "bg-amber-500/5 border-amber-500/30"}`}>
      {done ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden /> : <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />}
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}
