import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/aws/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, CheckCircle2, KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { passkeysSupported } from "@/lib/passkeys";
import { cn } from "@/lib/utils";

type Method = "passkey" | "magic_link";

/**
 * Account creation. The user picks how they will sign in — passkey (pushed as
 * the recommended default) or one-time email link. No password is ever set:
 * we generate an unusable random credential so the account can only be reached
 * through the chosen passwordless method.
 */
export default function CheckOpsSignup() {
  const { toast } = useToast();
  const supportsPasskeys = passkeysSupported();
  const [method, setMethod] = useState<Method>(supportsPasskeys ? "passkey" : "magic_link");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Unusable random credential — the account is passwordless by design.
      const throwaway = crypto.randomUUID() + crypto.randomUUID();
      const { error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password: throwaway,
        options: {
          emailRedirectTo: `${window.location.origin}/account/security`,
          data: {
            full_name: fullName.trim(),
            role: "staff",
            preferred_auth_method: method,
          },
        },
      });
      if (error) throw error;
      setDone(true);
    } catch (err: any) {
      toast({ title: "Could not create account", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md border-border/50">
          <CardHeader className="text-center space-y-3">
            <div className="mx-auto"><CheckOpsLogo className="h-14" /></div>
            <CardTitle className="text-xl">Confirm your email</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription className="text-sm">
                We sent a confirmation link to <span className="font-medium">{email}</span>. Open it
                and you'll land on your security setup, where you can
                {method === "passkey" ? " create your passkey" : " confirm email-link sign-in"} and
                register two-factor.
              </AlertDescription>
            </Alert>
            <p className="text-xs text-muted-foreground">
              Staff accounts require administrator approval before access is granted.
            </p>
            <Button variant="outline" className="w-full" asChild>
              <Link to="/login">Back to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const optionClass = (value: Method) =>
    cn(
      "w-full rounded-lg border p-3 text-left transition-colors",
      method === value
        ? "border-primary bg-primary/10"
        : "border-border hover:border-primary/50 hover:bg-muted/40",
    );

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border/50">
        <CardHeader className="text-center space-y-3 pb-2">
          <div className="mx-auto"><CheckOpsLogo className="h-14 md:h-16" /></div>
          <CardTitle className="text-xl md:text-2xl">Create your ChecksOps account</CardTitle>
          <p className="text-xs text-muted-foreground">Passwordless from day one.</p>
        </CardHeader>
        <CardContent className="pt-2">
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full name</Label>
              <Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-email">Work email</Label>
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>How do you want to sign in?</Label>

              <button
                type="button"
                className={optionClass("passkey")}
                onClick={() => setMethod("passkey")}
                disabled={!supportsPasskeys}
              >
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Passkey</span>
                  <Badge variant="secondary" className="ml-auto">Recommended</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Fastest and most secure. Face ID, Touch ID, Windows Hello or a security key —
                  nothing to remember and nothing to phish.
                  {!supportsPasskeys && " Not available in this browser."}
                </p>
              </button>

              <button
                type="button"
                className={optionClass("magic_link")}
                onClick={() => setMethod("magic_link")}
              >
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Email sign-in link</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  We email you a one-time link each time you sign in. Slower, and only as safe as
                  your inbox.
                </p>
              </button>
            </div>

            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Either way, you'll register an authenticator app. A two-factor code is required
                before any money moves.
              </AlertDescription>
            </Alert>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create account
            </Button>
          </form>

          <div className="mt-6 pt-4 border-t border-border/40 text-center">
            <Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground">
              <Link to="/login"><ArrowLeft className="h-3 w-3 mr-1" /> Already have an account?</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
