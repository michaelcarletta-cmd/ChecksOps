import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { deleteAwsPasskey, listAwsPasskeys, registerAwsPasskey } from "@/lib/awsPasskeys";
import { isAwsStaging, isAwsStagingEnvironment, isAwsStagingHttpsPasskeysEnabled, AWS_STAGING_HTTPS_ORIGIN } from "@/lib/awsStaging";
import {
  formatPasskeyMetaLine,
  passkeyCreatedAtIso,
  passkeyDisplayName,
} from "@/lib/passkeyDisplay";
import { passkeysSupported, registerPasskey } from "@/lib/passkeys";

interface PasskeyRow {
  id: string;
  device_name: string;
  created_at: string | null;
  last_used_at: string | null;
}

/** Lets a signed-in user add, review and remove their passkeys. */
export function PasskeyManagerCard({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const awsStaging = isAwsStaging();
  const awsStagingHost = isAwsStagingEnvironment();
  const awsHttpsPasskeys = isAwsStagingHttpsPasskeysEnabled();
  const supported = passkeysSupported();
  // AWS staging: Cognito WebAuthn only on the HTTPS staging origin. Production: Supabase table.
  const cognitoMode = awsStaging && awsHttpsPasskeys;
  const blockedOnAwsHttp = awsStaging && !awsHttpsPasskeys;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (blockedOnAwsHttp) {
        setRows([]);
        return;
      }
      if (cognitoMode) {
        const credentials = await listAwsPasskeys();
        setRows(
          credentials.map((row) => ({
            id: row.credentialId,
            device_name: passkeyDisplayName(row),
            // null when Cognito/API omits or sends invalid timestamps — never invent "now" or epoch.
            created_at: passkeyCreatedAtIso(row.createdAt),
            // Cognito does not expose last-used; omit the field when absent.
            last_used_at: passkeyCreatedAtIso(row.lastUsedAt ?? null),
          })),
        );
        return;
      }
      const { data, error } = await supabase
        .from("user_passkeys")
        .select("id, device_name, created_at, last_used_at")
        .order("created_at", { ascending: false });
      if (!error) {
        setRows(
          ((data ?? []) as PasskeyRow[]).map((row) => ({
            id: row.id,
            device_name: passkeyDisplayName(row),
            created_at: passkeyCreatedAtIso(row.created_at),
            last_used_at: passkeyCreatedAtIso(row.last_used_at),
          })),
        );
      }
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [blockedOnAwsHttp, cognitoMode]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setAdding(true);
    try {
      if (cognitoMode) {
        await registerAwsPasskey();
      } else {
        await registerPasskey();
      }
      toast({ title: "Passkey added", description: "You can now sign in without an email link." });
      await load();
      onChanged?.();
    } catch (err: any) {
      toast({ title: "Passkey setup failed", description: err.message, variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    if (cognitoMode) {
      try {
        await deleteAwsPasskey(id);
      } catch (err: any) {
        toast({ title: "Could not remove passkey", description: err.message, variant: "destructive" });
        return;
      }
      toast({ title: "Passkey removed" });
      await load();
      onChanged?.();
      return;
    }
    const { error } = await supabase.from("user_passkeys").delete().eq("id", id);
    if (error) {
      toast({ title: "Could not remove passkey", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Passkey removed" });
    await load();
    onChanged?.();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          Passkeys
          <Badge variant="secondary" className="ml-1">Recommended</Badge>
        </CardTitle>
        <CardDescription>
          Sign in with Face ID, Touch ID, Windows Hello or a security key — the fastest and most
          secure option. Nothing to remember and nothing to phish.
          {cognitoMode ? (awsStagingHost ? " AWS staging stores passkeys in Cognito (staging RP only)." : " Passkeys are stored in Cognito for this origin.") : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {blockedOnAwsHttp && (
          <Alert>
            <AlertDescription className="text-xs">
              Passkey management is available only at {AWS_STAGING_HTTPS_ORIGIN}. This origin
              fails closed{awsStagingHost ? " — production Supabase passkeys are not used or modified here." : "."}
            </AlertDescription>
          </Alert>
        )}

        {!supported && !blockedOnAwsHttp && (
          <Alert>
            <AlertDescription className="text-xs">
              This browser doesn't support passkeys. You can still sign in with an email link.
            </AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : blockedOnAwsHttp ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No passkeys registered yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows.map((row) => {
              const meta = formatPasskeyMetaLine(row);
              return (
                <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{row.device_name}</p>
                    {meta ? (
                      <p className="text-xs text-muted-foreground">{meta}</p>
                    ) : null}
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => void remove(row.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <Button
          onClick={() => void add()}
          disabled={!supported || adding || blockedOnAwsHttp}
          className="w-full sm:w-auto"
        >
          {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          Add a passkey
        </Button>
      </CardContent>
    </Card>
  );
}
