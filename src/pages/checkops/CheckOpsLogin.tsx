import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { isPlatformOwner } from "@/lib/masterMerchant";
import { isAwsStaging } from "@/lib/awsStaging";
import { passkeysSupported, sendMagicLink, signInWithPasskey } from "@/lib/passkeys";
import { readPendingAwsEmailOtp, startAwsEmailOtp, verifyAwsEmailOtp } from "@/lib/awsPasswordless";

/** Passwordless ChecksOps sign-in. AWS staging uses Cognito EMAIL_OTP until WebAuthn is ported. */
export default function CheckOpsLogin() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();
  const awsStaging = isAwsStaging();
  const pendingAws = awsStaging ? readPendingAwsEmailOtp() : null;
  const [email, setEmail] = useState(pendingAws?.email || "");
  const [loading, setLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(Boolean(pendingAws));
  const [awsSession, setAwsSession] = useState(pendingAws?.session || "");
  const [code, setCode] = useState("");
  const supportsPasskeys = !awsStaging && passkeysSupported();

  useEffect(() => {
    if (authLoading || !user) return;
    void resolveAndRedirect(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, authLoading]);

  const resolveAndRedirect = async (userId: string, emailHint?: string | null) => {
    let emailLc = (emailHint ?? user?.email ?? "").trim().toLowerCase();
    if (!isPlatformOwner(emailLc)) {
      const { data: fresh } = await supabase.auth.getUser();
      emailLc = (fresh.user?.email ?? emailLc).trim().toLowerCase();
    }
    if (isPlatformOwner(emailLc)) {
      navigate(`/admin/tenants`, { replace: true });
      return;
    }
    const { data: roleRows } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const roles = new Set((roleRows ?? []).map((r) => r.role));
    const hasChecksOpsRole = roles.has("admin") || roles.has("staff") || roles.has("read_only") || roles.has("guided") || roles.has("contractor") || roles.has("client");
    if (!hasChecksOpsRole && roles.has("mortgage_agent")) {
      await supabase.auth.signOut();
      toast({ title: "Wrong portal", description: "This account is for the Mortgage Desk. Please sign in at /mortgage-ops/login.", variant: "destructive" });
      return;
    }
    const { data } = await supabase.from("tenant_users").select("tenant_id, tenants!inner(slug, subscription_status)").eq("user_id", userId);
    const memberships = (data ?? []).filter((m: any) => m.tenants?.subscription_status === "active" && m.tenants?.slug);
    if (memberships.length === 0) {
      await supabase.auth.signOut();
      toast({ title: "No ChecksOps access", description: "This account isn't a member of any active organization. Contact your admin.", variant: "destructive" });
      return;
    }
    navigate(`/${(memberships[0] as any).tenants.slug}/checks`, { replace: true });
  };

  const handlePasskey = async () => {
    setLoading(true);
    try {
      const result = await signInWithPasskey(email || undefined);
      const authedId = result.user?.id;
      if (!authedId) throw new Error("Unable to start your session");
      await resolveAndRedirect(authedId, result.user?.email ?? email);
    } catch (err: any) {
      toast({ title: "Passkey sign-in failed", description: err.message || "Try the email link instead.", variant: "destructive" });
    } finally { setLoading(false); }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { toast({ title: "Enter your email", variant: "destructive" }); return; }
    setLoading(true);
    try {
      if (awsStaging) {
        const pending = await startAwsEmailOtp(email);
        setEmail(pending.email);
        setAwsSession(pending.session);
        setLinkSent(true);
      } else {
        await sendMagicLink(email, `${window.location.origin}/login`);
        setLinkSent(true);
      }
    } catch (err: any) {
      toast({ title: awsStaging ? "Could not send verification code" : "Could not send sign-in link", description: err.message, variant: "destructive" });
    } finally { setLoading(false); }
  };

  const handleAwsVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await verifyAwsEmailOtp(email, awsSession, code);
      window.location.assign("/login");
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message || "Request a new code and try again.", variant: "destructive" });
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border/50">
        <CardHeader className="text-center space-y-3 pb-2">
          <div className="mx-auto"><CheckOpsLogo className="h-16 md:h-20" /></div>
          <CardTitle className="text-xl md:text-2xl">Sign in to ChecksOps</CardTitle>
          <p className="text-xs text-muted-foreground">Access your organization's check workflows.{awsStaging ? " AWS staging." : ""}</p>
        </CardHeader>
        <CardContent className="pt-2 space-y-4">
          {linkSent ? (
            <>
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  {awsStaging ? <>Check <span className="font-medium">{email}</span> for your one-time verification code.</> : <>Check <span className="font-medium">{email}</span> for your one-time sign-in link. It expires shortly.</>}
                </AlertDescription>
              </Alert>
              {awsStaging && (
                <form onSubmit={handleAwsVerify} className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="email-code">Email verification code</Label>
                    <Input id="email-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading || !code.trim()}>{loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Verify and sign in</Button>
                  <Button type="button" variant="ghost" className="w-full" disabled={loading} onClick={() => { setLinkSent(false); setAwsSession(""); setCode(""); }}>Request a new code</Button>
                </form>
              )}
            </>
          ) : (
            <form onSubmit={handleMagicLink} className="space-y-4">
              <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
              {supportsPasskeys && <div className="space-y-1.5"><Button type="button" className="w-full" disabled={loading} onClick={() => void handlePasskey()}>{loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}Sign in with a passkey<Badge variant="secondary" className="ml-2">Recommended</Badge></Button><p className="text-center text-[11px] text-muted-foreground">Fastest and most secure — Face ID, Touch ID or Windows Hello.</p></div>}
              {supportsPasskeys && <div className="relative py-1"><div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border/60" /></div><div className="relative flex justify-center"><span className="bg-card px-2 text-[11px] uppercase tracking-wide text-muted-foreground">or</span></div></div>}
              <Button type="submit" variant="outline" className="w-full" disabled={loading}>{loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}{awsStaging ? "Email me a verification code" : "Email me a sign-in link"}</Button>
              <p className="text-center text-[11px] text-muted-foreground">{awsStaging ? "AWS staging uses email verification while passkey support is being ported." : "Two-factor verification is still required before any money moves."}</p>
            </form>
          )}
          <div className="mt-6 pt-4 border-t border-border/40 flex flex-col items-center gap-1"><Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground"><Link to="/signup">Need an account? Create one</Link></Button><Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground"><Link to="/"><ArrowLeft className="h-3 w-3 mr-1" /> Back to checksops.com</Link></Button></div>
        </CardContent>
      </Card>
    </div>
  );
}
