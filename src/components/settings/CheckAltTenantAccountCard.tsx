import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { awsApiBaseUrl } from "@/lib/awsStaging";
import {
  checkAltProviderUserMessage,
  invokeAwsCheckAltProviderFunction,
  requireAwsCheckAltProviderPath,
} from "@/lib/awsCheckAltMoneyPath";
import { isPlatformOwner } from "@/lib/masterMerchant";
import { AlertTriangle, Landmark, Loader2, ShieldCheck, UserCheck, UserPlus } from "lucide-react";

/** Digits only, 5-17. No routing number: Check Alt binds the bank through the platform FI key. */
export const CHECKALT_ACCOUNT_NUMBER_PATTERN = /^\d{5,17}$/;

/** What checkalt-verify-account { action: "status" } returns. Account number is last four only. */
type CheckAltRegistrationStatus = {
  status?: "registered" | "not_registered";
  registered?: boolean;
  enabled?: boolean;
  registered_at?: string | null;
  sso_user_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  account_last4?: string | null;
  environment?: string;
};

const invokeCheckAlt = async (name: string, body: Record<string, unknown>) => {
  requireAwsCheckAltProviderPath({ apiBaseUrl: awsApiBaseUrl(), functionName: name });
  return invokeAwsCheckAltProviderFunction(name, { body }, { apiBaseUrl: awsApiBaseUrl() });
};

/**
 * Tenant-scoped Check Alt depositor registration (platform owner only).
 * Production: registers with Check Alt's live API and saves the tenant's
 * production checkalt_tenant_accounts row. Staging: the isolated UAT row.
 * Status and responses come from the server with the account number masked
 * to the last four digits; the full number is only ever typed, never read back.
 */
export function CheckAltTenantAccountCard() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canManage = isPlatformOwner(user?.email);
  const queryKey = ["checkalt-tenant-registration", tenant?.id];

  const { data: status, isLoading: statusLoading, error: statusError } = useQuery({
    queryKey,
    enabled: canManage && !!tenant?.id,
    queryFn: async (): Promise<CheckAltRegistrationStatus> => {
      const { data, error } = await invokeCheckAlt("checkalt-verify-account", {
        tenant_id: tenant!.id,
        action: "status",
      });
      if (error) throw new Error(checkAltProviderUserMessage(error));
      return (data ?? {}) as CheckAltRegistrationStatus;
    },
  });

  const registered = status?.registered === true;

  const [reg, setReg] = useState({
    sso_user_id: "",
    first_name: "",
    last_name: "",
    email: "",
    deposit_account_number: "",
  });

  useEffect(() => {
    if (status) {
      setReg((prev) => ({
        sso_user_id: status.sso_user_id ?? "",
        first_name: status.first_name ?? "",
        last_name: status.last_name ?? "",
        email: status.email ?? "",
        // Never prefilled: the browser does not receive the stored number.
        deposit_account_number: prev.deposit_account_number,
      }));
    }
  }, [status]);

  const accountNumberValid = CHECKALT_ACCOUNT_NUMBER_PATTERN.test(reg.deposit_account_number.trim());

  const registerMutation = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error("No tenant in context");
      const { data, error } = await invokeCheckAlt("checkalt-register-account", {
        tenant_id: tenant.id,
        sso_user_id: reg.sso_user_id.trim(),
        first_name: reg.first_name.trim(),
        last_name: reg.last_name.trim(),
        email: reg.email.trim(),
        deposit_account_number: reg.deposit_account_number.trim(),
      });
      if (error) {
        const message = (data as { message?: string } | null)?.message;
        throw new Error(message || checkAltProviderUserMessage(error));
      }
      return data as CheckAltRegistrationStatus & { warning?: string };
    },
    onSuccess: (data) => {
      setReg((prev) => ({ ...prev, deposit_account_number: "" }));
      toast({
        title: "Account registered with Check Alt",
        description: data?.warning || (data?.account_last4 ? `Deposit account ending ${data.account_last4}` : undefined),
      });
      qc.invalidateQueries({ queryKey: ["checkalt-tenant-registration"] });
    },
    onError: (e: unknown) =>
      toast({
        title: "Registration failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const [verifyResult, setVerifyResult] = useState<{ action: string; ok: boolean; payload: unknown } | null>(null);

  const verifyMutation = useMutation({
    mutationFn: async (action: "user" | "account") => {
      if (!tenant?.id) throw new Error("No tenant in context");
      const { data, error } = await invokeCheckAlt("checkalt-verify-account", { tenant_id: tenant.id, action });
      // Server responses are already masked to the last four digits.
      const payload = (data as { data?: unknown; details?: unknown } | null)?.data
        ?? (data as { details?: unknown } | null)?.details
        ?? null;
      if (error) {
        setVerifyResult({ action, ok: false, payload });
        throw new Error(checkAltProviderUserMessage(error));
      }
      return { action, payload };
    },
    onSuccess: ({ action, payload }) => {
      setVerifyResult({ action, ok: true, payload });
      toast({
        title: action === "user" ? "Check Alt found this user" : "Check Alt found this deposit account",
        description: "This is Check Alt's live answer right now. Nothing was saved.",
      });
    },
    onError: (e: unknown) =>
      toast({
        title: "Check Alt verification failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      }),
  });

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Tenant CheckAlt account settings are restricted to the platform owner.
        </CardContent>
      </Card>
    );
  }

  const environmentLabel = status?.environment === "production" ? "Production" : status?.environment === "uat" ? "UAT" : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <UserPlus className="h-4 w-4 text-primary" />
              Register Tenant Account with CheckAlt
            </CardTitle>
            <CardDescription>
              Registers this tenant's depositor with Check Alt
              (<code>/fincapture/useraccount/register</code>). The User ID becomes the
              <code className="ml-1">ssoKey</code> used on every deposit submitted for this tenant, and deposits
              are credited to the account number registered here.
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {registered ? (
              <Badge variant="default">
                <ShieldCheck className="h-3 w-3 mr-1" /> Registered
              </Badge>
            ) : (
              <Badge variant="outline">
                <AlertTriangle className="h-3 w-3 mr-1" /> Not registered
              </Badge>
            )}
            {environmentLabel ? (
              <span className="text-[10px] text-muted-foreground">{environmentLabel}</span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {statusLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {statusError ? (
              <p className="text-xs text-destructive">
                Could not load the Check Alt registration: {statusError instanceof Error ? statusError.message : "unknown error"}
              </p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sso_user_id">User ID (ssoKey)</Label>
                <Input
                  id="sso_user_id"
                  placeholder="e.g. mcarletta"
                  value={reg.sso_user_id}
                  onChange={(e) => setReg({ ...reg, sso_user_id: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Unique identifier for this depositor. Becomes the <code>ssoKey</code> on all deposits.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg_email">Email address</Label>
                <Input
                  id="reg_email"
                  type="email"
                  placeholder="user@company.com"
                  value={reg.email}
                  onChange={(e) => setReg({ ...reg, email: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg_first">First name</Label>
                <Input
                  id="reg_first"
                  value={reg.first_name}
                  onChange={(e) => setReg({ ...reg, first_name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg_last">Last name</Label>
                <Input
                  id="reg_last"
                  value={reg.last_name}
                  onChange={(e) => setReg({ ...reg, last_name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="reg_acct">Deposit account number</Label>
                <Input
                  id="reg_acct"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={
                    status?.account_last4
                      ? `On file: ending ${status.account_last4}. Enter the full number to re-register.`
                      : "Bank account number (digits only)"
                  }
                  value={reg.deposit_account_number}
                  onChange={(e) => setReg({ ...reg, deposit_account_number: e.target.value })}
                />
                {reg.deposit_account_number && !accountNumberValid ? (
                  <p className="text-xs text-destructive">Digits only, 5 to 17 digits.</p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {registered ? (
                <>
                  <Landmark className="h-3 w-3" />
                  <span>Deposit account ending {status?.account_last4 ?? "----"}</span>
                  <Badge variant={status?.enabled ? "default" : "outline"} className="text-[10px]">
                    {status?.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  {status?.registered_at ? (
                    <span>Registered {new Date(status.registered_at).toLocaleString()}</span>
                  ) : null}
                </>
              ) : (
                <span>Not registered</span>
              )}
            </div>

            {verifyResult ? (
              <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                <p className="text-xs font-medium mb-1">
                  Check Alt's live answer for the {verifyResult.action === "user" ? "user" : "deposit account"}
                  {verifyResult.ok ? "" : " (failed)"}. Account numbers are masked; nothing was saved.
                </p>
                <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                  {JSON.stringify(verifyResult.payload, null, 2)}
                </pre>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => verifyMutation.mutate("user")}
                disabled={verifyMutation.isPending || !registered}
              >
                {verifyMutation.isPending && verifyMutation.variables === "user"
                  ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  : <UserCheck className="h-4 w-4 mr-1" />}
                Verify user
              </Button>
              <Button
                variant="outline"
                onClick={() => verifyMutation.mutate("account")}
                disabled={verifyMutation.isPending || !registered}
              >
                {verifyMutation.isPending && verifyMutation.variables === "account"
                  ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  : <Landmark className="h-4 w-4 mr-1" />}
                Verify account
              </Button>
              <Button
                onClick={() => registerMutation.mutate()}
                disabled={
                  registerMutation.isPending ||
                  !reg.sso_user_id.trim() ||
                  !reg.first_name.trim() ||
                  !reg.last_name.trim() ||
                  !reg.email.trim() ||
                  !accountNumberValid ||
                  !tenant?.id
                }
              >
                {registerMutation.isPending
                  ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  : <UserPlus className="h-4 w-4 mr-1" />}
                {registered ? "Re-register account" : "Register account"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
