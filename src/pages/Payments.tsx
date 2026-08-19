import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PaymentLedger } from "@/components/ledger/PaymentLedger";
import { RecipientReport } from "@/components/ledger/RecipientReport";
import { TaxSummary } from "@/components/ledger/TaxSummary";
import { RevenueSummary } from "@/components/ledger/RevenueSummary";
import { PayrollTab } from "@/pages/payments/PayrollTab";

import { InvoicesTab } from "@/pages/payments/InvoicesTab";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";
import { useAuth } from "@/hooks/useAuth";
import { Receipt, FileText, Users, Wallet, Settings2, Landmark, FileSpreadsheet } from "lucide-react";

export default function Payments() {
  const { userRole } = useAuth();
  const isAdmin = userRole === "admin";
  


  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Track all incoming revenue and outbound payments to vendors, insureds, and partners
        </p>
      </div>

      <Tabs defaultValue="ledger">
        <TabsList>
          <TabsTrigger value="ledger" className="gap-2">
            <Receipt className="h-4 w-4" />
            Payment History
          </TabsTrigger>
          <TabsTrigger value="invoices" className="gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            Invoices
          </TabsTrigger>
          <TabsTrigger value="revenue" className="gap-2">
            <Landmark className="h-4 w-4" />
            Revenue & Profit
          </TabsTrigger>
          <TabsTrigger value="recipients" className="gap-2">
            <Users className="h-4 w-4" />
            By Recipient
          </TabsTrigger>
          <TabsTrigger value="tax" className="gap-2">
            <FileText className="h-4 w-4" />
            Tax & 1099
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="payroll" className="gap-2">
              <Wallet className="h-4 w-4" />
              Payroll
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="ledger">
          <PaymentLedger />
        </TabsContent>
        <TabsContent value="invoices">
          <InvoicesTab />
        </TabsContent>
        <TabsContent value="revenue">
          <RevenueSummary />
        </TabsContent>
        <TabsContent value="recipients">
          <RecipientReport />
        </TabsContent>
        <TabsContent value="tax">
          <TaxSummary />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="payroll">
            <PayrollTab />
          </TabsContent>
        )}
      </Tabs>

    </div>
  );
}
