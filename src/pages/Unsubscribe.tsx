import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loader2, MailCheck, MailX } from "lucide-react";
import { awsApiBaseUrl } from "@/lib/awsStaging";
import {
  emailUnsubscribeUrl,
  interpretUnsubscribeConfirm,
  interpretUnsubscribeGet,
} from "@/lib/awsFunctionUrls";

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

  useEffect(() => {
    if (!token) {
      setState({ kind: "invalid", message: "Missing unsubscribe token." });
      return;
    }
    (async () => {
      try {
        const resp = await fetch(emailUnsubscribeUrl(awsApiBaseUrl(), token));
        const json = await resp.json().catch(() => ({}));
        setState(interpretUnsubscribeGet(resp.status, json));
      } catch {
        setState({ kind: "invalid", message: "Could not validate this link." });
      }
    })();
  }, [token]);

  const confirm = async () => {
    if (state.kind !== "valid") return;
    const email = state.email;
    setState({ kind: "confirming" });
    try {
      const resp = await fetch(emailUnsubscribeUrl(awsApiBaseUrl(), token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = await resp.json().catch(() => ({}));
      setState(interpretUnsubscribeConfirm(resp.status, json, email));
    } catch {
      setState({ kind: "error", message: "Could not confirm unsubscribe." });
    }
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
