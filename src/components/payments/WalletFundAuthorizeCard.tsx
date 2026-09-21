import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { useStepUp } from "@/hooks/useStepUp";
import { useToast } from "@/hooks/use-toast";
import { awsMfaAvailable } from "@/lib/awsMfa";
import { awsApiBaseUrl } from "@/lib/awsStaging";
import { loadAwsIdentityFinancialRoles } from "@/lib/financialTotpOnlyIdentity";
import {
  WALLET_FUND_AUTHORIZE_COPY,
  WALLET_FUND_AUTHORIZE_DESTINATION_LABEL,
  WALLET_FUND_AUTHORIZE_SOURCE_LABEL,
  canShowWalletFundAuthorizeCard,
  runWalletFundAuthorization,
} from "@/lib/walletFundAuthorize";

/**
 * Production Financial TOTP for wallet.fund. Stops after authorization.
 * Does not invoke the independent funding writer or disburse.
 */
export function WalletFundAuthorizeCard() {
  const { toast } = useToast();
  const { user, userRole } = useAuth();
  const { requireStepUp } = useStepUp();
  const [busy, setBusy] = useState(false);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [identityRoles, setIdentityRoles] = useState<unknown>(null);
  const knownRoles = [userRole, user?.app_metadata, identityRoles];
  const visible = canShowWalletFundAuthorizeCard({
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
      canShowWalletFundAuthorizeCard({
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

  if (!visible) return null;

  const run = async () => {
    setBusy(true);
    try {
      const result = await runWalletFundAuthorization({
        roles: knownRoles,
        requireStepUp,
      });
      if (!result.ok) {
        toast({
          title: "Authorization did not start",
          description: "Owner, admin, or manager is required. This control does not fund the wallet.",
          variant: "destructive",
        });
        return;
      }
      setAuthorized(result.authorized);
      toast({
        title: result.authorized
          ? "wallet.fund authorized — stopped"
          : "Financial TOTP was not completed",
        description: WALLET_FUND_AUTHORIZE_COPY,
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
          Authorize wallet.fund
        </CardTitle>
        <CardDescription>{WALLET_FUND_AUTHORIZE_COPY}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-xs space-y-2">
            <p>
              Source: {WALLET_FUND_AUTHORIZE_SOURCE_LABEL}. Destination:{" "}
              {WALLET_FUND_AUTHORIZE_DESTINATION_LABEL}. Amount: $0.01.
            </p>
            <p>
              Enter the Financial TOTP in this dialog. Do not paste the code into chat. This does
              not POST a transfer and does not authorize wallet.disburse.
            </p>
          </AlertDescription>
        </Alert>
        <Button onClick={() => void run()} disabled={busy}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Authorize $0.01 wallet.fund
        </Button>
        {authorized === true && (
          <p className="text-xs text-muted-foreground">
            Authorization recorded. Funding POST is a separate controlled step.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
