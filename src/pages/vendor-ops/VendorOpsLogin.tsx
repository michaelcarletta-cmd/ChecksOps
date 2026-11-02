import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, KeyRound, Mail, CheckCircle2 } from "lucide-react";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { useAuth } from "@/hooks/useAuth";
import { isAwsStaging, isAwsStagingHttpsPasskeysEnabled } from "@/lib/awsStaging";
import { isAwsStagingSite } from "@/lib/awsStagingSite";
import { signInWithAwsPasskey } from "@/lib/awsPasskeys";
import { passkeysSupported, sendMagicLink, signInWithPasskey } from "@/lib/passkeys";
import { readPendingAwsEmailOtp, startAwsEmailOtp, verifyAwsEmailOtp } from "@/lib/awsPasswordless";
import { VENDOR_OPS_HOME_PATH, VENDOR_OPS_LOGIN_PATH } from "@/lib/vendorOps";

/**
 * Vendor Portal sign-in. Same passwordless ChecksOps session as /login (Cognito
 * WebAuthn + EMAIL_OTP on AWS, Supabase passkey / magic link elsewhere): the
 * portal is a finance view of the member's organization, not a separate account.
 * Once signed in, VendorOpsLayout resolves the organization and checks membership.
 */
export default function VendorOpsLogin() {
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();
  const awsStaging = isAwsStaging();
  const awsHttpsPasskeys = isAwsStagingHttpsPasskeysEnabled();
  const stagingSite = isAwsStagingSite();
  const pendingAws = awsStaging ? readPendingAwsEmailOtp() : null;
  const [email, setEmail] = useState(pendingAws?.email || "");
  const [loading, setLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(Boolean(pendingAws));
  const [awsSession, setAwsSession] = useState(pendingAws?.session || "");
  const [code, setCode] = useState("");
  const supportsPasskeys = awsStaging ? awsHttpsPasskeys && passkeysSupported() : passkeysSupported();

  if (!authLoading && user) return <Navigate to={VENDOR_OPS_HOME_PATH} replace />;

  const handlePasskey = async () => {
    setLoading(true);
    try {
      if (awsStaging) {
        if (!awsHttpsPasskeys) {
          throw new Error("Passkeys require https://staging.checksops.com. Use email verification on this origin.");
        }
        // Full reload so useAuth() hydrates the Cognito session before the portal guard runs.
        await signInWithAwsPasskey(email);
        window.location.assign(VENDOR_OPS_LOGIN_PATH);
        return;
      }
      const result = await signInWithPasskey(email || undefined);
      if (!result.user?.id) throw new Error("Unable to start your session");
      // useAuth picks up the session; the redirect above sends the user to the portal.
    } catch (err: any) {
      toast({ title: "Passkey sign-in failed", description: err.message || "Try the email option instead.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast({ title: "Enter your email", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      if (awsStaging) {
        const pending = await startAwsEmailOtp(email);
        setEmail(pending.email);
        setAwsSession(pending.session);
      } else {
        await sendMagicLink(email, `${window.location.origin}${VENDOR_OPS_LOGIN_PATH}`);
      }
      setLinkSent(true);
    } catch (err: any) {
      toast({
        title: awsStaging ? "Could not send verification code" : "Could not send sign-in link",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAwsVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await verifyAwsEmailOtp(email, awsSession, code, { authClient: supabase as any });
      window.location.assign(VENDOR_OPS_LOGIN_PATH);
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message || "Request a new code and try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border/50">
        <CardHeader className="text-center space-y-3 pb-2">
          <div className="mx-auto"><CheckOpsLogo className="h-16 md:h-20" /></div>
          <CardTitle className="text-xl md:text-2xl">Vendor Portal</CardTitle>
          <p className="text-xs text-muted-foreground">
            Wallet, payments and financials for your organization.{stagingSite ? " AWS staging." : ""}
          </p>
        </CardHeader>
        <CardContent className="pt-2 space-y-4">
          {linkSent ? (
            <>
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  {awsStaging
                    ? <>Check <span className="font-medium">{email}</span> for your one-time verification code.</>
                    : <>Check <span className="font-medium">{email}</span> for your one-time sign-in link. It expires shortly.</>}
                </AlertDescription>
              </Alert>
              {awsStaging && (
                <form onSubmit={handleAwsVerify} className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="vendor-email-code">Email verification code</Label>
                    <Input id="vendor-email-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading || !code.trim()}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Verify and sign in
                  </Button>
                  <Button type="button" variant="ghost" className="w-full" disabled={loading} onClick={() => { setLinkSent(false); setAwsSession(""); setCode(""); }}>
                    Request a new code
                  </Button>
                </form>
              )}
            </>
          ) : (
            <form onSubmit={handleEmail} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="vendor-email">Email</Label>
                <Input id="vendor-email" type="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              {supportsPasskeys && (
                <Button type="button" className="w-full" disabled={loading} onClick={() => void handlePasskey()}>
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  Sign in with a passkey<Badge variant="secondary" className="ml-2">Recommended</Badge>
                </Button>
              )}
              <Button type="submit" variant="outline" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                {awsStaging ? "Email me a verification code" : "Email me a sign-in link"}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                Two-factor verification is still required before any money moves.
              </p>
            </form>
          )}
          <div className="mt-6 pt-4 border-t border-border/40 flex justify-center">
            <Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground">
              <Link to="/"><ArrowLeft className="h-3 w-3 mr-1" /> Back to checksops.com</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
