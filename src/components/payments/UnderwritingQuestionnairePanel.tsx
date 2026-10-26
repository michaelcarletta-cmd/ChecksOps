import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ClipboardList, Loader2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  BUSINESS_PRESENCE_OPTIONS,
  EMPTY_UNDERWRITING_ANSWERS as EMPTY,
  GEOGRAPHIC_REACH_OPTIONS,
  MONTHLY_VOLUME_OPTIONS,
  PENDING_LITIGATION_OPTIONS,
  answersFromUnderwriting,
  buildUnderwritingPayload,
  needsExtendedUnderwriting,
  type UnderwritingAnswers as Answers,
} from "@/lib/underwritingPayload";

/** Plain words for provider error codes; the provider is never named. */
const plainError = (code: string) =>
  code === "moov_rejected"
    ? "These answers were not accepted. Check your choices and try again."
    : /^moov_/.test(code)
      ? "Payment setup is unavailable right now. Try again in a few minutes."
      : code;

async function invoke(fn: string, body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message ?? "Request failed";
    try {
      const parsed = await (error as any).context?.json?.();
      if (parsed?.error) message = parsed.error;
    } catch { /* keep original */ }
    throw new Error(plainError(message));
  }
  if ((data as any)?.error) throw new Error(plainError((data as any).error));
  return data as any;
}

/**
 * Expected-activity questions the payment provider asks before an
 * organization can move money. Answers are written straight to the provider,
 * so the tenant never has to complete them outside ChecksOps.
 */
export function UnderwritingQuestionnairePanel({
  tenantId,
  readOnly = false,
}: {
  tenantId?: string | null;
  /** Status-only view for roles that may not submit. */
  readOnly?: boolean;
}) {
  const { toast } = useToast();
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [onFile, setOnFile] = useState(false);

  const set = (patch: Partial<Answers>) => setAnswers((a) => ({ ...a, ...patch }));
  const extended = needsExtendedUnderwriting(answers);

  const textField = (key: keyof Answers, label: string, placeholder: string) => (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        inputMode="numeric"
        value={answers[key]}
        onChange={(e) => set({ [key]: e.target.value } as Partial<Answers>)}
        placeholder={placeholder}
        disabled={readOnly}
      />
    </div>
  );

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const res = await invoke("moov-underwriting", { tenant_id: tenantId, action: "get" });
      const u = res?.underwriting;
      if (u) {
        const prefill = answersFromUnderwriting(u);
        setOnFile(Boolean(prefill.geographicReach || prefill.sendAchMonthlyVolume || prefill.collectAchMonthlyVolume));
        setAnswers(prefill);
      }
    } catch {
      /* Nothing on file yet — the blank form is the correct state. */
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  async function handleSave() {
    if (!tenantId) return;
    const built = buildUnderwritingPayload(answers);
    if (!built.ok) {
      toast({ title: "Check your answers", description: built.message, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await invoke("moov-underwriting", { tenant_id: tenantId, action: "save", answers: built.payload });
      setOnFile(true);
      toast({ title: "Answers submitted", description: "Your expected activity was sent to the payment provider." });
    } catch (e: any) {
      toast({ title: "Couldn't submit answers", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!tenantId) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              Expected Payment Activity
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              A few questions about how you'll use payments. Answers go straight to our payment
              provider — you don't need to fill anything out anywhere else.
            </CardDescription>
          </div>
          {onFile && (
            <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-500 shrink-0">
              On file
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your answers…
          </div>
        ) : null}

        <fieldset disabled={readOnly} className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Where are your customers located?</Label>
          <Select value={answers.geographicReach} onValueChange={(v) => set({ geographicReach: v })} disabled={readOnly}>
            <SelectTrigger><SelectValue placeholder="Choose where your customers are" /></SelectTrigger>
            <SelectContent>
              {GEOGRAPHIC_REACH_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Monthly volume of ACH payments you send</Label>
            <Select value={answers.sendAchMonthlyVolume} onValueChange={(v) => set({ sendAchMonthlyVolume: v })} disabled={readOnly}>
              <SelectTrigger><SelectValue placeholder="Estimated monthly volume" /></SelectTrigger>
              <SelectContent>
                {MONTHLY_VOLUME_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Monthly volume of ACH payments you accept</Label>
            <Select value={answers.collectAchMonthlyVolume} onValueChange={(v) => set({ collectAchMonthlyVolume: v })} disabled={readOnly}>
              <SelectTrigger><SelectValue placeholder="Estimated monthly volume" /></SelectTrigger>
              <SelectContent>
                {MONTHLY_VOLUME_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-3 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            {extended
              ? "Because your monthly volume is $10,000 or more, these answers are required."
              : "Required once either monthly volume is $10,000 or more; optional below that."}
          </p>

          <div className="grid sm:grid-cols-2 gap-3">
            {textField("sendAchAverageAmount", "Average ACH payment you send ($)", "e.g. 2500")}
            {textField("sendAchMaximumAmount", "Largest ACH payment you send ($)", "e.g. 25000")}
            {textField("collectAchAverageAmount", "Average ACH payment you accept ($)", "e.g. 2500")}
            {textField("collectAchMaximumAmount", "Largest ACH payment you accept ($)", "e.g. 25000")}
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Where does your business operate?</Label>
              <Select value={answers.businessPresence} onValueChange={(v) => set({ businessPresence: v })} disabled={readOnly}>
                <SelectTrigger><SelectValue placeholder="Choose your business presence" /></SelectTrigger>
                <SelectContent>
                  {BUSINESS_PRESENCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Pending litigation</Label>
              <Select value={answers.pendingLitigation} onValueChange={(v) => set({ pendingLitigation: v })} disabled={readOnly}>
                <SelectTrigger><SelectValue placeholder="Choose None if there is none" /></SelectTrigger>
                <SelectContent>
                  {PENDING_LITIGATION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Share of your payment volume by customer type (whole %, totals 100)</Label>
            <div className="grid grid-cols-3 gap-3">
              {textField("businessSharePercent", "Businesses", "e.g. 80")}
              {textField("consumerSharePercent", "Consumers", "e.g. 20")}
              {textField("p2pSharePercent", "Person to person", "0")}
            </div>
          </div>
        </div>

        </fieldset>

        {!readOnly && (
        <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={saving}>
          {saving
            ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Submitting…</>
            : <><Save className="h-3.5 w-3.5 mr-1.5" /> {onFile ? "Update answers" : "Submit answers"}</>}
        </Button>
        )}
      </CardContent>
    </Card>
  );
}
