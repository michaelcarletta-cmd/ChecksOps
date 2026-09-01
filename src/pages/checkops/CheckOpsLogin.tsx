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
import { passkeysSupported, sendMagicLink, signInWithPasskey } from "@/lib/passkeys";

/**
 * Generic ChecksOps sign-in page at checksops.com/login.
 *
 * Passwords are retired. Users sign in with a passkey (recommended) or a
 * one-time email link. After authentication we resolve the tenant they belong
 * to via tenant_users and redirect to /{slug}/checks.
 */
export default function CheckOpsLogin() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const supportsPasskeys = passkeysSupported();

  // If already signed in, resolve and redirect to their tenant.
  useEffect(() => {
    if (authLoading || !user) return;
    void resolveAndRedirect(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, authLoading]);

  const resolveAndRedirect = async (userId: string, emailHint?: string | null) => {
    // The platform owner is not a member of any single organization — it lands
    // on Tenant Management, never inside a tenant's Moov-backed workspace.
    // Resolve the email defensively: the useAuth closure can briefly hold a
    // stale user object right after a session is exchanged, so fall back to the
    // live session before giving up on the bypass.
    let emailLc = (emailHint ?? user?.email ?? "").trim().toLowerCase();
    if (!isPlatformOwner(emailLc)) {
      const { data: fresh } = await supabase.auth.getUser();
      emailLc = (fresh.user?.email ?? emailLc).trim().toLowerCase();
    }
    if (isPlatformOwner(emailLc)) {
      navigate(`/admin/tenants`, { replace: true });
      return;
    }
    // Block mortgage-only accounts from entering ChecksOps.
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    const roles = new Set((roleRows ?? []).map((r) => r.role));
    const hasChecksOpsRole =
      roles.has("admin") ||
      roles.has("staff") ||
      roles.has("read_only") ||
      roles.has("guided") ||
      roles.has("contractor") ||
      roles.has("client");
    if (!hasChecksOpsRole && roles.has("mortgage_agent")) {
      await supabase.auth.signOut();
      toast({
        title: "Wrong portal",
        description: "This account is for the Mortgage Desk. Please sign in at /mortgage-ops/login.",
        variant: "destructive",
      });
      return;
    }

    const { data } = await supabase
      .from("tenant_users")
      .select("tenant_id, tenants!inner(slug, subscription_status)")
      .eq("user_id", userId);

    const memberships = (data ?? []).filter(
      (m: any) => m.tenants?.subscription_status === "active" && m.tenants?.slug
    );

    if (memberships.length === 0) {
      await supabase.auth.signOut();
      toast({
        title: "No ChecksOps access",
        description: "This account isn't a member of any active organization. Contact your admin.",
        variant: "destructive",
      });
      return;
    }

    const slug = (memberships[0] as any).tenants.slug as string;
    navigate(`/${slug}/checks`, { replace: true });
  };

  const handlePasskey = async () => {
    setLoading(true);
    try {
      const result = await signInWithPasskey(email || undefined);
      const authedId = result.user?.id;
      if (!authedId) throw new Error("Unable to start your session");
      await resolveAndRedirect(authedId, result.user?.email ?? email);
    } catch (err: any) {
      toast({
        title: "Passkey sign-in failed",
        description: err.message || "Try the email link instead.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast({ title: "Enter your email", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      await sendMagicLink(email, `${window.location.origin}/login`);
      setLinkSent(true);
    } catch (err: any) {
      toast({
        title: "Could not send sign-in link",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border/50">
        <CardHeader className="text-center space-y-3 pb-2">
          <div className="mx-auto">
            <CheckOpsLogo className="h-16 md:h-20" />
          </div>
          <CardTitle className="text-xl md:text-2xl">Sign in to ChecksOps</CardTitle>
          <p className="text-xs text-muted-foreground">
            Access your organization's check workflows.
          </p>
        </CardHeader>
        <CardContent className="pt-2 space-y-4">
          {linkSent ? (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription className="text-sm">
                Check <span className="font-medium">{email}</span> for your one-time sign-in link.
                It expires shortly — request a new one if it lapses.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <form onSubmit={handleMagicLink} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username webauthn"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                {supportsPasskeys && (
                  <div className="space-y-1.5">
                    <Button
                      type="button"
                      className="w-full"
                      disabled={loading}
                      onClick={() => void handlePasskey()}
                    >
                      {loading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <KeyRound className="mr-2 h-4 w-4" />
                      )}
                      Sign in with a passkey
                      <Badge variant="secondary" className="ml-2">Recommended</Badge>
                    </Button>
                    <p className="text-center text-[11px] text-muted-foreground">
                      Fastest and most secure — Face ID, Touch ID or Windows Hello. Nothing to
                      remember, nothing to phish.
                    </p>
                  </div>
                )}

                <div className="relative py-1">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border/60" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-card px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                      or
                    </span>
                  </div>
                </div>

                <Button type="submit" variant="outline" className="w-full" disabled={loading}>
                  <Mail className="mr-2 h-4 w-4" />
                  Email me a sign-in link
                </Button>
              </form>

              <p className="text-center text-[11px] text-muted-foreground">
                Two-factor verification is still required before any money moves.
              </p>
            </>
          )}

          <div className="mt-6 pt-4 border-t border-border/40 flex flex-col items-center gap-1">
            <Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground">
              <Link to="/signup">Need an account? Create one</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground">
              <Link to="/"><ArrowLeft className="h-3 w-3 mr-1" /> Back to checksops.com</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
