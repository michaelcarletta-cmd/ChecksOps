import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Plus, Trash2, UserRound } from "lucide-react";
import {
  digitsOnly,
  emptyRepresentativeForm,
  maskedSsn,
  type RepresentativeForm,
} from "@/lib/payments/moovOnboarding";
import { Field } from "./BusinessSection";

interface Props {
  representatives: RepresentativeForm[];
  onChange: (next: RepresentativeForm[]) => void;
  readOnly: boolean;
}

/**
 * Business representatives (controller + beneficial owners).
 *
 * The SSN is a password-style, write-only input: it is never prefilled and a
 * saved representative only ever shows the last four digits from the server.
 */
export function RepresentativesSection({ representatives, onChange, readOnly }: Props) {
  const update = (key: string, patch: Partial<RepresentativeForm>) =>
    onChange(representatives.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const setController = (key: string) =>
    onChange(representatives.map((r) => ({ ...r, is_controller: r.key === key })));

  const remove = (key: string) => onChange(representatives.filter((r) => r.key !== key));

  const add = () => onChange([...representatives, emptyRepresentativeForm(representatives.length === 0)]);

  return (
    <div className="space-y-3">
      {representatives.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {readOnly ? "No representatives on file." : "Add the business controller and anyone who owns 25% or more."}
        </p>
      )}

      {representatives.map((r, idx) => {
        const p = `rep-${idx}`;
        return (
          <div key={r.key} className="rounded-md border border-border p-3 space-y-3" role="group" aria-label={`Representative ${idx + 1}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium">
                <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                {r.name.trim() || `Representative ${idx + 1}`}
                {r.is_controller && <span className="text-[10px] text-primary">Controller</span>}
              </div>
              {!readOnly && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-destructive"
                  onClick={() => remove(r.key)}
                  aria-label={`Remove ${r.name.trim() || `representative ${idx + 1}`}`}
                >
                  <Trash2 className="h-3 w-3 mr-1" /> Remove
                </Button>
              )}
            </div>

            {r.ssn_resubmit_required && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px]">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-px shrink-0" />
                Moov needs this person's SSN again. Please re-enter it and save.
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-3">
              <Field disabled={readOnly} id={`${p}-name`} label="Full legal name" value={r.name} onChange={(v) => update(r.key, { name: v })} />
              <Field disabled={readOnly} id={`${p}-title`} label="Job title" value={r.title} onChange={(v) => update(r.key, { title: v })} />
              <Field disabled={readOnly} id={`${p}-email`} label="Email" type="email" value={r.email} onChange={(v) => update(r.key, { email: v })} />
              <Field disabled={readOnly} id={`${p}-phone`} label="Phone" value={r.phone} onChange={(v) => update(r.key, { phone: v })} />

              <div className="space-y-1">
                <Label htmlFor={`${p}-ssn`} className="text-[11px] text-muted-foreground tracking-wide">SSN</Label>
                {r.ssn_last4 && (
                  <p className="text-xs font-mono" data-testid="ssn-last4">On file: {maskedSsn(r.ssn_last4)}</p>
                )}
                {!readOnly && (
                  <Input
                    id={`${p}-ssn`}
                    type="password"
                    autoComplete="off"
                    inputMode="numeric"
                    spellCheck={false}
                    className="h-9"
                    placeholder={r.ssn_last4 ? "Enter a new SSN only to change it" : "9-digit SSN"}
                    value={r.ssn}
                    onChange={(e) => update(r.key, { ssn: digitsOnly(e.target.value, 9) })}
                  />
                )}
                {readOnly && !r.ssn_last4 && <p className="text-xs text-muted-foreground">Not on file</p>}
              </div>

              <div className="space-y-1">
                <Label htmlFor={`${p}-dob`} className="text-[11px] text-muted-foreground tracking-wide">Date of birth</Label>
                {r.dob_masked && <p className="text-xs font-mono">On file: {r.dob_masked}</p>}
                {!readOnly && (
                  <Input
                    id={`${p}-dob`}
                    type="date"
                    autoComplete="off"
                    className="h-9"
                    value={r.dob}
                    onChange={(e) => update(r.key, { dob: e.target.value })}
                  />
                )}
                {readOnly && !r.dob_masked && <p className="text-xs text-muted-foreground">Not on file</p>}
              </div>

              <Field disabled={readOnly} id={`${p}-line1`} label="Home address" value={r.line1} onChange={(v) => update(r.key, { line1: v })} className="sm:col-span-2" />
              <Field disabled={readOnly} id={`${p}-city`} label="City" value={r.city} onChange={(v) => update(r.key, { city: v })} />
              <div className="grid grid-cols-2 gap-3">
                <Field disabled={readOnly} id={`${p}-state`} label="State" value={r.state} onChange={(v) => update(r.key, { state: v.toUpperCase().slice(0, 2) })} />
                <Field disabled={readOnly} id={`${p}-zip`} label="ZIP" value={r.postal_code} onChange={(v) => update(r.key, { postal_code: v.replace(/[^0-9-]/g, "").slice(0, 10) })} />
              </div>
              <Field
                disabled={readOnly}
                id={`${p}-ownership`}
                label="Ownership (%)"
                value={r.ownership_pct}
                onChange={(v) => update(r.key, { ownership_pct: v.replace(/[^0-9.]/g, "").slice(0, 6) })}
              />
              <div className="flex items-center gap-2 pt-5">
                <Checkbox
                  id={`${p}-controller`}
                  checked={r.is_controller}
                  disabled={readOnly}
                  onCheckedChange={(v) => (v ? setController(r.key) : update(r.key, { is_controller: false }))}
                />
                <Label htmlFor={`${p}-controller`} className="text-xs">Controller (manages the business)</Label>
              </div>
            </div>
          </div>
        );
      })}

      {!readOnly && (
        <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={add}>
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Add representative
        </Button>
      )}
    </div>
  );
}
