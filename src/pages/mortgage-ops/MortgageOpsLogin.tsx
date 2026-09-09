import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { mortgageSupabase as supabase } from "@/integrations/supabase/mortgageClient";
import { useMortgageAuth } from "@/hooks/useMortgageAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Fingerprint, Mail, CheckCircle2, Loader2 } from "lucide-react";
import mortgageOpsLogo from "@/assets/mortgage-ops-logo.png";
import { isAwsStaging, isAwsStagingEnvironment, isAwsStagingHttpsPasskeysEnabled, AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY, awsPasskeysRequireConfiguredOriginMessage } from "@/lib/awsStaging";
import { signInWithAwsPasskey } from "@/lib/awsPasskeys";
import { signInWithPasskey, sendMagicLink, passkeysSupported } from "@/lib/passkeys";
import { startAwsEmailOtp, verifyAwsEmailOtp } from "@/lib/awsPasswordless";

export default function MortgageOpsLogin() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [awsSession, setAwsSession] = useState("");
  const [code, setCode] = useState("");
  const awsStaging = isAwsStaging();
  const awsStagingHost = isAwsStagingEnvironment();
  const awsHttpsPasskeys = isAwsStagingHttpsPasskeysEnabled();
  const canUsePasskeys = awsStaging
    ? awsHttpsPasskeys && passkeysSupported()
    : passkeysSupported();
  const { user, userRole, loading: authLoading } = useMortgageAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    if (userRole === "mortgage_agent" || userRole === "admin") {
      navigate("/mortgage-ops/queue", { replace: true });
    } else if (userRole) {
      // Signed in but not authorized for the Mortgage Desk — kick them out
      // of this portal's isolated session so they can't reach queue routes.
      supabase.auth.signOut();
      toast.error("This portal is for ChecksOps mortgage agents only.");
    }
  }, [user, userRole, authLoading, navigate]);

  const enforceRole = async (userId: string) => {
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    const roleSet = new Set((roles ?? []).map((r) => r.role));
    if (!roleSet.has("mortgage_agent") && !roleSet.has("admin")) {
      await supabase.auth.signOut();
      toast.error("This account doesn't have access to the Mortgage Desk.");
      return false;
    }
    return true;
  };

  const handlePasskey = async () => {
    setLoading(true);
    try {
      if (awsStaging) {
        if (!awsHttpsPasskeys) {
          throw new Error(awsPasskeysRequireConfiguredOriginMessage());
        }
        // Persist into Mortgage Desk session key + emit SIGNED_IN on mortgage client.
        await signInWithAwsPasskey(email, {
          sessionKey: AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY,
          authClient: supabase as any,
        });
        window.location.assign("/mortgage-ops/login");
        return;
      }
      const result = await signInWithPasskey(email || undefined, supabase as any);
      const userId = result.user?.id;
      if (!userId) throw new Error("Unable to start your session");
      await enforceRole(userId);
      // useMortgageAuth effect will bounce to /queue.
    } catch (err: any) {
      toast.error(err.message || "Passkey sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast.error("Enter your email");
      return;
    }
    setLoading(true);
    try {
      if (awsStaging) {
        const pending = await startAwsEmailOtp(email, { portal: "mortgage-ops" });
        setEmail(pending.email);
        setAwsSession(pending.session);
        setLinkSent(true);
      } else {
        await sendMagicLink(email, `${window.location.origin}/mortgage-ops/login`, supabase as any);
        setLinkSent(true);
      }
    } catch (err: any) {
      toast.error(err.message || (awsStaging ? "Could not send verification code" : "Could not send sign-in link"));
    } finally {
      setLoading(false);
    }
  };

  const handleAwsVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await verifyAwsEmailOtp(email, awsSession, code, {
        portal: "mortgage-ops",
        sessionKey: AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY,
        authClient: supabase as any,
      });
      window.location.assign("/mortgage-ops/login");
    } catch (err: any) {
      toast.error(err.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center bg-background p-4 pt-10 sm:pt-16">
      <img
        src={mortgageOpsLogo}
        alt="Mortgage Ops"
        className="mb-8 h-24 sm:h-32 w-auto object-contain select-none"
        draggable={false}
      />
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>ChecksOps Mortgage Desk</CardTitle>
          <p className="text-sm text-muted-foreground">
            Employee sign-in{awsStagingHost ? " · AWS staging" : ""}
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {linkSent ? (
            <div className="text-center space-y-3 py-4">
              <CheckCircle2 className="h-10 w-10 mx-auto text-primary" />
              <p className="font-medium">Check your email</p>
              <p className="text-sm text-muted-foreground">
                {awsStaging
                  ? `We sent a one-time verification code to ${email}.`
                  : `We sent a one-time sign-in link to ${email}. It opens the Mortgage Desk directly.`}
              </p>
              {awsStaging ? (
                <form onSubmit={handleAwsVerify} className="space-y-3 text-left">
                  <div className="space-y-2">
                    <Label htmlFor="mops-code">Email verification code</Label>
                    <Input
                      id="mops-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading || !code.trim()}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Verify and sign in
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={() => { setLinkSent(false); setAwsSession(""); setCode(""); }}
                  >
                    Use a different email
                  </Button>
                </form>
              ) : (
                <Button variant="ghost" onClick={() => setLinkSent(false)}>
                  Use a different email
                </Button>
              )}
            </div>
          ) : (
            <>
              {canUsePasskeys && (
                <div className="space-y-2">
                  <div className="space-y-2">
                    <Label htmlFor="email">Work email</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username webauthn"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                  <Button type="button" className="w-full" disabled={loading} onClick={() => void handlePasskey()}>
                    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Fingerprint className="mr-2 h-4 w-4" />}
                    {loading ? "Signing in…" : "Sign in with passkey"}
                  </Button>
                  <p className="text-xs text-center text-muted-foreground">
                    Recommended — fastest and most secure
                  </p>
                </div>
              )}

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">
                    {awsStaging ? "or email code" : "or email link"}
                  </span>
                </div>
              </div>

              <form onSubmit={handleMagicLink} className="space-y-4">
                {!canUsePasskeys && (
                  <div className="space-y-2">
                    <Label htmlFor="email-fallback">Work email</Label>
                    <Input
                      id="email-fallback"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                )}
                <Button type="submit" variant="outline" className="w-full" disabled={loading}>
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                  {loading ? "Sending…" : (awsStaging ? "Email me a verification code" : "Email me a sign-in link")}
                </Button>
              </form>

              {user && userRole && userRole !== "mortgage_agent" && userRole !== "admin" && (
                <p className="text-sm text-destructive text-center">
                  This portal is for ChecksOps mortgage agents only.
                </p>
              )}
            </>
          )}
        </CardContent>

      </Card>
    </div>
  );
}
