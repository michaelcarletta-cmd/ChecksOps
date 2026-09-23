import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/aws/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { isAwsStaging } from "@/lib/awsStaging";

export default function CheckOpsResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const aws = isAwsStaging();

  useEffect(() => {
    if (aws) {
      setHasRecoverySession(true);
      return;
    }
    // Supabase auto-exchanges the recovery link hash and fires PASSWORD_RECOVERY
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setHasRecoverySession(true);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setHasRecoverySession(true);
    });

    return () => subscription.unsubscribe();
  }, [aws]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const minLength = aws ? 12 : 8;
    if (password.length < minLength) {
      toast({
        title: "Password too short",
        description: aws
          ? "Use at least 12 characters with upper, lower, number, and symbol."
          : "Use at least 8 characters.",
        variant: "destructive",
      });
      return;
    }
    if (password !== confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      if (aws) {
        const { error } = await (supabase.auth as any).confirmForgotPassword({
          email: email.trim().toLowerCase(),
          code: code.trim(),
          password,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
      }
      toast({ title: "Password updated", description: "Signing you in..." });
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      if (next && /^https?:\/\//.test(next)) {
        window.location.replace(next);
      } else if (next) {
        navigate(next, { replace: true });
      } else {
        navigate("/login", { replace: true });
      }
    } catch (err: any) {
      toast({
        title: "Couldn't update password",
        description: err.message || "Please try again.",
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
            <CheckOpsLogo className="h-32" />
          </div>
          <CardTitle className="text-xl md:text-2xl">Set a new password</CardTitle>
          <p className="text-xs text-muted-foreground">
            {aws
              ? "Enter the confirmation code from the Tester mailbox and choose a new password."
              : "Choose a strong password you haven't used before."}
          </p>
        </CardHeader>
        <CardContent className="pt-2">
          {!hasRecoverySession ? (
            <p className="text-sm text-center text-muted-foreground py-6">
              Verifying your reset link…
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {aws && (
                <>
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
                    <Label htmlFor="code">Confirmation code</Label>
                    <Input
                      id="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      required
                    />
                  </div>
                </>
              )}
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Update password
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
