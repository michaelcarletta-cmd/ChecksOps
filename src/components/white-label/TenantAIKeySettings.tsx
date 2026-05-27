import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  KeyRound,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Trash2,
  RefreshCw,
  ExternalLink,
  Shield,
} from "lucide-react";
import { format } from "date-fns";

export function TenantAIKeySettings() {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [keyInput, setKeyInput] = useState("");

  const tenantId = tenant?.id;

  const { data: cred, isLoading } = useQuery({
    queryKey: ["tenant-openai-cred", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_openai_credentials" as any)
        .select("key_last_4, status, last_validated_at, last_error, updated_at")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!tenantId,
  });

  const saveMutation = useMutation({
    mutationFn: async (api_key: string) => {
      const { data, error } = await supabase.functions.invoke("tenant-set-openai-key", {
        body: { tenant_id: tenantId, api_key },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "Failed to save");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Key saved", description: "AI is now active for this tenant." });
      setKeyInput("");
      qc.invalidateQueries({ queryKey: ["tenant-openai-cred", tenantId] });
    },
    onError: (e: any) =>
      toast({ title: "Could not save key", description: e.message, variant: "destructive" }),
  });

  const validateMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("tenant-validate-openai-key", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      toast({
        title: data?.ok ? "Key is valid" : "Key failed validation",
        description: data?.error ?? "",
        variant: data?.ok ? "default" : "destructive",
      });
      qc.invalidateQueries({ queryKey: ["tenant-openai-cred", tenantId] });
    },
    onError: (e: any) =>
      toast({ title: "Validation failed", description: e.message, variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("tenant-remove-openai-key", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Key removed" });
      qc.invalidateQueries({ queryKey: ["tenant-openai-cred", tenantId] });
    },
  });

  const hasKey = !!cred?.key_last_4;
  const status = cred?.status as "active" | "invalid" | "unverified" | undefined;

  return (
    <div className="space-y-6">
      {/* Status card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> OpenAI API Key
            {hasKey && status === "active" && (
              <Badge className="text-[9px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-500/30">
                Active
              </Badge>
            )}
            {hasKey && status === "invalid" && (
              <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                Invalid
              </Badge>
            )}
            {hasKey && status === "unverified" && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                Unverified
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : hasKey ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3">
                <div>
                  <div className="text-sm font-mono">sk-•••••••••••••••{cred.key_last_4}</div>
                  {cred.last_validated_at && (
                    <div className="text-xs text-muted-foreground mt-1">
                      Last verified{" "}
                      {format(new Date(cred.last_validated_at), "MMM d, yyyy h:mm a")}
                    </div>
                  )}
                  {cred.last_error && (
                    <div className="text-xs text-destructive mt-1">{cred.last_error}</div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={validateMutation.isPending}
                    onClick={() => validateMutation.mutate()}
                  >
                    {validateMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={removeMutation.isPending}
                    onClick={() => {
                      if (confirm("Remove this key? AI features will stop until you add a new one.")) {
                        removeMutation.mutate();
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {status === "invalid" && (
                <div className="flex items-start gap-2 text-xs text-destructive p-3 rounded-lg border border-destructive/30 bg-destructive/5">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>
                    OpenAI rejected this key on the last check. Replace it below — AI features
                    are paused until a working key is on file.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2 text-xs text-muted-foreground p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" />
              <p>
                No API key configured. AI features (document analysis, drafts, photo
                intelligence) are paused until you add one below.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/replace key */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{hasKey ? "Replace key" : "Add your OpenAI key"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">How it works</p>
            <ol className="space-y-1 list-decimal list-inside">
              <li>
                Create an account at{" "}
                <a
                  href="https://platform.openai.com/signup"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary inline-flex items-center gap-0.5 hover:underline"
                >
                  platform.openai.com <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                Add a payment method under{" "}
                <a
                  href="https://platform.openai.com/settings/organization/billing/overview"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary inline-flex items-center gap-0.5 hover:underline"
                >
                  Billing <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>
                Create a key at{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary inline-flex items-center gap-0.5 hover:underline"
                >
                  API keys <ExternalLink className="h-3 w-3" />
                </a>{" "}
                — copy it (starts with <code className="text-foreground">sk-</code>) and paste below
              </li>
            </ol>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="oai-key" className="text-xs">
              OpenAI API key
            </Label>
            <Input
              id="oai-key"
              type="password"
              autoComplete="off"
              placeholder="sk-..."
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              Your key is encrypted at rest and never shown again after saving.
            </p>
          </div>

          <Button
            disabled={!keyInput.trim().startsWith("sk-") || saveMutation.isPending}
            onClick={() => saveMutation.mutate(keyInput.trim())}
            className="w-full"
          >
            {saveMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating with OpenAI...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Save and verify
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Security disclaimer */}
      <Card className="border-border/60">
        <CardContent className="pt-4 pb-3">
          <div className="flex items-start gap-2">
            <Shield className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">You own this key. We bill nothing.</p>
              <p>
                All AI calls for this tenant use your OpenAI account directly. You'll see usage
                and pay invoices through OpenAI's dashboard — not through us. Revoke this key
                anytime at{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  platform.openai.com/api-keys
                </a>
                .
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
