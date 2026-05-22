import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PaymentLedger } from "@/components/ledger/PaymentLedger";
import { TaxSummary } from "@/components/ledger/TaxSummary";
import { Receipt, FileText } from "lucide-react";

export default function Payments() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Track all outbound payments to subcontractors, vendors, and sales reps
        </p>
      </div>

      <Tabs defaultValue="ledger">
        <TabsList>
          <TabsTrigger value="ledger" className="gap-2">
            <Receipt className="h-4 w-4" />
            Payment History
          </TabsTrigger>
          <TabsTrigger value="tax" className="gap-2">
            <FileText className="h-4 w-4" />
            Tax & 1099
          </TabsTrigger>
        </TabsList>
        <TabsContent value="ledger">
          <PaymentLedger />
        </TabsContent>
        <TabsContent value="tax">
          <TaxSummary />
        </TabsContent>
      </Tabs>
    </div>
  );
}
