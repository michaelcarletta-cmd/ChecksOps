import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useStepUp } from "@/hooks/useStepUp";

/**
 * Shows TOTP status and lets the user enrol. Enrolment reuses the same
 * step-up dialog that guards financial actions, so there is one code path.
 */
export function TotpManagerCard() {
  const { toast } = useToast();
  const { requireStepUp, refreshFactors, verified } = useStepUp();
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      setEnrolled(null);
      return;
    }
    setEnrolled((data?.totp ?? []).some((f) => f.status === "verified"));
  }, []);

  useEffect(() => {
    void load();
  }, [load, verified]);

  const start = async () => {
    setBusy(true);
    const ok = await requireStepUp({
      actionKey: "totp.enroll",
      title: enrolled ? "Confirm your authenticator" : "Set up two-factor",
      description: enrolled
        ? "Enter a current code to confirm your authenticator still works."
        : "Two-factor is required before you can move money. Set it up now.",
    });
    setBusy(false);
    if (ok) {
      await refreshFactors();
      await load();
    }
  };

  const remove = async () => {
    const { data } = await supabase.auth.mfa.listFactors();
    const factor = (data?.totp ?? []).find((f) => f.status === "verified");
    if (!factor) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) {
      toast({ title: "Could not remove", description: error.message, variant: "destructive" });
      return;
    }
    toast({
      title: "Authenticator removed",
      description: "You'll be asked to set up a new one at your next financial action.",
    });
    await refreshFactors();
    await load();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {enrolled ? (
            <ShieldCheck className="h-5 w-5 text-primary" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-destructive" />
          )}
          Two-factor authentication
          <Badge variant={enrolled ? "secondary" : "destructive"} className="ml-1">
            {enrolled === null ? "Checking" : enrolled ? "Active" : "Required"}
          </Badge>
        </CardTitle>
        <CardDescription>
          An authenticator app code is required before approving deposits, sending disbursements,
          funding a wallet or changing bank details — no matter how you signed in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {enrolled === false && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">
              Two-factor isn't set up. Money-movement actions will stay blocked until it is.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void start()} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {enrolled ? "Verify authenticator" : "Set up two-factor"}
          </Button>
          {enrolled && (
            <Button variant="outline" onClick={() => void remove()}>
              Remove authenticator
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
