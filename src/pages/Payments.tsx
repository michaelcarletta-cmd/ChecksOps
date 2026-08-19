import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentLedger } from "@/components/ledger/PaymentLedger";
import { RecipientReport } from "@/components/ledger/RecipientReport";
import { TaxSummary } from "@/components/ledger/TaxSummary";
import { RevenueSummary } from "@/components/ledger/RevenueSummary";
import { PayrollTab } from "@/pages/payments/PayrollTab";

import { InvoicesTab } from "@/pages/payments/InvoicesTab";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";
import { useAuth } from "@/hooks/useAuth";
import { Receipt, FileText, Users, Wallet, Landmark, FileSpreadsheet, Sparkles, TrendingUp, ArrowUpRight, ArrowDownLeft } from "lucide-react";

export default function Payments() {
  const { userRole } = useAuth();
  const isAdmin = userRole === "admin";
  
  return (
    <div className="space-y-6">
      {/* Hero Section - WalletOps Style */}
      <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/15 via-primary/5 to-background p-4 md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-xs font-bold uppercase tracking-widest text-primary">Financial Operations</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Payments</h1>
            <p className="text-sm text-muted-foreground max-w-md">
              Track all incoming revenue and outbound payments to vendors, insureds, and partners
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="rounded-lg border border-primary/20 bg-background/40 backdrop-blur-sm p-3 min-w-[140px]">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                <TrendingUp className="h-3 w-3" /> Volume
              </div>
              <div className="mt-1 text-xl font-semibold">Active</div>
            </div>
          </div>
        </div>
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
        <TabsContent value="ledger" className="mt-6">
          <SectionCard
            title="Payment History"
            icon={<Receipt className="h-4 w-4 text-sky-500" />}
            accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
          >
            <PaymentLedger />
          </SectionCard>
        </TabsContent>
        <TabsContent value="invoices" className="mt-6">
          <SectionCard
            title="Invoices"
            icon={<FileSpreadsheet className="h-4 w-4 text-emerald-500" />}
            accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
          >
            <InvoicesTab />
          </SectionCard>
        </TabsContent>
        <TabsContent value="revenue" className="mt-6">
          <SectionCard
            title="Revenue & Profit"
            icon={<Landmark className="h-4 w-4 text-blue-500" />}
            accent="bg-gradient-to-r from-blue-500/60 to-blue-500/10"
          >
            <RevenueSummary />
          </SectionCard>
        </TabsContent>
        <TabsContent value="recipients" className="mt-6">
          <SectionCard
            title="Recipients"
            icon={<Users className="h-4 w-4 text-violet-500" />}
            accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
          >
            <RecipientReport />
          </SectionCard>
        </TabsContent>
        <TabsContent value="tax" className="mt-6">
          <SectionCard
            title="Tax & 1099"
            icon={<FileText className="h-4 w-4 text-orange-500" />}
            accent="bg-gradient-to-r from-orange-500/60 to-orange-500/10"
          >
            <TaxSummary />
          </SectionCard>
        </TabsContent>
        {isAdmin && (
          <TabsContent value="payroll" className="mt-6">
            <SectionCard
              title="Payroll"
              icon={<Wallet className="h-4 w-4 text-amber-500" />}
              accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
            >
              <PayrollTab />
            </SectionCard>
          </TabsContent>
        )}
      </Tabs>

    </div>
  );
}
