import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentLedger } from "@/components/ledger/PaymentLedger";
import { RecipientReport } from "@/components/ledger/RecipientReport";
import { TaxSummary } from "@/components/ledger/TaxSummary";
import { RevenueSummary } from "@/components/ledger/RevenueSummary";
import { PayrollTab } from "@/pages/payments/PayrollTab";
import { InvoicesTab } from "@/pages/payments/InvoicesTab";

import { useAuth } from "@/hooks/useAuth";
import { useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { 
  Receipt, 
  FileText, 
  Users, 
  Wallet, 
  Landmark, 
  FileSpreadsheet, 
  Sparkles, 
  TrendingUp, 
  Mail 
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/shell";


const SectionCard = ({ 
  title, 
  icon, 
  children, 
  className,
  accent 
}: { 
  title: string; 
  icon: React.ReactNode; 
  children: React.ReactNode;
  className?: string;
  accent?: string;
}) => (
  <Card className={cn("border-none bg-card/50 backdrop-blur-sm overflow-hidden", className)}>
    <div className={cn("h-1 w-full", accent || "bg-primary/60")} />
    <CardHeader className="pb-4">
      <CardTitle className="text-xl font-semibold flex items-center gap-2">
        {icon}
        {title}
      </CardTitle>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const Payments = () => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(searchParams.get("tab") || "ledger");

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  return (
    <PageShell width="wide" className="animate-in fade-in slide-in-from-bottom-2 duration-200">
      {/* Hero Section */}
      <div className="relative overflow-hidden rounded-3xl border border-primary/10 bg-gradient-to-br from-primary/20 via-background to-background p-6 sm:p-8">
        <div className="pointer-events-none absolute right-0 top-0 p-8 opacity-10">
          <Wallet className="h-32 w-32 rotate-12" />
        </div>
        <div className="relative z-10 min-w-0 max-w-2xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Sparkles className="h-3 w-3" />
            Financial Operations
          </div>
          <h1 className="text-fluid-2xl mb-3 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text font-bold tracking-tight text-transparent">
            Payments &amp; Financials
          </h1>
          <p className="text-fluid-base leading-relaxed text-muted-foreground">
            Manage your organization's cash flow, track transaction history, and generate financial reports for tax and compliance.
          </p>
        </div>
      </div>


      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="bg-muted/50 p-1 mb-8 overflow-x-auto w-full justify-start sm:w-auto h-auto">
          <TabsTrigger value="ledger" className="gap-2 py-2">
            <Receipt className="h-4 w-4" />
            Payment History
          </TabsTrigger>
          <TabsTrigger value="invoices" className="gap-2 py-2">
            <FileSpreadsheet className="h-4 w-4" />
            Invoices
          </TabsTrigger>
          <TabsTrigger value="revenue" className="gap-2 py-2">
            <Landmark className="h-4 w-4" />
            Revenue & Profit
          </TabsTrigger>
          <TabsTrigger value="recipients" className="gap-2 py-2">
            <Users className="h-4 w-4" />
            By Recipient
          </TabsTrigger>
          <TabsTrigger value="tax" className="gap-2 py-2">
            <FileText className="h-4 w-4" />
            Tax & 1099
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="payroll" className="gap-2 py-2">
              <Wallet className="h-4 w-4" />
              Payroll
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="ledger" className="mt-0">
          <SectionCard 
            title="Payment History" 
            icon={<Receipt className="h-4 w-4 text-primary" />}
            accent="bg-gradient-to-r from-primary/60 to-primary/10"
          >
            <PaymentLedger />
          </SectionCard>
        </TabsContent>

        <TabsContent value="invoices" className="mt-0">
          <SectionCard 
            title="Invoices" 
            icon={<FileSpreadsheet className="h-4 w-4 text-emerald-500" />}
            accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
          >
            <InvoicesTab />
          </SectionCard>
        </TabsContent>

        <TabsContent value="revenue" className="mt-0">
          <SectionCard 
            title="Revenue & Profit" 
            icon={<TrendingUp className="h-4 w-4 text-amber-500" />}
            accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
          >
            <RevenueSummary />
          </SectionCard>
        </TabsContent>

        <TabsContent value="recipients" className="mt-0">
          <SectionCard 
            title="Recipient Report" 
            icon={<Users className="h-4 w-4 text-purple-500" />}
            accent="bg-gradient-to-r from-purple-500/60 to-purple-500/10"
          >
            <RecipientReport />
          </SectionCard>
        </TabsContent>

        <TabsContent value="tax" className="mt-0">
          <SectionCard 
            title="Tax & 1099 Summary" 
            icon={<FileText className="h-4 w-4 text-rose-500" />}
            accent="bg-gradient-to-r from-rose-500/60 to-rose-500/10"
          >
            <TaxSummary />
          </SectionCard>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="payroll" className="mt-0">
            <SectionCard 
              title="Payroll History" 
              icon={<Wallet className="h-4 w-4 text-cyan-500" />}
              accent="bg-gradient-to-r from-cyan-500/60 to-cyan-500/10"
            >
              <PayrollTab />
            </SectionCard>
          </TabsContent>
        )}
      </Tabs>
    </PageShell>

  );
};

export default Payments;