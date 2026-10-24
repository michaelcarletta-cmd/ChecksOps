import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, ShieldCheck, Landmark, AlertCircle, CheckCircle2, UserRound, Clock, Building2, FileCheck2, Plus, Trash2, Link2Off } from "lucide-react";
import { displayCaseOrNull } from "@/lib/displayCase";
import {
  PAYEE_BUSINESS_TYPES,
  PAYEE_LINK_ERRORS,
  PAYEE_MAX_REPRESENTATIVES,
  PAYEE_STEPS,
  PayeeError,
  isPayeeLinkError,
  onlyDigits,
  payeeStepFromSession,
  payeeVerifyMode,
  unwrapPayeeInvoke,
  usPhoneDigits,
  type PayeeSession,
  type PayeeStep,
} from "@/lib/payeeSetup";

/**
 * Public payee setup (/pay-setup/:token). No login: the emailed link token is
 * the only credential. Every step is a server call by name; the page holds no
 * provider token and loads no provider script.
 *
 * Sensitive numbers (SSN, EIN, date of birth, routing and account numbers) are
 * uncontrolled, masked inputs: they are read from the form only when it is
 * submitted, sent once, and cleared from the form right after. They are never
 * kept in React state, browser storage or logs.
 */

async function invoke<T = Record<string, unknown>>(fn: string, body: Record<string, unknown>): Promise<T> {
  return unwrapPayeeInvoke<T>(await supabase.functions.invoke(fn, { body }));
}

/** Reads a sensitive input's digits from the submitted form. */
function readDigits(form: HTMLFormElement, name: string, max: number): string {
  const el = form.elements.namedItem(name) as HTMLInputElement | null;
  return el ? onlyDigits(el.value, max) : "";
}
function readValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name) as HTMLInputElement | null;
  return el ? el.value.trim() : "";
}
/** Clears every sensitive input of the form (after each submit, success or not). */
function clearSensitive(form: HTMLFormElement | null) {
  if (!form) return;
  form.querySelectorAll<HTMLInputElement>("input[data-sensitive]").forEach((el) => { el.value = ""; });
}
const digitsOnInput = (max: number) => (e: React.FormEvent<HTMLInputElement>) => {
  e.currentTarget.value = onlyDigits(e.currentTarget.value, max);
};

const SENSITIVE_PROPS = { "data-sensitive": "true", autoComplete: "off", spellCheck: false } as const;

interface AddressState { line1: string; line2: string; city: string; state: string; postal_code: string }
const emptyAddress: AddressState = { line1: "", line2: "", city: "", state: "", postal_code: "" };

interface RepState {
  key: string;
  first_name: string;
  last_name: string;
  title: string;
  ownership_pct: string;
  is_controller: boolean;
  email: string;
  address: AddressState;
}
let repSeq = 0;
const newRep = (controller: boolean): RepState => ({
  key: `rep-${++repSeq}`, first_name: "", last_name: "", title: "", ownership_pct: "",
  is_controller: controller, email: "", address: { ...emptyAddress },
});

function AddressFields({ prefix, value, onChange, label }: { prefix: string; value: AddressState; onChange: (a: AddressState) => void; label: string }) {
  return (
    <div className="space-y-3">
      <div><Label htmlFor={`${prefix}-line1`}>{label}</Label><Input id={`${prefix}-line1`} required value={value.line1} onChange={(e) => onChange({ ...value, line1: e.target.value })} /></div>
      <div><Label htmlFor={`${prefix}-line2`}>Address line 2 (optional)</Label><Input id={`${prefix}-line2`} value={value.line2} onChange={(e) => onChange({ ...value, line2: e.target.value })} /></div>
      <div className="grid grid-cols-3 gap-3">
        <div><Label htmlFor={`${prefix}-city`}>City</Label><Input id={`${prefix}-city`} required value={value.city} onChange={(e) => onChange({ ...value, city: e.target.value })} /></div>
        <div><Label htmlFor={`${prefix}-state`}>State</Label><Input id={`${prefix}-state`} required maxLength={2} placeholder="TX" value={value.state} onChange={(e) => onChange({ ...value, state: e.target.value.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 2) })} /></div>
        <div><Label htmlFor={`${prefix}-zip`}>ZIP</Label><Input id={`${prefix}-zip`} required inputMode="numeric" value={value.postal_code} onChange={(e) => onChange({ ...value, postal_code: onlyDigits(e.target.value, 5) })} /></div>
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: PayeeStep }) {
  const index = PAYEE_STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center justify-between gap-1 text-[11px]" aria-label="Setup steps">
      {PAYEE_STEPS.map((s, i) => (
        <li key={s.key} className={`flex-1 text-center rounded-full px-2 py-1 border ${i < index ? "border-emerald-500/30 text-emerald-700 bg-emerald-500/5" : i === index ? "border-primary text-primary font-medium" : "border-border text-muted-foreground"}`} aria-current={i === index ? "step" : undefined}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

export default function RecipientPaymentSetup() {
  const { token } = useParams<{ token: string }>();
  const [session, setSession] = useState<PayeeSession | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [replaceBank, setReplaceBank] = useState(false);
  const [editIdentity, setEditIdentity] = useState(false);
  const [termsChecked, setTermsChecked] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  // Non-sensitive identity fields only. SSN, EIN and dates of birth are never in state.
  const [person, setPerson] = useState({ first_name: "", last_name: "", email: "", phone: "", address: { ...emptyAddress } });
  const [business, setBusiness] = useState({ legal_name: "", dba: "", type: "llc", phone: "", email: "", website: "", description: "", address: { ...emptyAddress } });
  const [reps, setReps] = useState<RepState[]>(() => [newRep(true)]);
  const [holder, setHolder] = useState({ holder_name: "", holder_type: "individual", bank_account_type: "checking" });

  function handleFailure(e: unknown) {
    if (e instanceof PayeeError) {
      if (isPayeeLinkError(e.code)) { setLinkError(e.code); return; }
      setError(e.message);
      return;
    }
    setError("Something went wrong. Try again.");
  }

  async function load() {
    setLoading(true); setError(null);
    try { setSession(await invoke("moov-recipient-session", { token }) as PayeeSession); }
    catch (e) { handleFailure(e); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [token]);

  const isBusiness = session?.recipient.recipient_type === "business";
  const hasSession = session !== null;
  useEffect(() => {
    if (hasSession) setHolder((h) => ({ ...h, holder_type: isBusiness ? "business" : "individual" }));
  }, [hasSession, isBusiness]);

  const baseStep: PayeeStep | null = session ? payeeStepFromSession(session, { replaceBank }) : null;
  const step: PayeeStep | null = baseStep && editIdentity && baseStep !== "terms" ? "identity" : baseStep;
  const reviewStatus = session?.onboarding.status ?? session?.recipient.status ?? null;
  const outstanding = (session?.onboarding.identity_requirements_known ? session.onboarding.identity_requirements_outstanding ?? [] : []);

  async function runStep(fn: () => Promise<void>) {
    setSaving(true); setError(null);
    try { await fn(); }
    catch (e) { handleFailure(e); }
    finally { setSaving(false); }
  }

  async function submitTerms() {
    if (!termsChecked) { setError("Check the box to accept the terms before continuing."); return; }
    await runStep(async () => {
      await invoke("moov-recipient-tos-accept", { token, accepted: true });
      await load();
    });
  }

  async function submitIdentity(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    let payload: Record<string, unknown>;
    if (isBusiness) {
      if (!reps.some((r) => r.is_controller)) { setError("Mark one person as the controller of the business."); return; }
      payload = {
        token,
        business: {
          legal_name: business.legal_name.trim(),
          ...(business.dba.trim() ? { dba: business.dba.trim() } : {}),
          type: business.type,
          ein: readDigits(form, "business-ein", 9),
          phone: usPhoneDigits(business.phone),
          ...(business.email.trim() ? { email: business.email.trim() } : {}),
          website: business.website.trim(),
          description: business.description.trim(),
          address: { ...business.address },
        },
        representatives: reps.map((r) => {
          const pct = r.ownership_pct === "" ? null : Number(r.ownership_pct);
          return {
            first_name: r.first_name.trim(),
            last_name: r.last_name.trim(),
            dob: readValue(form, `${r.key}-dob`),
            ssn: readDigits(form, `${r.key}-ssn`, 9),
            title: r.title.trim(),
            ownership_pct: pct,
            is_owner: (pct ?? 0) > 0,
            is_controller: r.is_controller,
            ...(r.email.trim() ? { email: r.email.trim() } : {}),
            address: { ...r.address },
          };
        }),
      };
    } else {
      payload = {
        token,
        first_name: person.first_name.trim(),
        last_name: person.last_name.trim(),
        email: person.email.trim(),
        phone: usPhoneDigits(person.phone),
        address_line1: person.address.line1,
        address_line2: person.address.line2,
        city: person.address.city,
        state: person.address.state,
        postal_code: person.address.postal_code,
        birth_date: readValue(form, "birth_date"),
        ssn: readDigits(form, "ssn", 9),
      };
    }
    clearSensitive(form);
    await runStep(async () => {
      await invoke("moov-recipient-kyc-update", payload);
      setEditIdentity(false);
      await load();
    });
  }

  async function submitBank(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const routing = readDigits(form, "routing_number", 9);
    const account = readDigits(form, "account_number", 17);
    const confirm = readDigits(form, "account_number_confirm", 17);
    clearSensitive(form);
    if (routing.length !== 9) { setError("Routing number must be exactly 9 digits. Enter the bank numbers again."); return; }
    if (account.length < 4) { setError("Account number must be between 4 and 17 digits. Enter the bank numbers again."); return; }
    if (account !== confirm) { setError("The account numbers do not match. Enter the bank numbers again."); return; }
    const payload: Record<string, unknown> = {
      token,
      holder_name: holder.holder_name.trim(),
      holder_type: holder.holder_type,
      bank_account_type: holder.bank_account_type,
      routing_number: routing,
      account_number: account,
      replace_bank: replaceBank,
    };
    await runStep(async () => {
      await invoke("moov-recipient-bank-add", payload);
      setReplaceBank(false);
      await load();
    });
  }

  async function initiateBankVerify() {
    await runStep(async () => {
      await invoke("moov-recipient-bank-verify", { token, action: "initiate" });
      await load();
    });
  }

  async function confirmBankVerify(e: React.FormEvent) {
    e.preventDefault();
    if (verifyCode.length !== 4) { setError("Enter the 4 digits shown after MV on the $0.01 deposit."); return; }
    await runStep(async () => {
      await invoke("moov-recipient-bank-verify", { token, action: "confirm", code: verifyCode });
      setVerifyCode("");
      await load();
    });
  }

  const updateRep = (key: string, patch: Partial<RepState>) => setReps((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const payerName = session?.payer.name || "The sender";
  const terminal = linkError ? PAYEE_LINK_ERRORS[linkError] : null;

  return <main className="min-h-screen bg-background flex items-center justify-center p-4"><div className="w-full max-w-lg space-y-4">
    <header className="text-center space-y-2">
      {session?.payer.logo_url && !terminal && <img src={session.payer.logo_url} alt={`${session.payer.name} logo`} className="h-10 mx-auto object-contain" />}
      <h1 className="text-xl font-semibold">Secure payment setup</h1>
      {session && !terminal && <p className="text-sm text-muted-foreground">{payerName} is setting you up to receive payments by direct deposit.</p>}
    </header>

    {terminal ? (
      <Card><CardContent className="pt-6 space-y-2 text-center">
        <Link2Off className="h-8 w-8 mx-auto text-muted-foreground" />
        <p className="text-sm font-medium">{terminal.title}</p>
        <p className="text-xs text-muted-foreground">{terminal.message}</p>
      </CardContent></Card>
    ) : (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /> {session?.recipient.name ? `Setup for ${session.recipient.name}` : "Payee verification"}</CardTitle>
        <CardDescription className="text-xs">This link resumes where you left off. Completed steps are not repeated.</CardDescription>
        {step && <StepIndicator current={step} />}
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <div className="flex justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading secure setup…</div>}
        {error && <div role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"><AlertCircle className="h-4 w-4 text-destructive shrink-0" /><p className="text-xs text-destructive">{error}</p></div>}

        {!loading && session && step === "terms" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium"><FileCheck2 className="h-4 w-4" /> Accept the terms</div>
            <p className="text-xs text-muted-foreground">
              {payerName} sends payments through a licensed payment processor. To receive them, you agree to the
              processor's terms of service and privacy policy, which cover how your identity and bank details are
              verified and how deposits reach your account.
            </p>
            <div className="flex items-start gap-2">
              <Checkbox id="accept-terms" checked={termsChecked} onCheckedChange={(v) => setTermsChecked(v === true)} />
              <Label htmlFor="accept-terms" className="text-xs leading-snug cursor-pointer">I have read and accept the payment processor's terms of service and privacy policy.</Label>
            </div>
            <Button className="w-full" disabled={!termsChecked || saving} onClick={() => void submitTerms()}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Accept and continue
            </Button>
          </div>
        )}

        {!loading && session && step === "identity" && !isBusiness && (
          <form onSubmit={submitIdentity} className="space-y-4" autoComplete="off">
            <div className="flex items-center gap-2 text-sm font-medium"><UserRound className="h-4 w-4" /> Verify your identity</div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="first_name">Legal first name</Label><Input id="first_name" required value={person.first_name} onChange={(e) => setPerson({ ...person, first_name: e.target.value })} /></div>
              <div><Label htmlFor="last_name">Legal last name</Label><Input id="last_name" required value={person.last_name} onChange={(e) => setPerson({ ...person, last_name: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="birth_date">Date of birth</Label><Input id="birth_date" name="birth_date" type="date" required {...SENSITIVE_PROPS} /></div>
              <div><Label htmlFor="ssn">Social Security number</Label><Input id="ssn" name="ssn" type="password" inputMode="numeric" required minLength={9} maxLength={9} placeholder="9 digits" onInput={digitsOnInput(9)} {...SENSITIVE_PROPS} /></div>
            </div>
            <AddressFields prefix="home" label="Home address" value={person.address} onChange={(address) => setPerson({ ...person, address })} />
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="phone">Mobile phone</Label><Input id="phone" type="tel" inputMode="numeric" required placeholder="10 digits" value={person.phone} onChange={(e) => setPerson({ ...person, phone: usPhoneDigits(e.target.value) })} /></div>
              <div><Label htmlFor="email">Email</Label><Input id="email" type="email" placeholder="Same as the invite if blank" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} /></div>
            </div>
            <p className="text-[11px] text-muted-foreground">Your SSN and date of birth are sent once for identity verification and are not stored by {payerName}. If something needs fixing, you will be asked to enter them again.</p>
            <Button className="w-full" disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Continue securely</Button>
          </form>
        )}

        {!loading && session && step === "identity" && isBusiness && (
          <form onSubmit={submitIdentity} className="space-y-4" autoComplete="off">
            <div className="flex items-center gap-2 text-sm font-medium"><Building2 className="h-4 w-4" /> Verify your business</div>
            <div><Label htmlFor="legal_name">Legal business name</Label><Input id="legal_name" required value={business.legal_name} onChange={(e) => setBusiness({ ...business, legal_name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="dba">Doing business as (optional)</Label><Input id="dba" value={business.dba} onChange={(e) => setBusiness({ ...business, dba: e.target.value })} /></div>
              <div><Label>Business type</Label>
                <Select value={business.type} onValueChange={(v) => setBusiness({ ...business, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{PAYEE_BUSINESS_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div><Label htmlFor="business-ein">EIN{business.type === "soleProprietorship" ? " (optional for a sole proprietorship)" : ""}</Label><Input id="business-ein" name="business-ein" type="password" inputMode="numeric" required={business.type !== "soleProprietorship"} placeholder="9 digits" onInput={digitsOnInput(9)} {...SENSITIVE_PROPS} /></div>
            <AddressFields prefix="business" label="Business address" value={business.address} onChange={(address) => setBusiness({ ...business, address })} />
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="business-phone">Business phone</Label><Input id="business-phone" type="tel" inputMode="numeric" required placeholder="10 digits" value={business.phone} onChange={(e) => setBusiness({ ...business, phone: usPhoneDigits(e.target.value) })} /></div>
              <div><Label htmlFor="business-email">Business email</Label><Input id="business-email" type="email" placeholder="Same as the invite if blank" value={business.email} onChange={(e) => setBusiness({ ...business, email: e.target.value })} /></div>
            </div>
            <div><Label htmlFor="website">Website</Label><Input id="website" placeholder="yourcompany.com" value={business.website} onChange={(e) => setBusiness({ ...business, website: e.target.value })} /></div>
            <div><Label htmlFor="description">What the business does {business.website.trim() ? "(optional)" : "(required without a website)"}</Label><Textarea id="description" rows={2} maxLength={300} required={!business.website.trim()} value={business.description} onChange={(e) => setBusiness({ ...business, description: e.target.value })} /></div>

            <div className="space-y-2 pt-2 border-t">
              <p className="text-sm font-medium">Owners and controller</p>
              <p className="text-[11px] text-muted-foreground">Add each person who owns 25% or more, and the one person who controls the business (for example the CEO or managing member).</p>
            </div>
            {reps.map((r, i) => (
              <div key={r.key} className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between"><p className="text-xs font-medium">Person {i + 1}</p>
                  {reps.length > 1 && <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setReps((list) => list.filter((x) => x.key !== r.key))}><Trash2 className="h-3 w-3 mr-1" /> Remove</Button>}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label htmlFor={`${r.key}-first`}>Legal first name</Label><Input id={`${r.key}-first`} required value={r.first_name} onChange={(e) => updateRep(r.key, { first_name: e.target.value })} /></div>
                  <div><Label htmlFor={`${r.key}-last`}>Legal last name</Label><Input id={`${r.key}-last`} required value={r.last_name} onChange={(e) => updateRep(r.key, { last_name: e.target.value })} /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label htmlFor={`${r.key}-dob`}>Date of birth</Label><Input id={`${r.key}-dob`} name={`${r.key}-dob`} type="date" required {...SENSITIVE_PROPS} /></div>
                  <div><Label htmlFor={`${r.key}-ssn`}>SSN</Label><Input id={`${r.key}-ssn`} name={`${r.key}-ssn`} type="password" inputMode="numeric" required minLength={9} maxLength={9} placeholder="9 digits" onInput={digitsOnInput(9)} {...SENSITIVE_PROPS} /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label htmlFor={`${r.key}-title`}>Title</Label><Input id={`${r.key}-title`} required placeholder="Owner, CEO…" value={r.title} onChange={(e) => updateRep(r.key, { title: e.target.value })} /></div>
                  <div><Label htmlFor={`${r.key}-pct`}>Ownership %</Label><Input id={`${r.key}-pct`} type="number" min={0} max={100} step="0.01" placeholder="0–100" value={r.ownership_pct} onChange={(e) => updateRep(r.key, { ownership_pct: e.target.value })} /></div>
                </div>
                <div><Label htmlFor={`${r.key}-email`}>Email (optional)</Label><Input id={`${r.key}-email`} type="email" value={r.email} onChange={(e) => updateRep(r.key, { email: e.target.value })} /></div>
                <AddressFields prefix={r.key} label="Home address" value={r.address} onChange={(address) => updateRep(r.key, { address })} />
                <div className="flex items-center gap-2">
                  <Checkbox id={`${r.key}-controller`} checked={r.is_controller} onCheckedChange={(v) => setReps((list) => list.map((x) => ({ ...x, is_controller: x.key === r.key ? v === true : (v === true ? false : x.is_controller) })))} />
                  <Label htmlFor={`${r.key}-controller`} className="text-xs cursor-pointer">This person controls the business</Label>
                </div>
              </div>
            ))}
            {reps.length < PAYEE_MAX_REPRESENTATIVES && (
              <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setReps((list) => [...list, newRep(false)])}><Plus className="h-3 w-3 mr-1" /> Add another person</Button>
            )}
            <p className="text-[11px] text-muted-foreground">The EIN, SSNs and dates of birth are sent once for verification and are not stored by {payerName}. If something needs fixing, you will be asked to enter them again.</p>
            <Button className="w-full" disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Continue securely</Button>
          </form>
        )}

        {!loading && session && step === "bank" && (
          <form onSubmit={submitBank} className="space-y-4" autoComplete="off">
            <div className="flex items-center gap-2 text-sm font-medium"><Landmark className="h-4 w-4" /> Add your bank account</div>
            <div><Label htmlFor="holder_name">Account holder name</Label><Input id="holder_name" required minLength={2} placeholder="As it appears at the bank" value={holder.holder_name} onChange={(e) => setHolder({ ...holder, holder_name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Account owner</Label><Select value={holder.holder_type} onValueChange={(v) => setHolder({ ...holder, holder_type: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="individual">Individual</SelectItem><SelectItem value="business">Business</SelectItem></SelectContent></Select></div>
              <div><Label>Account type</Label><Select value={holder.bank_account_type} onValueChange={(v) => setHolder({ ...holder, bank_account_type: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="checking">Checking</SelectItem><SelectItem value="savings">Savings</SelectItem></SelectContent></Select></div>
            </div>
            <div><Label htmlFor="routing_number">Routing number</Label><Input id="routing_number" name="routing_number" required inputMode="numeric" minLength={9} maxLength={9} placeholder="9 digits" onInput={digitsOnInput(9)} {...SENSITIVE_PROPS} /></div>
            <div><Label htmlFor="account_number">Account number</Label><Input id="account_number" name="account_number" type="password" required inputMode="numeric" minLength={4} maxLength={17} onInput={digitsOnInput(17)} {...SENSITIVE_PROPS} /></div>
            <div><Label htmlFor="account_number_confirm">Confirm account number</Label><Input id="account_number_confirm" name="account_number_confirm" type="password" required inputMode="numeric" minLength={4} maxLength={17} onInput={digitsOnInput(17)} onPaste={(e) => e.preventDefault()} {...SENSITIVE_PROPS} /></div>
            <p className="text-[11px] text-muted-foreground">Only the bank name and the last four digits are kept. The full numbers are sent once to set up deposits.</p>
            <Button className="w-full" disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Add bank account</Button>
            {replaceBank && <Button type="button" variant="ghost" className="w-full" onClick={() => setReplaceBank(false)}>Keep the current bank account</Button>}
          </form>
        )}

        {!loading && session && step === "verify" && (
          <div className="space-y-3">
            <div className="flex gap-2 rounded-md border border-emerald-500/30 p-3"><CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" /><p className="text-xs">{displayCaseOrNull(session.recipient.bank_name) ?? "Your bank"}{session.recipient.last_four ? ` ••••${session.recipient.last_four}` : ""} is added. Confirm it with a $0.01 test deposit.</p></div>
            {payeeVerifyMode(session) === "initiate" && (
              <div className="space-y-3">
                <p className="text-[11px] text-muted-foreground">We will send $0.01 to this account. Its description shows <span className="font-mono">MV</span> followed by a 4-digit code. It usually arrives within minutes; you can come back with this same link.</p>
                <Button className="w-full" disabled={saving} onClick={() => void initiateBankVerify()}>
                  {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Send verification deposit
                </Button>
              </div>
            )}
            {payeeVerifyMode(session) === "confirm" && (
              <form onSubmit={confirmBankVerify} className="space-y-3">
                <div className="flex items-center gap-2 text-amber-600"><Clock className="h-4 w-4" /><span className="text-xs font-medium">Verification deposit sent</span></div>
                <p className="text-[11px] text-muted-foreground">Find the $0.01 deposit in this bank account and enter the 4 digits after MV in its description.</p>
                {session.environment === "sandbox" && <p className="text-[11px] text-muted-foreground">Test mode code: 0001</p>}
                <div>
                  <Label htmlFor="verify-code">Verification code</Label>
                  <div className="flex items-center gap-2"><span className="font-mono text-sm px-2 py-2 rounded-md border bg-muted">MV</span><Input id="verify-code" inputMode="numeric" required maxLength={4} value={verifyCode} onChange={(e) => setVerifyCode(onlyDigits(e.target.value, 4))} placeholder="4 digits" className="font-mono" /></div>
                </div>
                <Button className="w-full" disabled={saving || verifyCode.length !== 4}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Confirm bank account</Button>
                {session.onboarding.bank_should_initiate && <Button type="button" variant="outline" className="w-full" disabled={saving} onClick={() => void initiateBankVerify()}>Send a new verification deposit</Button>}
              </form>
            )}
            {payeeVerifyMode(session) === "wait" && (
              <p className="text-[11px] text-muted-foreground">Your bank account is being checked. Come back with this same link in a little while to finish.</p>
            )}
            <Button variant="outline" className="w-full" disabled={saving} onClick={() => { setError(null); setReplaceBank(true); }}>Use a different bank account</Button>
          </div>
        )}

        {!loading && session && step === "done" && (
          session.onboarding.complete === true ? (
            <div className="flex gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3"><CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" /><p className="text-xs text-emerald-700">You're all set. {payerName} can now pay you by direct deposit. You can close this page.</p></div>
          ) : reviewStatus === "failed" ? (
            <div className="space-y-3">
              <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"><AlertCircle className="h-4 w-4 text-destructive shrink-0" /><p className="text-xs">We could not verify these details. Check them and submit again, or contact {payerName}.</p></div>
              <Button variant="outline" className="w-full" onClick={() => { setError(null); setEditIdentity(true); }}>Update identity details</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"><Clock className="h-4 w-4 text-amber-600 shrink-0" /><p className="text-xs">Thanks — your details are submitted and under review. This usually takes a short time. You can close this page and reopen the link later to check.</p></div>
              {outstanding.length > 0 && (
                <Button variant="outline" className="w-full" onClick={() => { setError(null); setEditIdentity(true); }}>More information is needed — update identity details</Button>
              )}
            </div>
          )
        )}
        {!loading && editIdentity && step === "identity" && (
          <Button variant="ghost" className="w-full" onClick={() => setEditIdentity(false)}>Back</Button>
        )}
      </CardContent>
    </Card>
    )}
    <p className="text-[11px] text-muted-foreground text-center">Identity and bank numbers are sent over an encrypted connection for verification only and are never shown back on this page.</p>
  </div></main>;
}
