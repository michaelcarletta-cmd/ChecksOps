import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ShieldCheck, ShieldAlert, ShieldX, Loader2, FileCheck } from "lucide-react";
import { format } from "date-fns";

interface AchAuthorizationFormProps {
  stakeholderAccountId: string;
  accountNickname: string;
  accountLast4: string;
  custname: string;
}

type AchAuthorizationRow = {
  id: string;
  authorized_name: string;
  created_at: string;
  is_active: boolean;
};

type AchAuthorizationReply = {
  authorization?: AchAuthorizationRow | null;
  account_last4?: string | null;
  form_text?: string;
};

/**
 * The ACH debit authorization for one funding account. The API writes it (save-ach-authorization,
 * ach_authorizations is a server-only money table): the browser never inserts or updates the row,
 * and the signed text is the server's, built from the stored account.
 */
export function AchAuthorizationForm({
  stakeholderAccountId,
  accountNickname,
  accountLast4,
  custname,
}: AchAuthorizationFormProps) {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const tenantId = tenant?.id;

  const call = async (action: "get" | "authorize" | "revoke"): Promise<AchAuthorizationReply> => {
    const { data, error } = await supabase.functions.invoke("save-ach-authorization", {
      body: { tenant_id: tenantId, stakeholder_account_id: stakeholderAccountId, action },
    });
    if (error) throw new Error(await getFunctionErrorMessage(error, "The ACH authorization could not be saved."));
    return (data ?? {}) as AchAuthorizationReply;
  };

  const { data: reply, isLoading } = useQuery({
    queryKey: ["ach-authorization", tenantId, stakeholderAccountId],
    enabled: !!tenantId && !!stakeholderAccountId,
    queryFn: () => call("get"),
  });
  const auth = reply?.authorization ?? null;
  const last4 = reply?.account_last4 || accountLast4 || null;
  const formText = reply?.form_text
    ?? `I, ${custname}, authorize this platform to initiate ACH debit entries from my account ${last4 ? `ending in ${last4}` : "on file"} for the purpose of funding disbursements. I understand that this authorization will remain in effect until I revoke it.`;

  const authorize = useMutation({
    mutationFn: () => call("authorize"),
    onSuccess: () => {
      toast({ title: "ACH Debit Authorized", description: "Your funding account is now ready." });
      qc.invalidateQueries({ queryKey: ["ach-authorization", tenantId, stakeholderAccountId] });
    },
    onError: (err: Error) => {
      toast({ title: "Authorization failed", description: err.message, variant: "destructive" });
    },
  });

  const revoke = useMutation({
    mutationFn: () => call("revoke"),
    onSuccess: () => {
      toast({ title: "Authorization revoked" });
      qc.invalidateQueries({ queryKey: ["ach-authorization", tenantId, stakeholderAccountId] });
    },
    onError: (err: Error) => {
      toast({ title: "Revoke failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground animate-pulse">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking authorization status...
      </div>
    );
  }

  if (auth) {
    return (
      <Card className="mt-2 border-emerald-500/20 bg-emerald-500/5">
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-emerald-100 p-1 dark:bg-emerald-500/20">
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                    ACH Debit Authorized
                  </p>
                  <Badge variant="outline" className="h-5 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-700">
                    Active
                  </Badge>
                </div>
                <p className="text-xs text-emerald-600/80">
                  Signed by {auth.authorized_name} on {format(new Date(auth.created_at), "MMM d, yyyy")}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-emerald-200 text-xs hover:bg-emerald-100 hover:text-emerald-900"
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <ShieldX className="h-3 w-3 mr-1" />}
              Revoke
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-2 border-amber-500/20 bg-amber-500/5">
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-amber-100 p-1 dark:bg-amber-500/20">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
          </div>
          <div className="flex-1 space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                ACH Debit Authorization Required
              </p>
              <p className="text-xs text-amber-700/70 leading-relaxed">
                To use {accountNickname}{last4 ? ` (••••${last4})` : ""} as your primary funding account, you must authorize this platform to debit funds for disbursement.
              </p>
            </div>

            <div className="rounded border border-amber-200 bg-amber-50/50 p-2.5 text-[11px] text-amber-800 italic leading-snug">
              "{formText}"
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                className="h-8 bg-amber-600 text-xs hover:bg-amber-700"
                onClick={() => authorize.mutate()}
                disabled={authorize.isPending || !tenantId}
              >
                {authorize.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <FileCheck className="h-3 w-3 mr-1" />}
                Sign & Authorize ACH
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

