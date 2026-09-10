import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { applyMoovTheme } from "@/lib/payments/moovTheme";
import { Loader2, ShieldCheck, Landmark, AlertCircle, CheckCircle2, UserRound, Clock } from "lucide-react";

interface SessionData {
  recipient: { id: string; name: string; status: string; bank_linked?: boolean; bank_name?: string | null; last_four?: string | null };
  onboarding?: {
    terms_accepted?: boolean;
    tos_requirement_outstanding?: boolean;
    verification_status?: string;
    identity_requirements_outstanding?: string[];
    identity_requirements_known?: boolean;
    bank_verified?: boolean;
    bank_status?: string | null;
    bank_verification_method?: string | null;
    bank_verification_status?: string | null;
    bank_micro_deposits_initiated?: boolean;
    bank_can_confirm?: boolean;
    bank_should_initiate?: boolean;
    complete?: boolean;
    live?: boolean;
  };
  payer: { name: string; logo_url: string | null; primary_color?: string | null; secondary_color?: string | null };
  account_id: string;
  environment: string;
  token?: string;
}

async function invoke(fn: string, body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message ?? "Request failed";
    try { const parsed = await (error as any).context?.json?.(); if (parsed?.error) message = parsed.error; } catch { /* noop */ }
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as any;
}

function MoovTermsDrop({ oauthToken, accountId, onToken }: { oauthToken: string; accountId: string; onToken: (t: string) => void }) {
  const elRef = useRef<HTMLElement | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    const el = elRef.current as any;
    if (!el) return;
    el.oauthToken = oauthToken;
    el.token = oauthToken;
    el.accountID = accountId;
    el.onTermsOfServiceTokenReady = (acceptanceToken: string) => {
      if (acceptanceToken) onTokenRef.current(acceptanceToken);
    };
  }, [oauthToken, accountId]);

  return createElement("moov-terms-of-service", { ref: elRef });
}

let moovJsPromise: Promise<void> | null = null;
function loadMoovJs(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as any).customElements?.get?.("moov-terms-of-service")) return Promise.resolve();
  if (moovJsPromise) return moovJsPromise;
  moovJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://js.moov.io/v1";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the payment provider's secure component."));
    document.head.appendChild(script);
  });
  return moovJsPromise;
}

export default function RecipientPaymentSetup() {
  const { token } = useParams<{ token: string }>();
  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [replaceBank, setReplaceBank] = useState(false);
  const [tosReady, setTosReady] = useState(false);
  const [tosDropToken, setTosDropToken] = useState<string | null>(null);
  const [identity, setIdentity] = useState({
    first_name: "", last_name: "", email: "", phone: "", address_line1: "", address_line2: "",
    city: "", state: "", postal_code: "", birth_date: "", ssn: "",
  });
  const [bank, setBank] = useState({
    holder_name: "", holder_type: "individual", bank_account_type: "checking", routing_number: "", account_number: "",
  });
  const [verifyCode, setVerifyCode] = useState("");

  useEffect(
    () => applyMoovTheme({ primary: session?.payer.primary_color ?? null, secondary: session?.payer.secondary_color ?? null }),
    [session?.payer.primary_color, session?.payer.secondary_color],
  );

  async function load() {
    setLoading(true); setError(null);
    try { setSession(await invoke("moov-recipient-session", { token })); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [token]);

  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    (async () => {
      try {
        await loadMoovJs();
        if (!cancelled) setTosReady(true);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [session?.token]);

  const verified = session?.onboarding?.verification_status === "verified";
  const termsAccepted = Boolean(session?.onboarding?.terms_accepted);
  const identityOutstanding = session?.onboarding?.identity_requirements_outstanding ?? [];
  const identityKnown = session?.onboarding?.identity_requirements_known === true;
  const needsIdentity = identityKnown ? identityOutstanding.length > 0 : !verified;
  const liveComplete = session?.onboarding?.complete === true;
  const bankVerified = Boolean(session?.onboarding?.bank_verified);
  const bankAlreadyLinked = Boolean(session?.recipient.bank_linked) && !replaceBank;
  const bankShouldInitiate = Boolean(session?.onboarding?.bank_should_initiate);
  const bankCanConfirm = Boolean(session?.onboarding?.bank_can_confirm) || Boolean(session?.onboarding?.bank_micro_deposits_initiated);
  const isSandbox = session?.environment === "sandbox";
  const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);

  const handleDropToken = useCallback((acceptanceToken: string) => {
    setTosDropToken(acceptanceToken);
  }, []);

  async function submitIdentity(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError(null);
    try {
      await invoke("moov-recipient-kyc-update", { token, ...identity });
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function submitTerms() {
    if (!tosDropToken) {
      setError("Accept the payment provider's terms in the hosted component first.");
      return;
    }
    setSaving(true); setError(null);
    try {
      await invoke("moov-recipient-tos-accept", {
        token,
        terms_of_service_token: tosDropToken,
      });
      setTosDropToken(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function submitBank(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError(null);
    try {
      await invoke("moov-recipient-bank-add", { token, ...bank, replace_bank: replaceBank });
      setReplaceBank(false);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function initiateBankVerify() {
    setSaving(true); setError(null);
    try {
      await invoke("moov-recipient-bank-verify", { token, action: "initiate" });
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function confirmBankVerify(e: React.FormEvent) {
    e.preventDefault();
    if (verifyCode.length !== 4) {
      setError("Enter the 4-digit verification code from the $0.01 deposit.");
      return;
    }
    setSaving(true); setError(null);
    try {
      await invoke("moov-recipient-bank-verify", { token, action: "confirm", code: verifyCode });
      setVerifyCode("");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  return <main className="min-h-screen bg-background flex items-center justify-center p-4"><div className="w-full max-w-lg space-y-4">
    <header className="text-center space-y-2">{session?.payer.logo_url && <img src={session.payer.logo_url} alt={`${session.payer.name} logo`} className="h-10 mx-auto object-contain" />}<h1 className="text-xl font-semibold">Secure payment setup</h1>{session && <p className="text-sm text-muted-foreground">{session.payer.name} is setting you up to receive a payment.</p>}</header>
    <Card><CardHeader><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /> Recipient verification</CardTitle><CardDescription className="text-xs">Your existing secure link resumes the same payment-provider account. Completed steps will not be repeated.</CardDescription></CardHeader><CardContent className="space-y-4">
      {loading && <div className="flex justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading secure setup…</div>}
      {error && <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"><AlertCircle className="h-4 w-4 text-destructive shrink-0" /><p className="text-xs text-destructive">{error}</p></div>}
      {!loading && session && needsIdentity && <form onSubmit={submitIdentity} className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium"><UserRound className="h-4 w-4" /> Verify your identity</div>
        <div className="grid grid-cols-2 gap-3"><div><Label>First name</Label><Input required value={identity.first_name} onChange={e=>setIdentity({...identity,first_name:e.target.value})}/></div><div><Label>Last name</Label><Input required value={identity.last_name} onChange={e=>setIdentity({...identity,last_name:e.target.value})}/></div></div>
        <div><Label>Email</Label><Input type="email" required value={identity.email} onChange={e=>setIdentity({...identity,email:e.target.value})}/></div>
        <div><Label>Mobile phone</Label><Input inputMode="numeric" required value={identity.phone} onChange={e=>setIdentity({...identity,phone:digits(e.target.value,10)})}/></div>
        <div><Label>Residential address</Label><Input required value={identity.address_line1} onChange={e=>setIdentity({...identity,address_line1:e.target.value})}/></div>
        <div><Label>Address line 2</Label><Input value={identity.address_line2} onChange={e=>setIdentity({...identity,address_line2:e.target.value})}/></div>
        <div className="grid grid-cols-3 gap-3"><div><Label>City</Label><Input required value={identity.city} onChange={e=>setIdentity({...identity,city:e.target.value})}/></div><div><Label>State</Label><Input required maxLength={2} value={identity.state} onChange={e=>setIdentity({...identity,state:e.target.value.toUpperCase()})}/></div><div><Label>ZIP</Label><Input required inputMode="numeric" value={identity.postal_code} onChange={e=>setIdentity({...identity,postal_code:digits(e.target.value,5)})}/></div></div>
        <div className="grid grid-cols-2 gap-3"><div><Label>Date of birth</Label><Input type="date" required value={identity.birth_date} onChange={e=>setIdentity({...identity,birth_date:e.target.value})}/></div><div><Label>SSN</Label><Input type="password" inputMode="numeric" required placeholder="9 digits" value={identity.ssn} onChange={e=>setIdentity({...identity,ssn:digits(e.target.value,9)})}/></div></div>
        <Button className="w-full" disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Continue securely</Button>
      </form>}
      {!loading && session && !needsIdentity && !termsAccepted && (
        <div className="space-y-3">
          <div className="flex gap-2 rounded-md border border-emerald-500/30 p-3"><CheckCircle2 className="h-4 w-4 text-emerald-500"/><p className="text-xs">Identity details were submitted. Accept the payment provider's terms to continue.</p></div>
          <div className="rounded-md border border-border/60 bg-muted/30 p-3">
            {tosReady && session.token ? (
              <MoovTermsDrop oauthToken={session.token} accountId={session.account_id} onToken={handleDropToken} />
            ) : (
              <p className="text-[11px] text-muted-foreground">Loading the payment provider's Terms of Service…</p>
            )}
          </div>
          <Button className="w-full" disabled={!tosDropToken || saving} onClick={() => void submitTerms()}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Record agreement and continue
          </Button>
        </div>
      )}
      {!loading && session && !needsIdentity && termsAccepted && !liveComplete && bankAlreadyLinked && (
        <div className="space-y-3">
          <div className="flex gap-2 rounded-md border border-emerald-500/30 p-3"><CheckCircle2 className="h-4 w-4 text-emerald-500"/><p className="text-xs">Identity and agreement are recorded. {session.recipient.bank_name ?? "Your bank"}{session.recipient.last_four ? ` ••••${session.recipient.last_four}` : ""} is connected{bankVerified ? " and verified." : "."}</p></div>
          {!bankVerified && bankShouldInitiate && !bankCanConfirm && (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">Confirm this bank with a $0.01 verification deposit. A 4-digit code will appear on the deposit as MV••••. You can return with this same link after it arrives.</p>
              <Button className="w-full" disabled={saving} onClick={() => void initiateBankVerify()}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Send verification deposit
              </Button>
            </div>
          )}
          {!bankVerified && bankCanConfirm && (
            <form onSubmit={confirmBankVerify} className="space-y-3">
              <div className="flex items-center gap-2 text-amber-600"><Clock className="h-4 w-4" /><span className="text-xs font-medium">Verification deposit sent</span></div>
              <p className="text-[11px] text-muted-foreground">Enter the 4 digits shown after MV on the $0.01 deposit in this bank account.</p>
              {isSandbox && <p className="text-[11px] text-muted-foreground">Test mode code: 0001</p>}
              <div><Label>Verification code</Label><Input inputMode="numeric" required maxLength={4} value={verifyCode} onChange={e=>setVerifyCode(digits(e.target.value,4))} placeholder="4 digits" /></div>
              <Button className="w-full" disabled={saving || verifyCode.length !== 4}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Confirm bank verification</Button>
              {bankShouldInitiate && <Button type="button" variant="outline" className="w-full" disabled={saving} onClick={() => void initiateBankVerify()}>Send a new verification deposit</Button>}
            </form>
          )}
          <Button variant="outline" className="w-full" onClick={()=>setReplaceBank(true)}>Use a different bank account</Button>
        </div>
      )}
      {!loading && session && !needsIdentity && termsAccepted && !liveComplete && !bankAlreadyLinked && (
        <form onSubmit={submitBank} className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium"><Landmark className="h-4 w-4"/> Connect your payout bank</div>
          <div><Label>Account holder name</Label><Input required value={bank.holder_name} onChange={e=>setBank({...bank,holder_name:e.target.value})}/></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Owner</Label><Select value={bank.holder_type} onValueChange={v=>setBank({...bank,holder_type:v})}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="individual">Individual</SelectItem><SelectItem value="business">Business</SelectItem></SelectContent></Select></div>
            <div><Label>Account type</Label><Select value={bank.bank_account_type} onValueChange={v=>setBank({...bank,bank_account_type:v})}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="checking">Checking</SelectItem><SelectItem value="savings">Savings</SelectItem></SelectContent></Select></div>
          </div>
          <div><Label>Routing number</Label><Input required inputMode="numeric" value={bank.routing_number} onChange={e=>setBank({...bank,routing_number:digits(e.target.value,9)})}/></div>
          <div><Label>Account number</Label><Input required type="password" inputMode="numeric" value={bank.account_number} onChange={e=>setBank({...bank,account_number:digits(e.target.value,17)})}/></div>
          <Button className="w-full" disabled={saving||bank.routing_number.length!==9||bank.account_number.length<4}>{saving&&<Loader2 className="h-4 w-4 mr-2 animate-spin"/>}Connect bank account</Button>
        </form>
      )}
      {liveComplete && <div className="flex gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3"><CheckCircle2 className="h-4 w-4 text-emerald-500"/><p className="text-xs text-emerald-600">Setup is complete. You can close this page.</p></div>}
    </CardContent></Card>
    <p className="text-[11px] text-muted-foreground text-center">Sensitive identity and bank information is submitted only for payment-provider verification and is not displayed back in this setup flow.</p>
  </div></main>;
}
