import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  EIN_REVEAL_MS,
  digitsOnly,
  maskedEin,
  safeErrorMessage,
  type BusinessForm,
  type OnboardingIndustry,
} from "@/lib/payments/moovOnboarding";

const BUSINESS_TYPES: { value: string; label: string }[] = [
  { value: "privateCorporation", label: "LLC / Private corporation" },
  { value: "soleProprietorship", label: "Sole proprietorship" },
  { value: "partnership", label: "Partnership" },
  { value: "publicCorporation", label: "Public corporation" },
  { value: "incorporatedNonProfit", label: "Incorporated non-profit" },
  { value: "unincorporatedNonProfit", label: "Unincorporated non-profit" },
  { value: "unincorporatedAssociation", label: "Unincorporated association" },
  { value: "trust", label: "Trust" },
];

interface Props {
  form: BusinessForm;
  onChange: (next: BusinessForm) => void;
  einMasked: string | null;
  readOnly: boolean;
  /** Whenever the server returns `can_submit: true` (any tenant member or the platform owner). */
  canRevealEin: boolean;
  onRevealEin: () => Promise<string>;
  /** The payment provider's industry list; loaded once for the Industry field. */
  onLoadIndustries?: () => Promise<OnboardingIndustry[]>;
}

/** Industries grouped under their category, categories and names in display order. */
function groupIndustries(list: OnboardingIndustry[]): Array<[string, OnboardingIndustry[]]> {
  const groups = new Map<string, OnboardingIndustry[]>();
  for (const i of list) {
    const key = i.categoryDisplayName || i.category || "Other";
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, [...v].sort((x, y) => x.displayName.localeCompare(y.displayName))]);
}

export function BusinessSection({ form, onChange, einMasked, readOnly, canRevealEin, onRevealEin, onLoadIndustries }: Props) {
  const { toast } = useToast();
  const set = (patch: Partial<BusinessForm>) => onChange({ ...form, ...patch });

  // The revealed EIN lives only in this component, for a short window.
  const [revealedEin, setRevealedEin] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const [industries, setIndustries] = useState<OnboardingIndustry[] | null>(null);
  const [industriesFailed, setIndustriesFailed] = useState(false);
  useEffect(() => {
    if (!onLoadIndustries) return;
    let live = true;
    onLoadIndustries()
      .then((list) => { if (live) setIndustries(list); })
      .catch(() => { if (live) setIndustriesFailed(true); });
    return () => { live = false; };
    // Loaded once per mount: the list does not depend on the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const industryGroups = groupIndustries(industries ?? []);
  const industryKnown = !form.industry || (industries ?? []).some((i) => i.industry === form.industry);

  async function handleReveal() {
    if (revealedEin) {
      setRevealedEin(null);
      return;
    }
    setRevealing(true);
    try {
      const ein = await onRevealEin();
      setRevealedEin(ein || null);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setRevealedEin(null), EIN_REVEAL_MS);
    } catch (e) {
      toast({ title: "Couldn't reveal the EIN", description: safeErrorMessage(e), variant: "destructive" });
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div className="space-y-4" role="group" aria-label="Business details">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field disabled={readOnly} id="biz-legal-name" label="Legal business name" value={form.legal_name} onChange={(v) => set({ legal_name: v })} />
        <Field disabled={readOnly} id="biz-dba" label="Doing business as (optional)" value={form.dba} onChange={(v) => set({ dba: v })} />
        <div className="space-y-1">
          <Label htmlFor="biz-type" className="text-[11px] text-muted-foreground tracking-wide">Business type</Label>
          <Select value={form.type || undefined} onValueChange={(v) => set({ type: v })} disabled={readOnly}>
            <SelectTrigger id="biz-type" className="h-9"><SelectValue placeholder="Select type" /></SelectTrigger>
            <SelectContent>
              {BUSINESS_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="biz-industry" className="text-[11px] text-muted-foreground tracking-wide">Industry</Label>
          <Select value={form.industry || undefined} onValueChange={(v) => set({ industry: v })} disabled={readOnly || (!industries && !form.industry)}>
            <SelectTrigger id="biz-industry" className="h-9">
              <SelectValue placeholder={industries ? "Select industry" : industriesFailed ? "Industry list unavailable" : "Loading industries…"} />
            </SelectTrigger>
            <SelectContent>
              {!industryKnown && <SelectItem value={form.industry}>{form.industry}</SelectItem>}
              {industryGroups.map(([category, items]) => (
                <SelectGroup key={category}>
                  <SelectLabel className="text-[11px]">{category}</SelectLabel>
                  {items.map((i) => (
                    <SelectItem key={i.industry} value={i.industry}>{i.displayName}</SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="biz-ein" className="text-[11px] text-muted-foreground tracking-wide">EIN</Label>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono" data-testid="ein-masked" aria-live="polite">
              {revealedEin ?? maskedEin(einMasked)}
            </span>
            {canRevealEin && einMasked && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={handleReveal}
                disabled={revealing}
                aria-label={revealedEin ? "Hide EIN" : "Reveal EIN"}
              >
                {revealing ? <Loader2 className="h-3 w-3 animate-spin" /> : revealedEin ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
                {revealedEin ? "Hide" : "Reveal"}
              </Button>
            )}
          </div>
          {!readOnly && (
            <Input
              id="biz-ein"
              type="password"
              autoComplete="off"
              inputMode="numeric"
              className="h-9"
              placeholder={einMasked ? "Enter a new EIN only to change it" : "9-digit EIN"}
              value={form.ein}
              onChange={(e) => set({ ein: digitsOnly(e.target.value, 9) })}
            />
          )}
        </div>

        <Field disabled={readOnly} id="biz-email" label="Business email" type="email" value={form.email} onChange={(v) => set({ email: v })} />
        <Field disabled={readOnly} id="biz-phone" label="Business phone" value={form.phone} onChange={(v) => set({ phone: v })} placeholder="123-456-7890" />
        <Field disabled={readOnly} id="biz-website" label="Website" value={form.website} onChange={(v) => set({ website: v })} placeholder="https://" className="sm:col-span-2" />
      </div>

      <div className="space-y-1">
        <Label htmlFor="biz-description" className="text-[11px] text-muted-foreground tracking-wide">What the business does</Label>
        <Textarea disabled={readOnly} id="biz-description" value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} />
      </div>

      <div className="space-y-3">
        <Label className="text-[11px] text-muted-foreground tracking-wide">Business address</Label>
        <div className="grid gap-3">
          <Field disabled={readOnly} id="biz-line1" label="Street" value={form.line1} onChange={(v) => set({ line1: v })} placeholder="123 Main St" />
          <Field disabled={readOnly} id="biz-line2" label="Suite / unit (optional)" value={form.line2} onChange={(v) => set({ line2: v })} />
          <div className="grid sm:grid-cols-3 gap-3">
            <Field disabled={readOnly} id="biz-city" label="City" value={form.city} onChange={(v) => set({ city: v })} />
            <Field disabled={readOnly} id="biz-state" label="State" value={form.state} onChange={(v) => set({ state: v.toUpperCase().slice(0, 2) })} placeholder="NJ" />
            <Field disabled={readOnly} id="biz-zip" label="ZIP" value={form.postal_code} onChange={(v) => set({ postal_code: v.replace(/[^0-9-]/g, "").slice(0, 10) })} placeholder="07001" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  className = "",
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`space-y-1 ${className}`}>
      <Label htmlFor={id} className="text-[11px] text-muted-foreground tracking-wide">{label}</Label>
      <Input id={id} type={type} value={value} disabled={disabled} readOnly={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-9" />
    </div>
  );
}
