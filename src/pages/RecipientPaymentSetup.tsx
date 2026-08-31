import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { applyMoovTheme } from "@/lib/payments/moovTheme";
import { Loader2, ShieldCheck, Landmark, AlertCircle, CheckCircle2 } from "lucide-react";



/**
 * Branded, login-free recipient payment setup page.
 *
 * A homeowner, subcontractor, or one-time vendor arrives here from a secure,
 * expiring link. Their bank details are collected by the provider's hosted
 * component and travel straight from this browser to the provider — routing
 * and account numbers never pass through or get stored by ChecksOps.
 */

interface SessionData {
  recipient: {
    id: string;
    name: string;
    status: string;
    bank_linked?: boolean;
    bank_name?: string | null;
    last_four?: string | null;
  };
  payer: {
    name: string;
    logo_url: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
  };
  account_id: string;
  token: string;
  environment: string;
}

export default function RecipientPaymentSetup() {
  const { token } = useParams<{ token: string }>();
  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [holderName, setHolderName] = useState("");
  const [holderType, setHolderType] = useState("individual");
  const [bankAccountType, setBankAccountType] = useState("checking");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [ssn, setSsn] = useState("");
  const [ein, setEin] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [tosReady, setTosReady] = useState(false);
  const [termsDone, setTermsDone] = useState(false);
  const [replaceBank, setReplaceBank] = useState(false);
  const tosMountRef = useRef<HTMLDivElement | null>(null);



  // Brand the hosted Moov component so it matches the payer's look.
  useEffect(
    () =>
      applyMoovTheme({
        primary: session?.payer.primary_color ?? null,
        secondary: session?.payer.secondary_color ?? null,
      }),
    [session?.payer.primary_color, session?.payer.secondary_color],
  );


  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: fnErr } = await supabase.functions.invoke("moov-recipient-session", {
          body: { token },
        });
        if (fnErr) {
          let message = "This link is not valid.";
          try {
            const parsed = await (fnErr as any).context?.json?.();
            if (parsed?.error) message = parsed.error;
          } catch { /* keep default */ }
          throw new Error(message);
        }
        if ((data as any)?.error) throw new Error((data as any).error);
        if (!cancelled) setSession(data as SessionData);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Mount the provider's hosted Terms of Service component once the session
  // token is available; it mints the acceptance token we submit with the form.
  const tosTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    (async () => {
      try {
        await loadMoovJs();
        if (cancelled || !tosMountRef.current) return;
        const el = document.createElement("moov-terms-of-service") as any;
        el.token = session.token;
        el.onTermsOfServiceTokenReady = (t: any) => {
          tosTokenRef.current = typeof t === "string" ? t : t?.token ?? null;
          setTosReady(Boolean(tosTokenRef.current));
        };
        el.onTermsOfServiceTokenError = () => setTosReady(false);
        tosMountRef.current.replaceChildren(el);
      } catch { /* leave ToS hidden; submit will surface an error */ }
    })();
    return () => { cancelled = true; };
  }, [session?.token, replaceBank]);

  // Recipients onboarded before the provider required terms already have a bank
  // on file — they only need to accept terms to be payable again.
  const showTermsOnly = Boolean(session?.recipient.bank_linked) && !replaceBank;

  const digitsOnly = (value: string, max: number) => value.replace(/\D/g, "").slice(0, max);


  const identityValid =
    addressLine1.trim().length >= 3 &&
    city.trim().length >= 1 &&
    /^[A-Za-z]{2}$/.test(state.trim()) &&
    postalCode.trim().length >= 5 &&
    (holderType === "business"
      ? ein.length === 9
      : firstName.trim().length >= 1 && lastName.trim().length >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(dob) && ssn.length === 9);

  const canSubmit =
    holderName.trim().length >= 2 &&
    routingNumber.length === 9 &&
    accountNumber.length >= 4 &&
    identityValid &&
    tosReady &&
    !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("moov-recipient-bank-add", {
        body: {
          token,
          holder_name: holderName.trim(),
          holder_type: holderType,
          bank_account_type: bankAccountType,
          routing_number: routingNumber,
          account_number: accountNumber,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          dob,
          ssn,
          ein,
          address_line1: addressLine1.trim(),
          city: city.trim(),
          state: state.trim().toUpperCase(),
          postal_code: postalCode.trim(),
          tos_token: tosTokenRef.current,
        },
      });
      if (fnErr) {
        let message = "Could not save your bank account.";
        try {
          const parsed = await (fnErr as any).context?.json?.();
          if (parsed?.error) message = parsed.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      setAccountNumber("");
      setRoutingNumber("");
      setSsn("");
      setEin("");
      setDone(true);
    } catch (err: any) {
      setError(err?.message ?? "Could not save your bank account.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAcceptTermsOnly() {
    if (!tosReady || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("moov-recipient-tos-accept", {
        body: { token },
      });
      if (fnErr) {
        let message = "Could not record your acceptance.";
        try {
          const parsed = await (fnErr as any).context?.json?.();
          if (parsed?.error) message = parsed.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      setTermsDone(true);
    } catch (err: any) {
      setError(err?.message ?? "Could not record your acceptance.");
    } finally {
      setSaving(false);
    }
  }




  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <header className="text-center space-y-2">
          {session?.payer.logo_url ? (
            <img
              src={session.payer.logo_url}
              alt={`${session.payer.name} logo`}
              className="h-10 mx-auto object-contain"
            />
          ) : null}
          <h1 className="text-xl font-semibold tracking-tight">
            Set up your payment details
          </h1>
          {session ? (
            <p className="text-sm text-muted-foreground">
              {session.payer.name} is sending you a payment.
            </p>
          ) : null}
        </header>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Landmark className="h-4 w-4 text-primary" />
              Where should we send your money?
            </CardTitle>
            <CardDescription className="text-xs">
              Your bank details go directly to our payment provider over a secure connection.
              They are never stored on ChecksOps servers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && (
              <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading secure form…
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-xs text-destructive">{error}</p>
              </div>
            )}

            {done && (
              <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                <p className="text-xs text-emerald-500">
                  Your bank account is connected. You can close this page — the payment will arrive
                  in your account.
                </p>
              </div>
            )}

            {!loading && session && !done && showTermsOnly && (
              <div className="space-y-4 pt-1">
                {termsDone ? (
                  <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-emerald-500">
                      Terms accepted. You can close this page — your payment can now be released.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-foreground font-medium">
                        Bank account already on file
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {session.recipient.bank_name ?? "Your bank"}
                        {session.recipient.last_four ? ` ••••${session.recipient.last_four}` : ""} — one last
                        step: accept the payment provider's terms so we can send your money.
                      </p>
                    </div>

                    <div
                      ref={tosMountRef}
                      aria-hidden="true"
                      style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}
                    />
                    <p className="text-[11px] leading-relaxed text-muted-foreground rounded-md border border-border/60 bg-muted/30 p-3">
                      By continuing, you agree to the terms of Moov's{" "}
                      <a href="https://moov.io/legal/privacy/" target="_blank" rel="noopener noreferrer"
                        className="text-primary underline underline-offset-2">Privacy Policy</a>{" "}
                      and{" "}
                      <a href="https://moov.io/legal/platform-agreement/" target="_blank" rel="noopener noreferrer"
                        className="text-primary underline underline-offset-2">Platform Agreement</a>.
                    </p>
                    {!tosReady && (
                      <p className="text-[11px] text-muted-foreground">
                        Loading the payment provider's Terms of Service…
                      </p>
                    )}

                    <Button className="w-full" disabled={!tosReady || saving} onClick={handleAcceptTermsOnly}>
                      {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Accept terms
                    </Button>
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline underline-offset-2 w-full text-center"
                      onClick={() => setReplaceBank(true)}
                    >
                      Need to use a different bank account?
                    </button>
                  </>
                )}
              </div>
            )}

            {!loading && session && !done && !showTermsOnly && (
              <form onSubmit={handleSubmit} className="space-y-4 pt-1">

                <div className="space-y-2">
                  <Label htmlFor="holder-name">Account holder name</Label>
                  <Input
                    id="holder-name"
                    value={holderName}
                    onChange={(e) => setHolderName(e.target.value.slice(0, 128))}
                    placeholder="Exactly as it appears at your bank"
                    autoComplete="off"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Account owner</Label>
                    <Select value={holderType} onValueChange={setHolderType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="individual">Individual</SelectItem>
                        <SelectItem value="business">Business</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Account type</Label>
                    <Select value={bankAccountType} onValueChange={setBankAccountType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="checking">Checking</SelectItem>
                        <SelectItem value="savings">Savings</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="rounded-md border border-border/60 p-3 space-y-4">
                  <p className="text-xs font-medium text-foreground">
                    Verify your identity
                  </p>
                  <p className="text-[11px] text-muted-foreground -mt-2">
                    Required by our payment provider before it can send you money. These details
                    go directly to the provider and are never stored by ChecksOps.
                  </p>

                  {holderType === "individual" ? (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="first-name">Legal first name</Label>
                          <Input id="first-name" value={firstName}
                            onChange={(e) => setFirstName(e.target.value.slice(0, 64))} autoComplete="given-name" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="last-name">Legal last name</Label>
                          <Input id="last-name" value={lastName}
                            onChange={(e) => setLastName(e.target.value.slice(0, 64))} autoComplete="family-name" />
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="dob">Date of birth</Label>
                          <Input id="dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ssn">SSN</Label>
                          <Input id="ssn" inputMode="numeric" type="password" value={ssn}
                            onChange={(e) => setSsn(digitsOnly(e.target.value, 9))}
                            placeholder="9 digits" autoComplete="off" />
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor="ein">Business EIN</Label>
                      <Input id="ein" inputMode="numeric" value={ein}
                        onChange={(e) => setEin(digitsOnly(e.target.value, 9))}
                        placeholder="9 digits" autoComplete="off" />
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="addr">Street address</Label>
                    <Input id="addr" value={addressLine1}
                      onChange={(e) => setAddressLine1(e.target.value.slice(0, 128))} autoComplete="address-line1" />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="city">City</Label>
                      <Input id="city" value={city}
                        onChange={(e) => setCity(e.target.value.slice(0, 64))} autoComplete="address-level2" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="state">State</Label>
                      <Input id="state" value={state} maxLength={2}
                        onChange={(e) => setState(e.target.value.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase())}
                        placeholder="NJ" autoComplete="address-level1" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="zip">ZIP</Label>
                      <Input id="zip" inputMode="numeric" value={postalCode}
                        onChange={(e) => setPostalCode(e.target.value.replace(/[^\d-]/g, "").slice(0, 10))}
                        autoComplete="postal-code" />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="routing">Routing number</Label>
                  <Input
                    id="routing"
                    inputMode="numeric"
                    value={routingNumber}
                    onChange={(e) => setRoutingNumber(digitsOnly(e.target.value, 9))}
                    placeholder="9 digits"
                    autoComplete="off"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="account">Account number</Label>
                  <Input
                    id="account"
                    inputMode="numeric"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(digitsOnly(e.target.value, 17))}
                    placeholder="4–17 digits"
                    autoComplete="off"
                  />
                </div>

                {/* The Moov ToS Drop only exists to mint the acceptance token — it
                    renders an unthemeable white box, so it stays visually hidden
                    and we show our own themed agreement text with the same links. */}
                <div
                  ref={tosMountRef}
                  aria-hidden="true"
                  style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground rounded-md border border-border/60 bg-muted/30 p-3">
                  By clicking continue, you agree to the terms of Moov's{" "}
                  <a
                    href="https://moov.io/legal/privacy/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    Privacy Policy
                  </a>{" "}
                  and{" "}
                  <a
                    href="https://moov.io/legal/platform-agreement/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    Platform Agreement
                  </a>
                  .
                </p>
                {!tosReady && !done && (
                  <p className="text-[11px] text-muted-foreground">
                    Loading the payment provider's Terms of Service…
                  </p>
                )}

                <Button type="submit" className="w-full" disabled={!canSubmit}>
                  {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Agree & save bank account
                </Button>
              </form>
            )}

          </CardContent>
        </Card>

        <p className="text-[11px] text-muted-foreground text-center flex items-center justify-center gap-1.5">
          <ShieldCheck className="h-3 w-3" />
          Secured by ChecksOps. This link expires and can only be used by you.
        </p>
      </div>
    </main>
  );
}

let moovJsPromise: Promise<void> | null = null;

/** Loads the provider's browser SDK once, on demand (Terms of Service Drop). */
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
