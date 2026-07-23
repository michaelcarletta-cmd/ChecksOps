import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { mortgageSupabase as supabase } from "@/integrations/supabase/mortgageClient";
import { useMortgageAuth } from "@/hooks/useMortgageAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Building2 } from "lucide-react";
import mortgageOpsLogo from "@/assets/mortgage-ops-logo.png";
import { getFriendlyAuthError, hardRefresh } from "@/lib/authErrorMessage";

export default function MortgageOpsLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      const friendly = getFriendlyAuthError(error);
      toast.error(friendly.title, {
        description: friendly.description,
        ...(friendly.needsHardRefresh && {
          action: { label: "Refresh now", onClick: () => hardRefresh() },
          duration: Infinity,
        }),
      });
      return;
    }
    // Verify role before allowing access — a ChecksOps-only user must not be
    // able to enter the Mortgage Desk even if their credentials are valid.
    const userId = data.user?.id;
    if (userId) {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId);
      const roleSet = new Set((roles ?? []).map((r) => r.role));
      if (!roleSet.has("mortgage_agent") && !roleSet.has("admin")) {
        await supabase.auth.signOut();
        setLoading(false);
        toast.error("This account doesn't have access to the Mortgage Desk.");
        return;
      }
    }
    setLoading(false);
    // useMortgageAuth effect will bounce to /queue.
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
          <p className="text-sm text-muted-foreground">Employee sign-in</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
            {user && userRole && userRole !== "mortgage_agent" && userRole !== "admin" && (
              <p className="text-sm text-destructive text-center">
                This portal is for ChecksOps mortgage agents only.
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
