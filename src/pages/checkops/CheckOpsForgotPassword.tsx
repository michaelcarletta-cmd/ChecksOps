import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";

export default function CheckOpsForgotPassword() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo: `${window.location.origin}/reset-password` }
      );
      if (error) throw error;
      setSent(true);
    } catch (err: any) {
      toast({
        title: "Couldn't send reset email",
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
            <CheckOpsLogo className="h-10" />
          </div>
          <CardTitle className="text-xl md:text-2xl">Reset your password</CardTitle>
          <p className="text-xs text-muted-foreground">
            Enter your email and we'll send you a link to reset it.
          </p>
        </CardHeader>
        <CardContent className="pt-2">
          {sent ? (
            <div className="space-y-4 text-center py-4">
              <CheckCircle2 className="h-10 w-10 mx-auto text-primary" />
              <div>
                <p className="text-sm font-medium">Check your inbox</p>
                <p className="text-xs text-muted-foreground mt-1">
                  If an account exists for <strong>{email}</strong>, you'll receive a password
                  reset link shortly.
                </p>
              </div>
              <Button variant="outline" className="w-full" asChild>
                <Link to="/login">Back to sign in</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
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
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send reset link
              </Button>
            </form>
          )}
          <div className="mt-6 pt-4 border-t border-border/40 text-center">
            <Button variant="ghost" size="sm" asChild className="text-xs text-muted-foreground">
              <Link to="/login"><ArrowLeft className="h-3 w-3 mr-1" /> Back to sign in</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
