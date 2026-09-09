import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useStepUp } from "@/hooks/useStepUp";
import { isAwsStaging } from "@/lib/awsStaging";
import { associateAwsTotp, awsMfaAvailable, awsTotpEnrollmentDisplay, getAwsMfaStatus, verifyAwsTotp } from "@/lib/awsMfa";
import { resolveTotpOtpauthUri, totpQrDataUrl } from "@/lib/totpQr";
import { TotpQrDisplay } from "@/components/auth/TotpQrDisplay";
import { useAuth } from "@/hooks/useAuth";

/**
 * Shows TOTP status and enrolls Cognito SOFTWARE_TOKEN_MFA on AWS builds.
 * QR is generated in-browser from the associate otpauth URI. Preferred MFA
 * stays unset. Financial step-up still uses StepUpDialog after enrollment.
 */
export function TotpManagerCard() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { requireStepUp, refreshFactors, verified } = useStepUp();
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [awsSecret, setAwsSecret] = useState<string | null>(null);
  const [awsQr, setAwsQr] = useState<string | null>(null);
  const [awsCode, setAwsCode] = useState("");
  const awsStaging = isAwsStaging();
  const awsMode = awsMfaAvailable();

  const load = useCallback(async () => {
    if (awsMfaAvailable()) {
      try {
        const status = await getAwsMfaStatus();
        setStatusError(null);
        setEnrolled(awsTotpEnrollmentDisplay(status) === "enrolled");
      } catch (error) {
        setStatusError(String((error as Error).message || error));
      }
      return;
    }
    if (awsStaging) {
      setEnrolled(false);
      return;
    }
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      setEnrolled(null);
      return;
    }
    setEnrolled((data?.totp ?? []).some((f) => f.status === "verified"));
  }, [awsStaging]);

  useEffect(() => {
    void load();
  }, [load, verified]);

  if (awsMode) {
    const startAws = async () => {
      setBusy(true);
      try {
        const associated = await associateAwsTotp(user?.email);
        const uri = resolveTotpOtpauthUri({
          otpauthUri: associated.otpauthUri,
          secret: associated.secret,
          email: user?.email,
        });
        const qr = await totpQrDataUrl(uri);
        setAwsSecret(associated.secret);
        setAwsQr(qr);
        toast({
          title: "Scan the QR code",
          description: "Add ChecksOps in your authenticator app, then enter the current 6-digit code.",
        });
      } catch (error) {
        setAwsSecret(null);
        setAwsQr(null);
        toast({ title: "Could not start TOTP", description: String((error as Error).message || error), variant: "destructive" });
      } finally {
        setBusy(false);
      }
    };
    const confirmAws = async () => {
      setBusy(true);
      try {
        const ok = await verifyAwsTotp(awsCode.trim());
        if (!ok) throw new Error("verify_failed");
        setAwsSecret(null);
        setAwsQr(null);
        setAwsCode("");
        const status = await getAwsMfaStatus();
        const nowEnrolled = awsTotpEnrollmentDisplay(status) === "enrolled";
        setStatusError(null);
        setEnrolled(nowEnrolled);
        if (!nowEnrolled) {
          throw new Error("Authenticator code was accepted but Cognito did not retain SOFTWARE_TOKEN_MFA. Preferred MFA was not set.");
        }
        toast({ title: "Authenticator enrolled", description: "Login still uses email OTP, password, or passkey. This code is for privileged and future financial step-up." });
      } catch (error) {
        toast({ title: "Could not verify code", description: String((error as Error).message || error), variant: "destructive" });
      } finally {
        setBusy(false);
      }
    };
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {enrolled ? <ShieldCheck className="h-4 w-4 text-primary" /> : <ShieldAlert className="h-4 w-4 text-amber-500" />}
            Authenticator (TOTP)
            <Badge variant={enrolled ? "secondary" : "outline"} className="ml-1">
              {enrolled === null ? (statusError ? "Status unavailable" : "Checking") : enrolled ? "Enrolled" : "Optional at login"}
            </Badge>
          </CardTitle>
          <CardDescription>
            Sign-in still uses email OTP, password, or a passkey. Admin/staff should enroll TOTP or a passkey before privileged or financial actions. Money movement stays off.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {statusError && enrolled !== true && (
            <Alert>
              <AlertDescription className="text-xs">
                Could not read authenticator enrollment from Cognito. Refresh to try again. This is not treated as unenrolled.
              </AlertDescription>
            </Alert>
          )}
          {enrolled === false && !awsQr && !awsSecret && (
            <Button onClick={() => void startAws()} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Set up authenticator
            </Button>
          )}
          {(awsQr || awsSecret) && (
            <div className="space-y-3 text-xs">
              <p className="text-muted-foreground">
                Scan the QR code with Google Authenticator, Microsoft Authenticator, Authy, 1Password, or iPhone Passwords.
              </p>
              <TotpQrDisplay qr={awsQr} secret={awsSecret} />
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="6-digit code"
                value={awsCode}
                onChange={(event) => setAwsCode(event.target.value.replace(/\D/g, ""))}
              />
              <Button onClick={() => void confirmAws()} disabled={busy || awsCode.trim().length !== 6}>
                Verify and enroll
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }
  if (awsStaging) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            Authenticator (TOTP)
          </CardTitle>
          <CardDescription>
            AWS Cognito TOTP enrollment is available when the API URL is configured. Login remains email OTP, password, or passkey.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const start = async () => {
    setBusy(true);
    const ok = await requireStepUp({
      actionKey: "totp.enroll",
      title: enrolled ? "Confirm your authenticator" : "Set up two-factor",
      description: enrolled
        ? "Enter a current code to confirm your authenticator still works."
        : "Two-factor is required before you can move money. Set it up now.",
    });
    setBusy(false);
    if (ok) {
      await refreshFactors();
      await load();
    }
  };

  const remove = async () => {
    const { data } = await supabase.auth.mfa.listFactors();
    const factor = (data?.totp ?? []).find((f) => f.status === "verified");
    if (!factor) return;
    // Removing a verified factor requires a fresh code first (AAL2).
    const ok = await requireStepUp({
      actionKey: "totp.unenroll",
      title: "Confirm before removing",
      description: "Enter a current code from your authenticator app to remove it.",
    });
    if (!ok) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) {
      toast({ title: "Could not remove", description: error.message, variant: "destructive" });
      return;
    }
    toast({
      title: "Authenticator removed",
      description: "You'll be asked to set up a new one at your next financial action.",
    });
    await refreshFactors();
    await load();
  };


  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {enrolled ? (
            <ShieldCheck className="h-5 w-5 text-primary" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-destructive" />
          )}
          Two-factor authentication
          <Badge variant={enrolled ? "secondary" : "destructive"} className="ml-1">
            {enrolled === null ? "Checking" : enrolled ? "Active" : "Required"}
          </Badge>
        </CardTitle>
        <CardDescription>
          An authenticator app code is required before approving deposits, sending disbursements,
          funding a wallet or changing bank details — no matter how you signed in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {enrolled === false && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">
              Two-factor isn't set up. Money-movement actions will stay blocked until it is.
            </AlertDescription>
          </Alert>
        )}
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Which app do I need?</p>
          <p>
            Any free authenticator app works:{" "}
            <a href="https://apps.apple.com/app/google-authenticator/id388497605" target="_blank" rel="noreferrer" className="underline">Google Authenticator (iPhone)</a>,{" "}
            <a href="https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2" target="_blank" rel="noreferrer" className="underline">Google Authenticator (Android)</a>,{" "}
            <a href="https://apps.apple.com/app/microsoft-authenticator/id983156458" target="_blank" rel="noreferrer" className="underline">Microsoft Authenticator</a>, Authy, or 1Password.
            iPhone users can also use the built-in Passwords app.
          </p>
          <p>
            Install it, tap “+” → Scan a QR code, scan the square we show you, then type the 6-digit
            number the app displays. That number is your authentication code, and it changes every
            30 seconds.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void start()} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {enrolled ? "Verify authenticator" : "Set up two-factor"}
          </Button>
          {enrolled && (
            <Button variant="outline" onClick={() => void remove()}>
              Remove authenticator
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
