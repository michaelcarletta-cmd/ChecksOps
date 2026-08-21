import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2, ArrowLeft, Home, Calculator, LineChart, Printer } from "lucide-react";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { goToChecksOpsHome } from "@/lib/goToChecksOpsHome";
import { PnlModel } from "@/components/financial/PnlModel";
import { SavingsCalculator } from "@/components/financial/SavingsCalculator";

const ALLOWED_EMAIL = "mcarletta@freedomadj.com";

export default function AdminFinancialModel() {
  const navigate = useNavigate();
  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [presentation, setPresentation] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const email = session?.user?.email?.toLowerCase();
      setAuthorized(!!email && email === ALLOWED_EMAIL);
      setAuthChecked(true);
    })();
  }, []);

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Access Restricted</CardTitle>
            <CardDescription>
              Financial modeling is only accessible to the master merchant account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => navigate("/login")}>Back to Login</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-fluid">
      <SettingsPageShell className="max-w-[1600px]">
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Button variant="ghost" size="sm" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}>
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Button>
          <Button variant="ghost" size="sm" onClick={() => goToChecksOpsHome(navigate)}>
            <Home className="mr-1 h-4 w-4" /> Home
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/admin/tenants")}>
            Tenants
          </Button>
        </div>

        <PageHeader
          icon={<Calculator className="h-5 w-5" />}
          title="Financial Modeling"
          description="Internal P&L model and the client-facing ChecksOps vs iink savings calculator. All inputs are editable and nothing is saved to the database."
          actions={
            <>
              <div className="flex items-center gap-2 print:hidden">
                <Switch id="presentation" checked={presentation} onCheckedChange={setPresentation} />
                <Label htmlFor="presentation" className="text-xs text-muted-foreground">Presentation mode</Label>
              </div>
              <Button size="sm" variant="outline" className="print:hidden" onClick={() => window.print()}>
                <Printer className="mr-1 h-4 w-4" /> Print
              </Button>
            </>
          }
        />

        <Tabs defaultValue="pnl" className="space-y-4">
          <TabsList className="print:hidden">
            <TabsTrigger value="pnl" className="gap-1.5">
              <LineChart className="h-4 w-4" /> P&amp;L Model
            </TabsTrigger>
            <TabsTrigger value="savings" className="gap-1.5">
              <Calculator className="h-4 w-4" /> Client Savings
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pnl" className="mt-0">
            <PnlModel presentation={presentation} />
          </TabsContent>
          <TabsContent value="savings" className="mt-0">
            <SavingsCalculator presentation={presentation} />
          </TabsContent>
        </Tabs>
      </SettingsPageShell>
    </div>
  );
}
