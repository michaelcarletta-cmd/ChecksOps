import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/aws/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { PasskeyManagerCard } from "@/components/auth/PasskeyManagerCard";
import { TotpManagerCard } from "@/components/auth/TotpManagerCard";
import { FinancialTotpOnlyTestCard } from "@/components/auth/FinancialTotpOnlyTestCard";
import { useAuth } from "@/hooks/useAuth";

/** Self-service sign-in security: passkeys, two-factor, login preference. */
export default function AccountSecurity() {
  const { user } = useAuth();
  const [preferred, setPreferred] = useState<string>("magic_link");

  useEffect(() => {
    if (!user?.id) return;
    supabase
      .from("profiles")
      .select("preferred_auth_method")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.preferred_auth_method) setPreferred(data.preferred_auth_method);
      });
  }, [user?.id]);

  const setMethod = async (method: "passkey" | "magic_link") => {
    if (!user?.id) return;
    setPreferred(method);
    await supabase.from("profiles").update({ preferred_auth_method: method }).eq("id", user.id);
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link to="/"><ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back</Link>
        </Button>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShieldCheck className="h-6 w-6 text-primary" />
          Sign-in security
        </h1>
        <p className="text-sm text-muted-foreground">
          ChecksOps no longer uses passwords. Sign in with a passkey or a one-time email link, and
          confirm money movement with an authenticator code.
        </p>
      </div>

      <PasskeyManagerCard onChanged={() => void setMethod("passkey")} />
      <TotpManagerCard />
      <FinancialTotpOnlyTestCard />

      <Card>
        <CardHeader>
          <CardTitle>Preferred sign-in method</CardTitle>
          <CardDescription>
            What we offer you first at the sign-in screen. You can always use the other one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant={preferred === "passkey" ? "default" : "outline"}
            onClick={() => void setMethod("passkey")}
          >
            Passkey
          </Button>
          <Button
            variant={preferred === "magic_link" ? "default" : "outline"}
            onClick={() => void setMethod("magic_link")}
          >
            Email link
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
