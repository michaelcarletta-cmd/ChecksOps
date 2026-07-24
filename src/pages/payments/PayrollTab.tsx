import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Send, Lock } from "lucide-react";
import { RunPayrollDialog } from "@/components/payroll/RunPayrollDialog";
import { PayrollHistoryTable } from "@/components/payroll/PayrollHistoryTable";

export function PayrollTab() {
  const { userRole } = useAuth();
  const [open, setOpen] = useState(false);

  if (userRole !== "admin") {
    return (
      <Card>
        <CardContent className="p-6 flex items-center gap-3 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" />
          Payroll is admin-only. Contact your account admin to run off-claim payments.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Payroll</h2>
          <p className="text-sm text-muted-foreground">
            Send ACH payments to assistants, sales reps, vendors, or anyone else not tied to a specific claim check. Payees come from the <strong>Stakeholders</strong> tab.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} className="gap-2">
          <Send className="h-4 w-4" /> New Payroll Payment
        </Button>
      </div>

      <PayrollHistoryTable />

      <RunPayrollDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
