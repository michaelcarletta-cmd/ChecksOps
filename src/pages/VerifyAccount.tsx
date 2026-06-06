import { useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, AlertTriangle, Lock, ShieldCheck } from "lucide-react";

export default function VerifyAccount() {
  const { token } = useParams<{ token: string }>();
  const [amount1, setAmount1] = useState("");
  const [amount2, setAmount2] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "success"; nickname?: string }
    | { kind: "error"; message: string }
    | { kind: "locked"; message: string }
  >({ kind: "idle" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setResult({ kind: "idle" });
    try {
      const { data, error } = await supabase.functions.invoke("stakeholder-verify-microdeposits", {
        body: {
          token,
          amount1: parseFloat(amount1),
          amount2: parseFloat(amount2),
        },
      });
      if (error) {
        // edge-function error payload
        const msg = (data as any)?.error ?? (error as any).message ?? "Verification failed";
        if (/locked/i.test(msg)) setResult({ kind: "locked", message: msg });
        else setResult({ kind: "error", message: msg });
        return;
      }
      if ((data as any)?.status === "verified") {
        setResult({ kind: "success", nickname: (data as any)?.nickname });
        return;
      }
      if ((data as any)?.error) {
        setResult({ kind: "error", message: (data as any).error });
        return;
      }
      setResult({ kind: "error", message: "Unexpected response" });
    } catch (err: any) {
      setResult({ kind: "error", message: err.message ?? "Verification failed" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Verify your bank account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {result.kind === "success" ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 text-center space-y-2">
              <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
              <p className="font-medium text-emerald-700">Account verified</p>
              <p className="text-sm text-muted-foreground">
                {result.nickname ? <>Your account "{result.nickname}" is now ready</> : "Your account is now ready"} to receive ACH payments. You can close this page.
              </p>
            </div>
          ) : result.kind === "locked" ? (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-center space-y-2">
              <Lock className="h-10 w-10 text-rose-600 mx-auto" />
              <p className="font-medium text-rose-700">Account locked</p>
              <p className="text-sm text-muted-foreground">{result.message}</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                We sent <strong>two small deposits</strong> (each under $0.25) to your bank account. Enter the exact amounts below to confirm you own this account.
              </p>
              <form onSubmit={submit} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="a1">First deposit amount ($)</Label>
                  <Input
                    id="a1"
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="1"
                    placeholder="0.07"
                    value={amount1}
                    onChange={(e) => setAmount1(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="a2">Second deposit amount ($)</Label>
                  <Input
                    id="a2"
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="1"
                    placeholder="0.14"
                    value={amount2}
                    onChange={(e) => setAmount2(e.target.value)}
                    required
                  />
                </div>
                {result.kind === "error" && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                    <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-amber-700">{result.message}</p>
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={submitting || !amount1 || !amount2}>
                  {submitting ? "Verifying..." : "Confirm deposits"}
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  Order doesn't matter. You have 3 attempts.
                </p>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
