import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ShieldCheck, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { StepUpRequest } from "@/hooks/useStepUp";

interface Props {
  request: StepUpRequest | null;
  onResolved: (ok: boolean) => void;
  onFactorsChanged: () => Promise<void> | void;
}

type Mode = "loading" | "verify" | "enroll";

/**
 * Blocking two-factor challenge shown before any money-movement action.
 * If the user has no TOTP authenticator yet, it enrolls one inline — there is
 * no path to a financial action that skips this dialog.
 */
export function StepUpDialog({ request, onResolved, onFactorsChanged }: Props) {
  const { toast } = useToast();
  const open = request !== null;

  const [mode, setMode] = useState<Mode>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setMode("loading");
      setCode("");
      setError(null);
      setQr(null);
      setSecret(null);
      setFactorId(null);
      return;
    }

    let cancelled = false;

    (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        setError(listError.message);
        setMode("verify");
        return;
      }

      const verifiedFactor = (data?.totp ?? []).find((f) => f.status === "verified");
      if (verifiedFactor) {
        setFactorId(verifiedFactor.id);
        setMode("verify");
        return;
      }

      // Clean up any half-finished enrollment so we can start fresh.
      for (const stale of (data?.totp ?? []).filter((f) => f.status !== "verified")) {
        await supabase.auth.mfa.unenroll({ factorId: stale.id });
      }

      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `ChecksOps ${new Date().toISOString().slice(0, 10)}`,
      });
      if (cancelled) return;
      if (enrollError || !enrolled) {
        setError(enrollError?.message ?? "Could not start two-factor setup.");
        setMode("verify");
        return;
      }
      setFactorId(enrolled.id);
      setQr(enrolled.totp.qr_code);
      setSecret(enrolled.totp.secret);
      setMode("enroll");
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const submit = async () => {
    if (!factorId) {
      setError("Two-factor is not ready yet. Close and try again.");
      return;
    }
    const trimmed = code.replace(/\s/g, "");
    if (trimmed.length !== 6) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { data: challenge, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId });
      if (challengeError || !challenge) throw challengeError ?? new Error("Challenge failed");

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: trimmed,
      });
      if (verifyError) throw verifyError;

      const { data: userData } = await supabase.auth.getUser();
      if (userData.user) {
        await supabase.from("financial_stepup_log").insert({
          user_id: userData.user.id,
          tenant_id: request?.tenantId ?? null,
          action_key: request?.actionKey ?? "unknown",
          factor_type: "totp",
          succeeded: true,
        });
        if (mode === "enroll") {
          await supabase
            .from("profiles")
            .update({ totp_enrolled_at: new Date().toISOString() })
            .eq("id", userData.user.id)
            .is("totp_enrolled_at", null);
        }
      }

      await onFactorsChanged();
      toast({
        title: "Verified",
        description: "Two-factor confirmed for this session.",
      });
      onResolved(true);
    } catch (err: any) {
      setError(err?.message || "That code wasn't accepted. Try the next one.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onResolved(false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {request?.title ?? "Confirm with two-factor"}
          </DialogTitle>
          <DialogDescription>
            {request?.description ??
              "Money movement requires two-factor verification. Enter the 6-digit code from your authenticator app."}
          </DialogDescription>
        </DialogHeader>

        {mode === "loading" && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {mode === "enroll" && (
          <div className="space-y-3">
            <Alert>
              <AlertDescription className="text-xs space-y-2">
                <p className="font-medium">Set this up once — it takes about a minute.</p>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>
                    Install a free authenticator app on your phone:{" "}
                    <a href="https://apps.apple.com/app/google-authenticator/id388497605" target="_blank" rel="noreferrer" className="underline">Google Authenticator (iPhone)</a>,{" "}
                    <a href="https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2" target="_blank" rel="noreferrer" className="underline">Google Authenticator (Android)</a>,{" "}
                    <a href="https://apps.apple.com/app/microsoft-authenticator/id983156458" target="_blank" rel="noreferrer" className="underline">Microsoft Authenticator</a>, Authy, or 1Password.
                    On iPhone you can also use the built-in Passwords app.
                  </li>
                  <li>In the app, tap the “+” and choose Scan a QR code, then scan the square below. Can't scan? Choose “Enter a setup key” and paste the key underneath.</li>
                  <li>The app shows a 6-digit number that changes every 30 seconds. Type the current one below and press Verify.</li>
                </ol>
              </AlertDescription>
            </Alert>

            {qr && (
              <div className="flex justify-center rounded-md bg-background p-3 border border-border">
                <img src={qr} alt="Two-factor setup QR code" className="h-44 w-44" />
              </div>
            )}
            {secret && (
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">
                  {secret}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    navigator.clipboard.writeText(secret);
                    toast({ title: "Setup key copied" });
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}

        {mode !== "loading" && (
          <div className="space-y-2">
            <Label htmlFor="stepup-code">Authentication code</Label>
            <Input
              id="stepup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            {mode === "verify" && (
              <p className="text-xs text-muted-foreground">
                Open your authenticator app (Google Authenticator, Microsoft Authenticator, Authy,
                1Password or iPhone Passwords) and enter the current 6-digit number listed for
                ChecksOps.
              </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}


        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" disabled={busy} onClick={() => onResolved(false)}>
            Cancel
          </Button>
          <Button disabled={busy || mode === "loading"} onClick={() => void submit()}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Verify
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
