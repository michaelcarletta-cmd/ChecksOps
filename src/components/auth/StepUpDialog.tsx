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
import { Loader2, ShieldCheck, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { StepUpRequest } from "@/hooks/useStepUp";
import {
  associateAwsTotp,
  awsMfaAvailable,
  getAwsMfaStatus,
  stepUpAwsTotp,
  verifyAwsTotp,
} from "@/lib/awsMfa";
import { TOTP_BOUNDARY_MESSAGE, normalizeTotpCode, totpUserFailureMessage } from "@/lib/totpCode";
import { resolveTotpOtpauthUri, totpQrDataUrl } from "@/lib/totpQr";
import { TotpQrDisplay } from "@/components/auth/TotpQrDisplay";

interface Props {
  request: StepUpRequest | null;
  onResolved: (ok: boolean) => void;
  onFactorsChanged: () => Promise<void> | void;
}

type Mode = "loading" | "verify" | "enroll" | "setup-error";

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
  const [setupAttempt, setSetupAttempt] = useState(0);

  useEffect(() => {
    if (!open) {
      setMode("loading");
      setCode("");
      setError(null);
      setQr(null);
      setSecret(null);
      setFactorId(null);
      setSetupAttempt(0);
      return;
    }

    let cancelled = false;

    (async () => {
      if (awsMfaAvailable()) {
        try {
          const status = await getAwsMfaStatus();
          if (cancelled) return;
          if (status.totpEnrolled) {
            setFactorId("software-token");
            setMode("verify");
            return;
          }
          const associated = await associateAwsTotp();
          if (cancelled) return;
          const uri = resolveTotpOtpauthUri({
            otpauthUri: associated.otpauthUri,
            secret: associated.secret,
          });
          const qr = await totpQrDataUrl(uri);
          if (cancelled) return;
          setFactorId("software-token");
          setSecret(associated.secret);
          setQr(qr);
          setMode("enroll");
        } catch (err: unknown) {
          if (cancelled) return;
          setError(`Could not check your two-factor setup: ${err instanceof Error ? err.message : String(err)}`);
          setMode("setup-error");
        }
        return;
      }

      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        setError(`Could not check your two-factor setup: ${listError.message}`);
        setMode("setup-error");
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
        const { error: cleanupError } = await supabase.auth.mfa.unenroll({ factorId: stale.id });
        if (cleanupError) {
          setError("We couldn't restart the unfinished setup. Select Restart setup to try again.");
          setMode("setup-error");
          return;
        }
      }

      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `ChecksOps ${new Date().toISOString().slice(0, 10)}`,
      });
      if (cancelled) return;
      if (enrollError || !enrolled) {
        setError(enrollError?.message ?? "Could not start two-factor setup.");
        setMode("setup-error");
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
  }, [open, setupAttempt]);

  const submit = async () => {
    if (!factorId) {
      setError("Two-factor is not ready yet. Close and try again.");
      return;
    }
    const normalized = normalizeTotpCode(code);
    if (!normalized.ok) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (awsMfaAvailable()) {
        try {
          await supabase.auth.refreshSession();
        } catch {
          /* continue with the current access token */
        }
        if (mode === "enroll") {
          const enrolled = await verifyAwsTotp(normalized.code, {
            actionKey: request?.actionKey,
            tenantId: request?.tenantId,
            checkId: request?.checkId,
          });
          if (!enrolled) throw new Error(TOTP_BOUNDARY_MESSAGE);
        } else {
          const stepped = await stepUpAwsTotp({
            code: normalized.code,
            actionKey: request?.actionKey,
            tenantId: request?.tenantId,
            checkId: request?.checkId,
          });
          if (!stepped) throw new Error(TOTP_BOUNDARY_MESSAGE);
        }
        await onFactorsChanged();
        toast({
          title: "Verified",
          description: "Two-factor confirmed for this session. Production CheckAlt still requires a financial role server-side.",
        });
        onResolved(true);
        return;
      }

      const { data: challenge, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId });
      if (challengeError || !challenge) throw challengeError ?? new Error("Challenge failed");

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: normalized.code,
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
    } catch (err: unknown) {
      setError(totpUserFailureMessage(err));
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
            {request?.title
              ?? (request?.actionKey === "deposit.submit"
                ? "Deposit Verification"
                : request?.actionKey === "deposit.approve"
                  ? "Approval Verification"
                  : "Confirm with two-factor")}
          </DialogTitle>
          <DialogDescription>
            {request?.description
              ?? (request?.actionKey === "deposit.submit"
                ? "Enter the current 6-digit code from your authenticator app to authorize this deposit."
                : request?.actionKey === "deposit.approve"
                  ? "Enter the current 6-digit code from your authenticator app to authorize this approval."
                  : "Money movement requires two-factor verification. Enter the 6-digit code from your authenticator app.")}
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

            <TotpQrDisplay qr={qr} secret={secret} />
          </div>
        )}

        {mode === "setup-error" && (
          <Alert variant="destructive">
            <AlertDescription className="space-y-3 text-xs">
              <p>{error ?? "Two-factor setup could not be started."}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(null);
                  setMode("loading");
                  setSetupAttempt((attempt) => attempt + 1);
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Restart setup
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {(mode === "verify" || mode === "enroll") && (
          <div className="space-y-2">
            <Label htmlFor="stepup-code">Authentication code</Label>
            <Input
              id="stepup-code"
              type="text"
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
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  This account already has an authenticator linked. Open Google Authenticator,
                  Microsoft Authenticator, Authy, 1Password, or iPhone Passwords and enter the
                  current 6-digit number listed for ChecksOps.
                </p>
                <p>
                  Installing a new app will not recreate an existing code. If you no longer have
                  access to the linked app, an administrator must reset two-factor authentication
                  before you can set it up again.
                </p>
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}


        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" disabled={busy} onClick={() => onResolved(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || mode === "loading" || mode === "setup-error" || !factorId}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Verify
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
