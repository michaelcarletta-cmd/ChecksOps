import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft } from "lucide-react";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { useAuth } from "@/hooks/useAuth";
import { isPlatformOwner } from "@/lib/masterMerchant";
import { isAwsStaging } from "@/lib/awsStaging";

/**
 * Generic ChecksOps sign-in page at checkops.com/login.
 *
 * Authenticates the user, then resolves the tenant they belong to via
 * tenant_users and redirects to /{slug}/checks. Users who belong to multiple
 * tenants are sent to the first active one (tenant selector is a follow-up).
 */
export default function CheckOpsLogin() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [challengeSession, setChallengeSession] = useState<string | null>(null);

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
    // stale user object right after a password-recovery session is exchanged,
    // so fall back to the live session before giving up on the bypass.
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

  const finishLogin = async (authedId: string, authedEmail?: string | null) => {
    if (!authedId) throw new Error("Unable to start your session");
    await resolveAndRedirect(authedId, authedEmail ?? email);
  };

  const handleChallenge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmNewPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (newPassword.length < 12) {
      toast({
        title: "Password too short",
        description: "Use at least 12 characters with upper, lower, number, and symbol.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await (supabase.auth as any).completeNewPassword({
        email: email.trim().toLowerCase(),
        session: challengeSession,
        newPassword,
      });
      if (error) throw error;
      setChallengeSession(null);
      await finishLogin(data.user?.id, data.user?.email ?? email);
    } catch (err: any) {
      toast({
        title: "Couldn't set password",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password: password.trim(),
      });
      if (error && (error as any).code === "NEW_PASSWORD_REQUIRED") {
        setChallengeSession((error as any).session);
        toast({
          title: "Create a new password",
          description: "This account must set a permanent password before continuing.",
        });
        return;
      }
      if (error) throw error;
      const authedId = data.user?.id;
      if (!authedId) throw new Error("Unable to start your session");
      await resolveAndRedirect(authedId, data.user?.email ?? email);
    } catch (err: any) {
      toast({
        title: "Sign in failed",
        description: err.message || "Invalid credentials",
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
            {isAwsStaging() ? " AWS staging." : ""}
          </p>
        </CardHeader>
        <CardContent className="pt-2">
          {challengeSession ? (
            <form onSubmit={handleChallenge} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter a new password for <strong>{email}</strong>. Use at least 12 characters
                with upper, lower, number, and symbol.
              </p>
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-new-password">Confirm password</Label>
                <Input
                  id="confirm-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Set password and continue
              </Button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    to="/forgot-password"
                    className="text-xs text-muted-foreground hover:text-primary transition-colors"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Sign In
              </Button>
            </form>
          )}
          <div className="mt-6 pt-4 border-t border-border/40 text-center">
            <Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground">
              <Link to="/"><ArrowLeft className="h-3 w-3 mr-1" /> Back to checksops.com</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
