import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTenant } from "@/contexts/TenantContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { isCheckOpsHost } from "@/lib/checkopsHost";

export function WhiteLabelLogin() {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetSending, setResetSending] = useState(false);

  const handleForgotPassword = async () => {
    const target = email.trim().toLowerCase();
    if (!target) {
      toast({ title: "Enter your email first", description: "Type your email above, then click Forgot password.", variant: "destructive" });
      return;
    }
    setResetSending(true);
    try {
      const redirectTo = `${window.location.origin}${location.pathname.replace(/\/login.*$/, "")}/login`;
      const { error } = await supabase.auth.resetPasswordForEmail(target, { redirectTo });
      if (error) throw error;
      toast({ title: "Check your email", description: `If an account exists for ${target}, we sent reset instructions.` });
    } catch (err: any) {
      toast({ title: "Could not send reset email", description: err.message || "Try again in a moment.", variant: "destructive" });
    } finally {
      setResetSending(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedPassword = password.trim();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/token?grant_type=password`,
        {
          method: "POST",
          headers: {
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: normalizedEmail,
            password: normalizedPassword,
          }),
        }
      );

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.msg || payload?.error_description || payload?.error || "Invalid credentials");
      }

      const { data: sessionData, error } = await supabase.auth.setSession({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });

      if (error) throw error;

      const authenticatedUserId = sessionData.user?.id ?? sessionData.session?.user?.id;
      if (!authenticatedUserId) {
        throw new Error("Unable to start your session");
      }

      const { data: membership, error: membershipError } = await supabase
        .from("tenant_users")
        .select("id")
        .eq("tenant_id", tenant.id)
        .eq("user_id", authenticatedUserId)
        .maybeSingle();

      if (membershipError) {
        await supabase.auth.signOut();
        throw new Error("Unable to verify organization access");
      }

      if (!membership) {
        await supabase.auth.signOut();
        throw new Error(`This account doesn't have access to ${tenant.name}`);
      }

      const basePath = isCheckOpsHost()
        ? `/${tenant.slug}`
        : location.pathname.startsWith(`/wl/${tenant.slug}`)
          ? `/wl/${tenant.slug}`
          : "";
      const checksPath = basePath ? `${basePath}/checks` : "/checks";

      navigate(checksPath, { replace: true });
    } catch (err: any) {
      toast({
        title: "Login Failed",
        description: err.message || "Invalid credentials",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  if (!tenant) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border/50">
        <CardHeader className="text-center space-y-3 pb-2">
          {tenant.logo_url && (
            <img
              src={tenant.logo_url}
              alt={tenant.name}
              className="h-10 md:h-12 mx-auto object-contain"
            />
          )}
          <div>
            <CardTitle className="text-xl md:text-2xl">{tenant.name}</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">ChecksOps</p>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Sign In
            </Button>
            <button
              type="button"
              onClick={handleForgotPassword}
              disabled={resetSending}
              className="w-full text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-60"
            >
              {resetSending ? "Sending reset email…" : "Forgot password?"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
