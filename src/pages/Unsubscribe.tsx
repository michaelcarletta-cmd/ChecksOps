import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loader2, MailCheck, MailX } from "lucide-react";

type State =
  | { kind: "loading" }
  | { kind: "valid"; email: string }
  | { kind: "already" }
  | { kind: "invalid"; message: string }
  | { kind: "confirming" }
  | { kind: "done"; email: string }
  | { kind: "error"; message: string };

export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

  useEffect(() => {
    if (!token) {
      setState({ kind: "invalid", message: "Missing unsubscribe token." });
      return;
    }
    (async () => {
      try {
        const resp = await fetch(
          `${supabaseUrl}/functions/v1/handle-email-unsubscribe?token=${encodeURIComponent(token)}`,
          { headers: { apikey: supabaseAnonKey } },
        );
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          setState({ kind: "invalid", message: json?.error || "Invalid or expired link." });
          return;
        }
        if (json?.alreadyUnsubscribed) {
          setState({ kind: "already" });
          return;
        }
        setState({ kind: "valid", email: json?.email ?? "" });
      } catch {
        setState({ kind: "invalid", message: "Could not validate this link." });
      }
    })();
  }, [token, supabaseUrl, supabaseAnonKey]);

  const confirm = async () => {
    if (state.kind !== "valid") return;
    setState({ kind: "confirming" });
    const { data, error } = await supabase.functions.invoke("handle-email-unsubscribe", {
      body: { token },
    });
    if (error) {
      setState({ kind: "error", message: error.message });
      return;
    }
    setState({ kind: "done", email: (data as any)?.email ?? state.email });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {state.kind === "done" || state.kind === "already" ? (
              <MailX className="h-5 w-5 text-primary" />
            ) : (
              <MailCheck className="h-5 w-5 text-primary" />
            )}
            Email preferences
          </CardTitle>
          <CardDescription>Manage your ChecksOps email subscription.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.kind === "loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Validating link…
            </div>
          )}
          {state.kind === "valid" && (
            <>
              <p className="text-sm">
                Click below to unsubscribe <strong>{state.email}</strong> from ChecksOps emails.
              </p>
              <Button onClick={confirm} className="w-full">Confirm unsubscribe</Button>
            </>
          )}
          {state.kind === "confirming" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Unsubscribing…
            </div>
          )}
          {state.kind === "done" && (
            <p className="text-sm">
              <strong>{state.email}</strong> has been unsubscribed. You won't receive further emails.
            </p>
          )}
          {state.kind === "already" && (
            <p className="text-sm">This address is already unsubscribed.</p>
          )}
          {(state.kind === "invalid" || state.kind === "error") && (
            <p className="text-sm text-destructive">{state.message}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
