import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentLedger } from "@/components/ledger/PaymentLedger";
import { RecipientReport } from "@/components/ledger/RecipientReport";
import { TaxSummary } from "@/components/ledger/TaxSummary";
import { RevenueSummary } from "@/components/ledger/RevenueSummary";
import { PayrollTab } from "@/pages/payments/PayrollTab";
import { InvoicesTab } from "@/pages/payments/InvoicesTab";

import { TenantEmailHealthPanel } from "@/components/settings/TenantEmailHealthPanel";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";
import { useAuth } from "@/hooks/useAuth";
import { 
  Receipt, 
  FileText, 
  Users, 
  Wallet, 
  Landmark, 
  FileSpreadsheet, 
  Sparkles, 
  TrendingUp, 
  ArrowUpRight, 
  ArrowDownLeft, 
  BarChart3, 
  Mail 
} from "lucide-react";
import { cn } from "@/lib/utils";

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

  return (
    <div className="container mx-auto py-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Hero Section */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary/20 via-background to-background border border-primary/10 p-8 mb-8">
        <div className="absolute top-0 right-0 p-8 opacity-10">
          <Wallet className="h-32 w-32 rotate-12" />
        </div>
        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-medium mb-4">
            <Sparkles className="h-3 w-3" />
            Financial Operations
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
            Payments & Financials
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Manage your organization's cash flow, track transaction history, and generate financial reports for tax and compliance.
          </p>
        </div>
      </div>

      <Tabs defaultValue="ledger" className="w-full">
        <TabsList className="bg-muted/50 p-1 mb-8 overflow-x-auto w-full justify-start sm:w-auto h-auto">
          <TabsTrigger value="ledger" className="gap-2 py-2">
            <Receipt className="h-4 w-4" />
            Payment History
          </TabsTrigger>
          <TabsTrigger value="invoices" className="gap-2 py-2">
            <FileSpreadsheet className="h-4 w-4" />
            Invoices
          </TabsTrigger>
          <TabsTrigger value="deliverability" className="gap-2 py-2">
            <Mail className="h-4 w-4" />
            Email Logs
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

        <TabsContent value="deliverability" className="mt-0">
          <SectionCard 
            title="Email Deliverability" 
            icon={<Mail className="h-4 w-4 text-indigo-500" />}
            accent="bg-gradient-to-r from-indigo-500/60 to-indigo-500/10"
          >
            <TenantEmailHealthPanel />
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
    </div>
  );
};

export default Payments;
