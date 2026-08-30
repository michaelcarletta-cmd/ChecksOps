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
  recipient: { id: string; name: string; status: string };
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
  }, [session?.token]);

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
      setDone(true);
    } catch (err: any) {
      setError(err?.message ?? "Could not save your bank account.");
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

            {!loading && session && !done && (
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

                <Button type="submit" className="w-full" disabled={!canSubmit}>
                  {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save bank account
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
