import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { awsApiBaseUrl } from "@/lib/awsStaging";
import { usePermissions } from "@/hooks/usePermissions";
import {
  fetchDbValidatorDiagnostics,
  isDbValidatorUiEnabled,
  type DbValidatorOutcome,
} from "@/lib/dbValidatorDiagnostics";

export default function AdminDbValidator() {
  const { isAdmin } = usePermissions();
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<DbValidatorOutcome | null>(null);

  const enabled = isDbValidatorUiEnabled({
    authProvider: import.meta.env.VITE_AUTH_PROVIDER,
    hostname: typeof window !== "undefined" ? window.location.hostname : null,
    isAdmin,
  });

  if (!enabled) return null;

  const run = async () => {
    setLoading(true);
    setOutcome(
      await fetchDbValidatorDiagnostics({
        baseUrl: awsApiBaseUrl(),
        getToken: async () => (await supabase.auth.getSession()).data.session?.access_token,
      }),
    );
    setLoading(false);
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>Staging database validator</CardTitle>
          <CardDescription>
            Read-only check of the existing validator. Shows issue codes and table names only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={run} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run validator
          </Button>
          {outcome && outcome.status !== "success" && (
            <p role="alert" className="text-sm text-destructive">{outcome.message}</p>
          )}
          {outcome?.status === "success" && (
            <div className="space-y-2">
              <Badge variant={outcome.summary.ok ? "default" : "destructive"}>
                {outcome.summary.ok ? "ok" : "failing"}
              </Badge>
              {outcome.summary.issues.length === 0 && <p className="text-sm">No issues reported.</p>}
              <ul className="space-y-1 text-sm">
                {outcome.summary.issues.map((issue, index) => (
                  <li key={index}>
                    {issue.severity}: {issue.kind}
                    {issue.code ? ` (${issue.code})` : ""}
                    {issue.table ? ` — ${issue.table}` : ""}
                    {issue.probe ? ` — probe ${issue.probe}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
