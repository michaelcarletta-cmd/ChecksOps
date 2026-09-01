import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTenant } from "@/contexts/TenantContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, KeyRound, Mail, CheckCircle2 } from "lucide-react";
import { isCheckOpsHost } from "@/lib/checkopsHost";
import { isPlatformOwner } from "@/lib/masterMerchant";
import { passkeysSupported, sendMagicLink, signInWithPasskey } from "@/lib/passkeys";

/**
 * Tenant-branded sign-in. Passwords are retired platform-wide: users sign in
 * with a passkey (recommended) or a one-time email link.
 */
export function WhiteLabelLogin() {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const supportsPasskeys = passkeysSupported();

  const resolveAndRedirect = async (userId: string, emailHint?: string | null) => {
    const emailLc = (emailHint ?? "").trim().toLowerCase();
    if (isPlatformOwner(emailLc)) {
      navigate("/admin/tenants", { replace: true });
      return;
    }

    const { data: membership, error: membershipError } = await supabase
      .from("tenant_users")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("user_id", userId)
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
    navigate(basePath ? `${basePath}/checks` : "/checks", { replace: true });
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
      await sendMagicLink(email, `${window.location.origin}${location.pathname}`);
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
                      Fastest and most secure — Face ID, Touch ID or Windows Hello.
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
        </CardContent>
      </Card>
    </div>
  );
}
