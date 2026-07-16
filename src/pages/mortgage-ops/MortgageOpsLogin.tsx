import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { mortgageSupabase as supabase } from "@/integrations/supabase/mortgageClient";
import { useAuth } from "@/hooks/useMortgageAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Building2 } from "lucide-react";

export default function MortgageOpsLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { user, userRole, loading: authLoading } = useMortgageAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (authLoading) return;
    if (user && (userRole === "mortgage_agent" || userRole === "admin")) {
      navigate("/mortgage-ops/queue", { replace: true });
    }
  }, [user, userRole, authLoading, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    // useAuth effect will bounce to /queue if role qualifies
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Building2 className="h-6 w-6 text-primary" />
          </div>
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
