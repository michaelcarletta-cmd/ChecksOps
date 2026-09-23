import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
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
import { AlertTriangle, Loader2, ShieldCheck, UserCheck, UserPlus } from "lucide-react";

/**
 * Tenant-scoped CheckAlt register/account UI.
 * Reuses the existing Register Account surface from CheckAltSettings.
 * Does not show or edit the global checkalt_config singleton.
 */
export function CheckAltTenantAccountCard() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canManage = isPlatformOwner(user?.email);

  const { data: regAccount, isLoading: regLoading } = useQuery({
    queryKey: ["checkalt-tenant-account", tenant?.id],
    enabled: canManage && !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_tenant_accounts")
        .select("sso_user_id, deposit_account_number, first_name, last_name, email, enabled, registered_at, last_register_payload")
        .eq("tenant_id", tenant!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [reg, setReg] = useState({
    sso_user_id: "",
    first_name: "",
    last_name: "",
    email: "",
    deposit_account_number: "",
  });

  useEffect(() => {
    if (regAccount) {
      setReg({
        sso_user_id: regAccount.sso_user_id ?? "",
        first_name: regAccount.first_name ?? "",
        last_name: regAccount.last_name ?? "",
        email: regAccount.email ?? "",
        deposit_account_number: regAccount.deposit_account_number ?? "",
      });
    }
  }, [regAccount]);

  const registerMutation = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error("No tenant in context");
      requireAwsCheckAltProviderPath({
        apiBaseUrl: awsApiBaseUrl(),
        functionName: "checkalt-register-account",
      });
      const { data, error } = await invokeAwsCheckAltProviderFunction(
        "checkalt-register-account",
        { body: { tenant_id: tenant.id, ...reg } },
        { apiBaseUrl: awsApiBaseUrl() },
      );
      if (error) throw new Error(checkAltProviderUserMessage(error));
      if ((data as any)?.error) throw new Error(checkAltProviderUserMessage((data as any).error));
      return data;
    },
    onSuccess: () => {
      toast({ title: "Account registered with CheckAlt" });
      qc.invalidateQueries({ queryKey: ["checkalt-tenant-account"] });
    },
    onError: (e: unknown) =>
      toast({
        title: "Registration failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const [verifyResult, setVerifyResult] = useState<{ action: string; payload: unknown } | null>(null);

  const verifyMutation = useMutation({
    mutationFn: async (action: "user" | "account") => {
      if (!tenant?.id) throw new Error("No tenant in context");
      requireAwsCheckAltProviderPath({
        apiBaseUrl: awsApiBaseUrl(),
        functionName: "checkalt-verify-account",
      });
      const { data, error } = await invokeAwsCheckAltProviderFunction(
        "checkalt-verify-account",
        { body: { tenant_id: tenant.id, action } },
        { apiBaseUrl: awsApiBaseUrl() },
      );
      if (error) throw new Error(checkAltProviderUserMessage(error));
      if ((data as any)?.success === false) {
        setVerifyResult({ action, payload: (data as any).details ?? data });
        throw new Error((data as any).error || "Verification failed");
      }
      return { action, payload: (data as any)?.data };
    },
    onSuccess: ({ action, payload }) => {
      setVerifyResult({ action, payload });
      toast({
        title: action === "user" ? "User verified" : "Deposit account verified",
        description: "CheckAlt returned a valid response. See payload below.",
      });
    },
    onError: (e: unknown) =>
      toast({
        title: "Verification failed",
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
              Posts <code>fiKey, userId, firstName, lastName, emailAddress, isSSORequest, accountDataList[].accountNumber</code> to
              <code className="ml-1">/fincapture/useraccount/register</code>. The <code>userId</code> becomes the
              <code className="ml-1">ssoKey</code> used on every deposit submitted for this tenant.
            </CardDescription>
          </div>
          {regAccount?.registered_at ? (
            <Badge variant="default" className="shrink-0">
              <ShieldCheck className="h-3 w-3 mr-1" /> Registered
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0">
              <AlertTriangle className="h-3 w-3 mr-1" /> Not registered
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {regLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
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
                  placeholder="Bank account number"
                  value={reg.deposit_account_number}
                  onChange={(e) => setReg({ ...reg, deposit_account_number: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Registered/enabled:</span>
              <Badge variant={regAccount?.enabled ? "default" : "outline"} className="text-[10px]">
                {regAccount?.enabled ? "Enabled" : "Disabled"}
              </Badge>
              {regAccount?.registered_at ? (
                <span>Registered {new Date(regAccount.registered_at).toLocaleString()}</span>
              ) : (
                <span>Not registered</span>
              )}
            </div>

            {regAccount?.last_register_payload ? (
              <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                <p className="text-xs font-medium mb-1">Last CheckAlt response</p>
                <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                  {JSON.stringify(regAccount.last_register_payload, null, 2)}
                </pre>
              </div>
            ) : null}

            {verifyResult ? (
              <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                <p className="text-xs font-medium mb-1">
                  Verify {verifyResult.action === "user" ? "user" : "deposit account"} response
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
                disabled={verifyMutation.isPending || !regAccount?.registered_at}
              >
                {verifyMutation.isPending && verifyMutation.variables === "user"
                  ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  : <UserCheck className="h-4 w-4 mr-1" />}
                Verify user
              </Button>
              <Button
                onClick={() => registerMutation.mutate()}
                disabled={
                  registerMutation.isPending ||
                  !reg.sso_user_id ||
                  !reg.first_name ||
                  !reg.last_name ||
                  !reg.email ||
                  !reg.deposit_account_number ||
                  !tenant?.id
                }
              >
                {registerMutation.isPending
                  ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  : <UserPlus className="h-4 w-4 mr-1" />}
                {regAccount?.registered_at ? "Re-register account" : "Register account"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
