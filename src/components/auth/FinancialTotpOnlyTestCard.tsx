import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { useStepUp } from "@/hooks/useStepUp";
import { useToast } from "@/hooks/use-toast";
import { awsMfaAvailable } from "@/lib/awsMfa";
import { awsApiBaseUrl } from "@/lib/awsStaging";
import { loadAwsIdentityFinancialRoles } from "@/lib/financialTotpOnlyIdentity";
import {
  FINANCIAL_TOTP_ONLY_COPY,
  FINANCIAL_TOTP_ONLY_FORBIDDEN,
  canShowFinancialTotpOnlyTestCard,
  isExistingCheckId,
  runFinancialTotpOnlyVerification,
  type FinancialTotpOnlyOutcome,
} from "@/lib/financialTotpOnlyTest";

/**
 * Internal Account Security control: real check-bound TOTP, then stop.
 * Never invokes CheckAlt, Moov, or any deposit/prepare/assign workflow.
 */
export function FinancialTotpOnlyTestCard() {
  const { toast } = useToast();
  const { user, userRole } = useAuth();
  const { requireStepUp } = useStepUp();
  const [checkId, setCheckId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FinancialTotpOnlyOutcome | { error: string } | null>(null);
  const [identityRoles, setIdentityRoles] = useState<unknown>(null);
  const knownRoles = [userRole, user?.app_metadata, identityRoles];
  const visible = canShowFinancialTotpOnlyTestCard({
    awsMfaAvailable: awsMfaAvailable(),
    userId: user?.id,
    roles: knownRoles,
  });

  useEffect(() => {
    if (!awsMfaAvailable() || !user?.id) {
      setIdentityRoles([]);
      return;
    }
    if (
      canShowFinancialTotpOnlyTestCard({
        awsMfaAvailable: true,
        userId: user.id,
        roles: [userRole, user.app_metadata],
      })
    ) {
      setIdentityRoles([]);
      return;
    }
    let cancelled = false;
    void loadAwsIdentityFinancialRoles({
      awsMfaAvailable: true,
      apiBaseUrl: awsApiBaseUrl(),
    }).then((result) => {
      if (cancelled) return;
      setIdentityRoles(result.ok ? result.roles : []);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.app_metadata, userRole]);

  if (!visible) {
    return null;
  }

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const verified = await runFinancialTotpOnlyVerification({
        roles: knownRoles,
        checkId,
        requireStepUp,
      });
      if (!verified.ok) {
        const stopError = (verified as { error?: string }).error ?? "financial_role_required";
        setResult({ error: stopError });
        toast({
          title: "Verification did not start",
          description:
            stopError === "existing_check_required"
              ? "Enter an existing check UUID. Tenant and amount are taken from that check on the server."
              : "Owner, admin, or manager is required. This control is not a deposit path.",
          variant: "destructive",
        });
        return;
      }
      setResult(verified.outcome);
      toast({
        title: verified.outcome.authorized
          ? "Financial TOTP authorized — stopped"
          : "Financial TOTP was not completed",
        description: FINANCIAL_TOTP_ONLY_COPY,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-5 w-5 text-amber-600" />
          Financial TOTP test
        </CardTitle>
        <CardDescription>{FINANCIAL_TOTP_ONLY_COPY}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-xs space-y-2">
            <p className="font-medium">{FINANCIAL_TOTP_ONLY_COPY}</p>
            <p>
              This calls the real production step-up endpoint for{" "}
              <code>deposit.submit</code>, bound to the check you enter. Tenant and
              amount are derived on the server. It does not submit, approve, prepare,
              or assign a deposit, and it does not call CheckAlt or Moov.
            </p>
            <p>
              Forbidden after success: {FINANCIAL_TOTP_ONLY_FORBIDDEN.join(", ")}.
            </p>
          </AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label htmlFor="financial-totp-only-check">Existing check ID</Label>
          <Input
            id="financial-totp-only-check"
            value={checkId}
            onChange={(event) => setCheckId(event.target.value.trim())}
            placeholder="00000000-0000-4000-8000-000000000000"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Must already exist. Do not use this control to submit that check.
          </p>
        </div>

        <Button
          type="button"
          variant="secondary"
          disabled={busy || !isExistingCheckId(checkId)}
          onClick={() => void run()}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {FINANCIAL_TOTP_ONLY_COPY}
        </Button>

        {result && "error" in result && (
          <p className="text-xs text-destructive">{result.error}</p>
        )}
        {result && "authorized" in result && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
            <p className="font-medium text-foreground">
              {result.authorized
                ? "Authorization recorded. Stopped. No deposit was submitted."
                : "Step-up was cancelled or failed. Nothing was submitted."}
            </p>
            <p>continued: {String(result.continued)}</p>
            <p>provider HTTP: {String(result.providerHttp)}</p>
            <p>check / stage / checkalt_deposits mutated: no</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
