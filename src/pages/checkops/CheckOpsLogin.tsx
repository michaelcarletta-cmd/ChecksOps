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
  const [loading, setLoading] = useState(false);

  // If already signed in, resolve and redirect to their tenant.
  useEffect(() => {
    if (authLoading || !user) return;
    void resolveAndRedirect(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, authLoading]);

  const resolveAndRedirect = async (userId: string) => {
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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password: password.trim(),
      });
      if (error) throw error;
      const authedId = data.user?.id;
      if (!authedId) throw new Error("Unable to start your session");
      await resolveAndRedirect(authedId);
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
            <CheckOpsLogo className="h-10" />
          </div>
          <CardTitle className="text-xl md:text-2xl">Sign in to ChecksOps</CardTitle>
          <p className="text-xs text-muted-foreground">
            Access your organization's check workflows.
          </p>
        </CardHeader>
        <CardContent className="pt-2">
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
