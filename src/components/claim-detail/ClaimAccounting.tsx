import { useState, Fragment } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DollarSign, Plus, FileText, Receipt, Building2, TrendingUp, ExternalLink, Copy, FileOutput, Home, Warehouse, Package, Pencil, Trash2, Sofa, Upload, CheckCircle, Wallet } from "lucide-react";
import { format } from "date-fns";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ClaimPayments } from "./ClaimPayments";
import { InvoiceDialog } from "@/components/InvoiceDialog";
import { EstimateUploadDialog } from "./EstimateUploadDialog";
import { CheckProcessingCard } from "@/components/claims/CheckProcessingCard";
import { CrudDropdown } from "./CrudDropdown";
import { PaymentMethodForm } from "./PaymentMethodForm";
interface ClaimAccountingProps {
  claim: any;
  userRole: string | null;
}

export function ClaimAccounting({ claim, userRole }: ClaimAccountingProps) {
  const isAdmin = userRole === 'admin';
  const isPortalUser = userRole === 'client' || userRole === 'contractor';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [estimateUploadOpen, setEstimateUploadOpen] = useState(false);

  // Fetch settlement data
  const { data: settlement } = useQuery({
    queryKey: ["claim-settlement", claim.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_settlements")
        .select("*")
        .eq("claim_id", claim.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Fetch checks
  const { data: checks } = useQuery({
    queryKey: ["claim-checks", claim.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_checks")
        .select("*")
        .eq("claim_id", claim.id)
        .order("check_date", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch expenses
  const { data: expenses } = useQuery({
    queryKey: ["claim-expenses", claim.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_expenses")
        .select("*")
        .eq("claim_id", claim.id)
        .order("expense_date", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch fees
  const { data: fees } = useQuery({
    queryKey: ["claim-fees", claim.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_fees")
        .select("*")
        .eq("claim_id", claim.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Calculate totals
  const totalChecksReceived = checks?.reduce((sum, check) => sum + Number(check.amount), 0) || 0;
  const totalExpenses = expenses?.reduce((sum, exp) => sum + Number(exp.amount), 0) || 0;
  const settlementAmount = settlement?.total_settlement || 0;
  
  // Calculate expected checks: Total RCV minus Total Deductible
  const totalRCV = (Number(settlement?.replacement_cost_value) || 0) + 
                   (Number(settlement?.other_structures_rcv) || 0) + 
                   (Number(settlement?.pwi_rcv) || 0);
  const totalDeductible = (Number(settlement?.deductible) || 0) + 
                          (Number(settlement?.other_structures_deductible) || 0) + 
                          (Number(settlement?.pwi_deductible) || 0);
  const expectedChecks = totalRCV - totalDeductible;
  
  const grossProfit = totalChecksReceived - totalExpenses;
  const companyFee = fees?.company_fee_amount || 0;
  const adjusterFee = fees?.adjuster_fee_amount || 0;
  // Net profit = Company fee - Adjuster fee - Expenses
  const netProfit = companyFee - adjusterFee - totalExpenses;

  return (
    <div className="space-y-6">
      {/* Action Buttons */}
      <div className="flex justify-end gap-2">
        <Button onClick={() => setEstimateUploadOpen(true)} variant="outline">
          <Upload className="h-4 w-4 mr-2" />
          Upload Estimate
        </Button>
        <Button onClick={() => setInvoiceOpen(true)} variant="outline">
          <FileOutput className="h-4 w-4 mr-2" />
          Create Invoice
        </Button>
      </div>

      {/* Financial Overview Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Settlement Amount
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">${settlementAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Checks Received
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-primary">${totalChecksReceived.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              Total Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-destructive">${totalExpenses.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Net Profit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">${netProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </CardContent>
        </Card>
      </div>

      {/* Settlement Details */}
      <SettlementSection claimId={claim.id} settlement={settlement} isAdmin={isAdmin} />

      {/* Insurance Checks */}
      <ChecksSection claimId={claim.id} checks={checks || []} isAdmin={isAdmin} claim={claim} expectedChecks={expectedChecks} />

      {/* Mortgage Releases is now integrated into ChecksSection */}

      {/* Expenses */}
      <ExpensesSection claimId={claim.id} expenses={expenses || []} isAdmin={isAdmin} />

      {/* Fees & Profit Breakdown */}
      <FeesSection 
        claimId={claim.id} 
        fees={fees} 
        grossProfit={grossProfit}
        totalChecksReceived={totalChecksReceived}
        checks={checks || []}
        priorOffer={settlement?.prior_offer || 0}
        isAdmin={isAdmin}
      />

      {/* Payments Released - hidden for portal users */}
      {!isPortalUser && <ClaimPayments claimId={claim.id} isAdmin={isAdmin} />}

      {/* Invoice Dialog */}
      <InvoiceDialog
        open={invoiceOpen}
        onOpenChange={setInvoiceOpen}
        claimId={claim.id}
        claimNumber={claim.claim_number}
        defaultRecipient={{
          name: claim.policyholder_name || "",
          email: claim.policyholder_email || "",
          address: claim.policyholder_address || "",
        }}
      />

      {/* Estimate Upload Dialog */}
      <EstimateUploadDialog
        open={estimateUploadOpen}
        onOpenChange={setEstimateUploadOpen}
        claimId={claim.id}
      />
    </div>
  );
}

// Settlement Section Component with Tabs
function SettlementSection({ claimId, settlement, isAdmin }: any) {
  const [activeTab, setActiveTab] = useState("dwelling");
  const [open, setOpen] = useState(false);
  const [editingType, setEditingType] = useState<"dwelling" | "other_structures" | "pwi" | "personal_property">("dwelling");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Form data for each tab type
  const getFormDataForType = (type: string) => {
    if (type === "dwelling") {
      return {
        replacement_cost_value: settlement?.replacement_cost_value || 0,
        non_recoverable_depreciation: settlement?.non_recoverable_depreciation || 0,
        recoverable_depreciation: settlement?.recoverable_depreciation || 0,
        deductible: settlement?.deductible || 0,
        estimate_amount: settlement?.estimate_amount || 0,
        pa_estimate_amount: settlement?.pa_estimate_amount || 0,
        prior_offer: settlement?.prior_offer || 0,
        notes: settlement?.notes || "",
      };
    } else if (type === "other_structures") {
      return {
        replacement_cost_value: settlement?.other_structures_rcv || 0,
        non_recoverable_depreciation: settlement?.other_structures_non_recoverable_depreciation || 0,
        recoverable_depreciation: settlement?.other_structures_recoverable_depreciation || 0,
        deductible: settlement?.other_structures_deductible || 0,
      };
    } else if (type === "pwi") {
      return {
        replacement_cost_value: settlement?.pwi_rcv || 0,
        non_recoverable_depreciation: settlement?.pwi_non_recoverable_depreciation || 0,
        recoverable_depreciation: settlement?.pwi_recoverable_depreciation || 0,
        deductible: 0, // Paid When Incurred has no deductible
      };
    } else {
      // personal_property
      return {
        replacement_cost_value: settlement?.personal_property_rcv || 0,
        non_recoverable_depreciation: settlement?.personal_property_non_recoverable_depreciation || 0,
        recoverable_depreciation: settlement?.personal_property_recoverable_depreciation || 0,
        deductible: 0, // Personal property has no deductible
      };
    }
  };

  const [formData, setFormData] = useState(getFormDataForType("dwelling"));

  // Calculate totals for each type
  const dwellingRcv = Number(settlement?.replacement_cost_value || 0);
  const otherStructuresRcv = Number(settlement?.other_structures_rcv || 0);
  const pwiRcv = Number(settlement?.pwi_rcv || 0);
  const personalPropertyRcv = Number(settlement?.personal_property_rcv || 0);
  const totalRcv = dwellingRcv + otherStructuresRcv + pwiRcv + personalPropertyRcv;

  const calculateAcv = (rcv: number, recDep: number, nonRecDep: number, deductible: number) => {
    return rcv - recDep - nonRecDep - deductible;
  };

  const dwellingAcv = calculateAcv(
    dwellingRcv,
    Number(settlement?.recoverable_depreciation || 0),
    Number(settlement?.non_recoverable_depreciation || 0),
    Number(settlement?.deductible || 0)
  );

  const otherStructuresAcv = calculateAcv(
    otherStructuresRcv,
    Number(settlement?.other_structures_recoverable_depreciation || 0),
    Number(settlement?.other_structures_non_recoverable_depreciation || 0),
    Number(settlement?.other_structures_deductible || 0)
  );

  const pwiAcv = calculateAcv(
    pwiRcv,
    Number(settlement?.pwi_recoverable_depreciation || 0),
    Number(settlement?.pwi_non_recoverable_depreciation || 0),
    0  // Paid When Incurred has no deductible
  );

  const personalPropertyAcv = calculateAcv(
    personalPropertyRcv,
    Number(settlement?.personal_property_recoverable_depreciation || 0),
    Number(settlement?.personal_property_non_recoverable_depreciation || 0),
    0  // Personal property has no deductible
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      
      let updateData: any = {};
      
      if (editingType === "dwelling") {
        updateData = {
          replacement_cost_value: formData.replacement_cost_value,
          non_recoverable_depreciation: formData.non_recoverable_depreciation,
          recoverable_depreciation: formData.recoverable_depreciation,
          deductible: formData.deductible,
          estimate_amount: (formData as any).estimate_amount || 0,
          pa_estimate_amount: (formData as any).pa_estimate_amount || 0,
          prior_offer: (formData as any).prior_offer || 0,
          notes: (formData as any).notes || "",
        };
      } else if (editingType === "other_structures") {
        updateData = {
          other_structures_rcv: formData.replacement_cost_value,
          other_structures_non_recoverable_depreciation: formData.non_recoverable_depreciation,
          other_structures_recoverable_depreciation: formData.recoverable_depreciation,
          other_structures_deductible: formData.deductible,
        };
      } else if (editingType === "pwi") {
        updateData = {
          pwi_rcv: formData.replacement_cost_value,
          pwi_non_recoverable_depreciation: formData.non_recoverable_depreciation,
          pwi_recoverable_depreciation: formData.recoverable_depreciation,
        };
      } else {
        // personal_property
        updateData = {
          personal_property_rcv: formData.replacement_cost_value,
          personal_property_non_recoverable_depreciation: formData.non_recoverable_depreciation,
          personal_property_recoverable_depreciation: formData.recoverable_depreciation,
        };
      }

      if (settlement) {
        const { error } = await supabase
          .from("claim_settlements")
          .update(updateData)
          .eq("id", settlement.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("claim_settlements")
          .insert({
            ...updateData,
            claim_id: claimId,
            created_by: user?.id,
          });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-settlement", claimId] });
      setOpen(false);
      toast({ title: "Settlement saved successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save settlement", variant: "destructive" });
    },
  });

  const actualCashValue = 
    Number(formData.replacement_cost_value) - 
    Number(formData.recoverable_depreciation) -
    Number(formData.non_recoverable_depreciation) - 
    Number(formData.deductible);

  const openEditDialog = (type: "dwelling" | "other_structures" | "pwi" | "personal_property") => {
    setEditingType(type);
    setFormData(getFormDataForType(type));
    setOpen(true);
  };

  const getTypeLabel = (type: string) => {
    if (type === "dwelling") return "Dwelling";
    if (type === "other_structures") return "Other Structures";
    if (type === "pwi") return "Paid When Incurred";
    return "Personal Property";
  };

  const renderSettlementContent = (
    rcv: number,
    recDep: number,
    nonRecDep: number,
    deductible: number,
    acv: number,
    type: "dwelling" | "other_structures" | "pwi" | "personal_property",
    estimateAmount?: number,
    priorOffer?: number,
    notes?: string
  ) => {
    const hasData = rcv > 0 || recDep > 0 || nonRecDep > 0 || deductible > 0;

    if (!hasData && !settlement) {
      return <p className="text-muted-foreground text-center py-8">No {getTypeLabel(type).toLowerCase()} settlement details added yet</p>;
    }

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Replacement Cost Value (RCV)</p>
            <p className="text-lg font-semibold">${rcv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
          </div>
          {type === "dwelling" && estimateAmount !== undefined && (
            <div>
              <p className="text-sm text-muted-foreground">Carrier Estimate</p>
              <p className="text-lg font-semibold">${estimateAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
          )}
          {type === "dwelling" && (settlement as any)?.pa_estimate_amount > 0 && (
            <div>
              <p className="text-sm text-muted-foreground">PA/Freedom Estimate</p>
              <p className="text-lg font-semibold text-primary">${Number((settlement as any)?.pa_estimate_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
          )}
          {type === "dwelling" && priorOffer !== undefined && priorOffer > 0 && (
            <div>
              <p className="text-sm text-muted-foreground">Prior Offer (No Fees)</p>
              <p className="text-lg font-semibold text-warning">${priorOffer.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
          )}
        </div>
        
        {type === "dwelling" && (
          <div className="mt-4 border-t pt-4">
            <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              Funds Tracking & Actum Controls
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {checks?.map((check: any) => (
                <CheckProcessingCard key={check.id} claimId={claimId} checkId={check.id} isAdmin={isAdmin} />
              ))}
              {checks?.length === 0 && (
                <p className="text-xs text-muted-foreground italic col-span-2">No checks recorded for this claim to display Actum controls.</p>
              )}
            </div>
          </div>
        )}

        
        <div className="p-4 bg-muted/50 rounded-lg space-y-2">
          <div className="flex justify-between text-sm">
            <span>Replacement Cost Value (RCV):</span>
            <span className="font-semibold">${rcv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex justify-between text-sm text-amber-600 dark:text-amber-400">
            <span>- Recoverable Depreciation:</span>
            <span className="font-semibold">-${recDep.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex justify-between text-sm text-rose-600 dark:text-rose-400">
            <span>- Non-Recoverable Depreciation:</span>
            <span className="font-semibold">-${nonRecDep.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>- Deductible:</span>
            <span className="font-semibold">-${deductible.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="border-t border-border pt-2 flex justify-between">
            <span className="font-medium">Actual Cash Value (ACV):</span>
            <span className="text-xl font-bold text-primary">
              ${acv.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
        </div>


        {type === "dwelling" && notes && (
          <div>
            <p className="text-sm text-muted-foreground">Notes</p>
            <p className="text-sm">{notes}</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Settlement Details
          </CardTitle>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Total RCV</p>
              <p className="text-xl font-bold text-primary">${totalRcv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="inline-flex flex-row h-10 items-center justify-start rounded-md bg-muted p-1 text-muted-foreground mb-4 w-auto">
            <TabsTrigger value="dwelling" className="inline-flex items-center gap-2 whitespace-nowrap">
              <Home className="h-4 w-4" />
              Dwelling
            </TabsTrigger>
            <TabsTrigger value="other_structures" className="inline-flex items-center gap-2 whitespace-nowrap">
              <Warehouse className="h-4 w-4" />
              Other Structures
            </TabsTrigger>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <TabsTrigger value="pwi" className="inline-flex items-center gap-2 whitespace-nowrap">
                    <Package className="h-4 w-4" />
                    Paid When Incurred
                  </TabsTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>PWI — costs released upon job completion (Ordinance & Law)</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TabsTrigger value="personal_property" className="inline-flex items-center gap-2 whitespace-nowrap">
              <Sofa className="h-4 w-4" />
              Personal Property
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dwelling">
            {isAdmin && (
              <div className="flex justify-end mb-4">
                <Button onClick={() => openEditDialog("dwelling")}>
                  <Plus className="h-4 w-4 mr-2" />
                  {settlement?.replacement_cost_value ? "Edit" : "Add"} Dwelling
                </Button>
              </div>
            )}
            {renderSettlementContent(
              dwellingRcv,
              Number(settlement?.recoverable_depreciation || 0),
              Number(settlement?.non_recoverable_depreciation || 0),
              Number(settlement?.deductible || 0),
              dwellingAcv,
              "dwelling",
              Number(settlement?.estimate_amount || 0),
              Number(settlement?.prior_offer || 0),
              settlement?.notes
            )}
          </TabsContent>

          <TabsContent value="other_structures">
            {isAdmin && (
              <div className="flex justify-end mb-4">
                <Button onClick={() => openEditDialog("other_structures")}>
                  <Plus className="h-4 w-4 mr-2" />
                  {settlement?.other_structures_rcv ? "Edit" : "Add"} Other Structures
                </Button>
              </div>
            )}
            {renderSettlementContent(
              otherStructuresRcv,
              Number(settlement?.other_structures_recoverable_depreciation || 0),
              Number(settlement?.other_structures_non_recoverable_depreciation || 0),
              Number(settlement?.other_structures_deductible || 0),
              otherStructuresAcv,
              "other_structures"
            )}
          </TabsContent>

          <TabsContent value="pwi">
            {isAdmin && (
              <div className="flex justify-end mb-4">
                <Button onClick={() => openEditDialog("pwi")}>
                  <Plus className="h-4 w-4 mr-2" />
                  {settlement?.pwi_rcv ? "Edit" : "Add"} Paid When Incurred
                </Button>
              </div>
            )}
            {renderSettlementContent(
              pwiRcv,
              Number(settlement?.pwi_recoverable_depreciation || 0),
              Number(settlement?.pwi_non_recoverable_depreciation || 0),
              0,
              pwiAcv,
              "pwi"
            )}
          </TabsContent>

          <TabsContent value="personal_property">
            {isAdmin && (
              <div className="flex justify-end mb-4">
                <Button onClick={() => openEditDialog("personal_property")}>
                  <Plus className="h-4 w-4 mr-2" />
                  {settlement?.personal_property_rcv ? "Edit" : "Add"} Personal Property
                </Button>
              </div>
            )}
            {renderSettlementContent(
              personalPropertyRcv,
              Number(settlement?.personal_property_recoverable_depreciation || 0),
              Number(settlement?.personal_property_non_recoverable_depreciation || 0),
              0,
              personalPropertyAcv,
              "personal_property"
            )}
          </TabsContent>
        </Tabs>

        {/* Combined Recoverable Depreciation */}
        {(() => {
          const totalRecDep = Number(settlement?.recoverable_depreciation || 0) + 
                              Number(settlement?.other_structures_recoverable_depreciation || 0) + 
                              Number(settlement?.pwi_recoverable_depreciation || 0) +
                              Number(settlement?.personal_property_recoverable_depreciation || 0);
          return totalRecDep > 0 ? (
            <div className="mt-4 p-4 bg-amber-500/10 rounded-lg border border-amber-500/20">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium text-amber-600 dark:text-amber-400">Total Recoverable Depreciation</p>
                  <p className="text-xs text-muted-foreground">Paid when work is completed</p>
                </div>
                <p className="text-xl font-bold text-amber-600 dark:text-amber-400">
                  ${totalRecDep.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
            </div>
          ) : null;
        })()}

        {/* Edit Dialog */}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{settlement ? "Edit" : "Add"} {getTypeLabel(editingType)} Settlement</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Replacement Cost Value (RCV)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.replacement_cost_value}
                    onChange={(e) => setFormData({ ...formData, replacement_cost_value: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                {editingType === "dwelling" && (
                  <>
                    <div>
                      <Label>Carrier Estimate</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={(formData as any).estimate_amount || 0}
                        onChange={(e) => setFormData({ ...formData, estimate_amount: parseFloat(e.target.value) || 0 } as any)}
                      />
                      <p className="text-xs text-muted-foreground mt-1">What the carrier offered/estimated</p>
                    </div>
                    <div>
                      <Label>PA/Freedom Estimate</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={(formData as any).pa_estimate_amount || 0}
                        onChange={(e) => setFormData({ ...formData, pa_estimate_amount: parseFloat(e.target.value) || 0 } as any)}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Your estimate/demand amount — used by Darwin for strategic analysis</p>
                    </div>
                    <div className="col-span-2">
                      <Label>Prior Offer (Before Involvement - No Fees Collected)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={(formData as any).prior_offer || 0}
                        onChange={(e) => setFormData({ ...formData, prior_offer: parseFloat(e.target.value) || 0 } as any)}
                        placeholder="Settlement amount offered before your involvement"
                      />
                      <p className="text-xs text-muted-foreground mt-1">Fees will only be calculated on amounts above this prior offer</p>
                    </div>
                  </>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Non-Recoverable Depreciation</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.non_recoverable_depreciation}
                    onChange={(e) => setFormData({ ...formData, non_recoverable_depreciation: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div>
                  <Label>Recoverable Depreciation</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.recoverable_depreciation}
                    onChange={(e) => setFormData({ ...formData, recoverable_depreciation: parseFloat(e.target.value) || 0 })}
                  />
                </div>
              </div>
              {(editingType === "dwelling" || editingType === "other_structures") && (
                <div>
                  <Label>Deductible</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.deductible}
                    onChange={(e) => setFormData({ ...formData, deductible: parseFloat(e.target.value) || 0 })}
                  />
                </div>
              )}
              {editingType === "dwelling" && (
                <div>
                  <Label>Notes</Label>
                  <Textarea
                    value={(formData as any).notes || ""}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value } as any)}
                    rows={3}
                  />
                </div>
              )}
              <div className="space-y-3 p-4 bg-muted rounded-lg">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Replacement Cost Value (RCV):</span>
                    <span className="font-semibold">${Number(formData.replacement_cost_value).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-amber-600 dark:text-amber-400">
                    <span>- Recoverable Depreciation:</span>
                    <span className="font-semibold">-${Number(formData.recoverable_depreciation).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-rose-600 dark:text-rose-400">
                    <span>- Non-Recoverable Depreciation:</span>
                    <span className="font-semibold">-${Number(formData.non_recoverable_depreciation).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>- Deductible:</span>
                    <span className="font-semibold">-${Number(formData.deductible).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="border-t pt-2 flex justify-between">
                    <span className="font-medium">Actual Cash Value (ACV):</span>
                    <span className="text-lg font-bold text-primary">
                      ${actualCashValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
                <div className="border-t pt-3 mt-3">
                  <div className="flex justify-between text-amber-600 dark:text-amber-400">
                    <span className="font-medium">Recoverable Depreciation (paid at completion):</span>
                    <span className="text-lg font-bold">
                      ${Number(formData.recoverable_depreciation).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="w-full">
                Save {getTypeLabel(editingType)} Settlement
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// Checks Section Component  
function ChecksSection({ claimId, checks, isAdmin, claim, expectedChecks }: any) {
  const totalChecksReceived = checks?.reduce((sum: number, check: any) => sum + Number(check.amount), 0) || 0;
  const outstandingAmount = expectedChecks - totalChecksReceived;
  const [open, setOpen] = useState(false);
  const [expandedCheckId, setExpandedCheckId] = useState<string | null>(null);
  const [editingCheck, setEditingCheck] = useState<any>(null);
  const [formData, setFormData] = useState({
    check_number: "",
    check_date: "",
    amount: 0,
    check_type: "initial",
    mortgage_flag: false,
    received_date: "",
    notes: "",
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const resetForm = () => {
    setFormData({
      check_number: "",
      check_date: "",
      amount: 0,
      check_type: "initial",
      mortgage_flag: false,
      received_date: "",
      notes: "",
    });
    setEditingCheck(null);
  };

  // Helper function to recalculate and update fees based on new check totals
  const recalculateFees = async (newTotalChecks: number) => {
    // Fetch current fees and settlement for prior offer
    const [feesResult, settlementResult] = await Promise.all([
      supabase.from("claim_fees").select("*").eq("claim_id", claimId).maybeSingle(),
      supabase.from("claim_settlements").select("prior_offer").eq("claim_id", claimId).maybeSingle()
    ]);

    const fees = feesResult.data;
    const priorOffer = Number(settlementResult.data?.prior_offer || 0);

    if (fees && (fees.company_fee_percentage > 0 || fees.adjuster_fee_percentage > 0 || fees.contractor_fee_percentage > 0)) {
      const feeableAmount = Math.max(0, newTotalChecks - priorOffer);
      
      // Recalculate company fee
      const companyFeeAmount = Math.round(feeableAmount * (fees.company_fee_percentage / 100) * 100) / 100;
      
      // Recalculate adjuster fee (percentage of company fee)
      const adjusterFeeAmount = Math.round(companyFeeAmount * (fees.adjuster_fee_percentage / 100) * 100) / 100;
      
      // Recalculate contractor fee
      const contractorFeeAmount = Math.round(feeableAmount * (fees.contractor_fee_percentage / 100) * 100) / 100;

      // Update fees in database
      await supabase
        .from("claim_fees")
        .update({
          company_fee_amount: companyFeeAmount,
          adjuster_fee_amount: adjusterFeeAmount,
          contractor_fee_amount: contractorFeeAmount,
        })
        .eq("id", fees.id);
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      
      if (editingCheck) {
        // Update existing check
        const { error } = await supabase
          .from("claim_checks")
          .update({
            check_number: formData.check_number,
            check_date: formData.check_date,
            amount: formData.amount,
            check_type: formData.check_type,
            mortgage_flag: formData.mortgage_flag,
            received_date: formData.received_date || null,
            notes: formData.notes,
          })
          .eq("id", editingCheck.id);
        if (error) throw error;
        
        // Calculate new total with the updated amount
        const newTotal = checks.reduce((sum: number, check: any) => {
          if (check.id === editingCheck.id) {
            return sum + formData.amount;
          }
          return sum + Number(check.amount);
        }, 0);
        await recalculateFees(newTotal);
      } else {
        // Insert new check
        const { error } = await supabase
          .from("claim_checks")
          .insert({
            ...formData,
            mortgage_flag: formData.mortgage_flag,
            claim_id: claimId,
            created_by: user?.id,
          });
        if (error) throw error;
        
        // Calculate new total including the new check
        const newTotal = totalChecksReceived + formData.amount;
        await recalculateFees(newTotal);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-checks", claimId] });
      queryClient.invalidateQueries({ queryKey: ["claim-fees", claimId] });
      setOpen(false);
      resetForm();
      toast({ title: editingCheck ? "Check updated successfully" : "Check added successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: editingCheck ? "Failed to update check" : "Failed to add check", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (checkId: string) => {
      // Find the check being deleted to calculate new total
      const checkToDelete = checks.find((c: any) => c.id === checkId);
      const deletedAmount = checkToDelete ? Number(checkToDelete.amount) : 0;
      
      const { error } = await supabase
        .from("claim_checks")
        .delete()
        .eq("id", checkId);
      if (error) throw error;
      
      // Recalculate fees with the check removed
      const newTotal = totalChecksReceived - deletedAmount;
      await recalculateFees(newTotal);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-checks", claimId] });
      queryClient.invalidateQueries({ queryKey: ["claim-fees", claimId] });
      toast({ title: "Check deleted successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete check", variant: "destructive" });
    },
  });

  const handleEdit = (check: any) => {
    setEditingCheck(check);
    setFormData({
      check_number: check.check_number || "",
      check_date: check.check_date || "",
      amount: Number(check.amount) || 0,
      check_type: check.check_type || "initial",
      mortgage_flag: Boolean(check.mortgage_flag),
      received_date: check.received_date || "",
      notes: check.notes || "",
    });
    setOpen(true);
  };

  const handleOpenDialog = () => {
    resetForm();
    setOpen(true);
  };

  const handleOpenIink = () => {
    window.open('https://iink.com', '_blank', 'noopener,noreferrer');
  };

  const handleCopyClaimDetails = () => {
    const details = [
      claim?.policyholder_name && `Name: ${claim.policyholder_name}`,
      claim?.policyholder_address && `Address: ${claim.policyholder_address}`,
      claim?.claim_number && `Claim #: ${claim.claim_number}`,
      claim?.policy_number && `Policy #: ${claim.policy_number}`,
      claim?.insurance_company && `Insurance: ${claim.insurance_company}`,
    ].filter(Boolean).join('\n');
    
    navigator.clipboard.writeText(details);
    toast({ title: "Copied to clipboard", description: "Claim details ready to paste into iink" });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <div>
            <CardTitle>Insurance Checks Received</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Outstanding: <span className={outstandingAmount > 0 ? "text-amber-500 font-semibold" : "text-primary font-semibold"}>
                ${outstandingAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleCopyClaimDetails}>
              <Copy className="h-4 w-4 mr-2" />
              Copy Details
            </Button>
            <Button variant="outline" size="sm" onClick={handleOpenIink}>
              <ExternalLink className="h-4 w-4 mr-2" />
              Open iink
            </Button>
          {isAdmin && (
            <Dialog open={open} onOpenChange={(isOpen) => { setOpen(isOpen); if (!isOpen) resetForm(); }}>
              <DialogTrigger asChild>
                <Button onClick={handleOpenDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Add Check
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingCheck ? "Edit Check" : "Add Insurance Check"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Check Number</Label>
                    <Input
                      value={formData.check_number}
                      onChange={(e) => setFormData({ ...formData, check_number: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Check Type</Label>
                    <Select value={formData.check_type} onValueChange={(value) => setFormData({ ...formData, check_type: value })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="initial">Initial Payment</SelectItem>
                        <SelectItem value="recoverable_depreciation">Recoverable Depreciation</SelectItem>
                        <SelectItem value="supplemental">Supplemental Payment</SelectItem>
                        <SelectItem value="contents">Contents</SelectItem>
                        <SelectItem value="ale">ALE (Additional Living Expenses)</SelectItem>
                        <SelectItem value="other_structures">Other Structures</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Check Date</Label>
                    <Input
                      type="date"
                      value={formData.check_date}
                      onChange={(e) => setFormData({ ...formData, check_date: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Received Date</Label>
                    <Input
                      type="date"
                      value={formData.received_date}
                      onChange={(e) => setFormData({ ...formData, received_date: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label>Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div>
                  <Label>Notes</Label>
                  <Textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={2}
                  />
                </div>
                <div>
                  <Label>Mortgage Hold</Label>
                  <Select
                    value={formData.mortgage_flag ? "yes" : "no"}
                    onValueChange={(value) => setFormData({ ...formData, mortgage_flag: value === "yes" })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="no">No (Funds depositable)</SelectItem>
                      <SelectItem value="yes">Yes (Held by mortgage company)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="w-full">
                  {editingCheck ? "Update Check" : "Add Check"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {checks.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Check #</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Check Date</TableHead>
                <TableHead>Received</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                {isAdmin && <TableHead className="w-[80px]"></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {checks.map((check: any) => (
                <Fragment key={check.id}>
                <TableRow 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setExpandedCheckId(expandedCheckId === check.id ? null : check.id)}
                >
                  <TableCell className="font-medium">{check.check_number || "—"}</TableCell>
                  <TableCell className="capitalize">{check.check_type.replace("_", " ")}</TableCell>
                  <TableCell>{format(new Date(check.check_date), "MMM dd, yyyy")}</TableCell>
                  <TableCell>{check.received_date ? format(new Date(check.received_date), "MMM dd, yyyy") : "—"}</TableCell>
                  <TableCell className="text-right font-semibold text-primary">
                    ${Number(check.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell>
                    {check.source === "uploaded_check_ocr" ? (
                      <Badge variant="outline" className="text-[10px] px-1.5">
                        <CheckCircle className="h-3 w-3 mr-1 text-emerald-400" />OCR
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">Manual</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {check.deposit_status ? (
                      <Badge variant="outline" className="text-[10px] px-1.5 capitalize">
                        {check.deposit_status.replace(/_/g, " ")}
                      </Badge>
                    ) : "—"}
                    {check.mortgage_flag && (
                      <Badge className="ml-1 bg-blue-500/20 text-blue-400 text-[9px] px-1 whitespace-nowrap">
                        {check.deposit_status !== 'ready' && check.deposit_status !== 'approved' && check.deposit_status !== 'deposited' ? 'LOSS DRAFT BLOCKED' : 'MTG'}
                      </Badge>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(check)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => deleteMutation.mutate(check.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
                {expandedCheckId === check.id && (
                  <TableRow>
                    <TableCell colSpan={isAdmin ? 8 : 7} className="p-0 border-0">
                      <div className="p-3 bg-muted/30">
                        <CheckProcessingCard claimId={claimId} checkId={check.id} isAdmin={isAdmin} />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-center py-8">No checks recorded yet</p>
        )}

        {/* Mortgage Disbursements - inline */}
        <MortgageReleasesInline claimId={claimId} checks={checks} isAdmin={isAdmin} />
      </CardContent>
    </Card>
  );
}

// Mortgage Releases Inline (inside ChecksSection card)
function MortgageReleasesInline({ claimId, checks, isAdmin }: { claimId: string; checks: any[]; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [editingRelease, setEditingRelease] = useState<any>(null);
  const [formData, setFormData] = useState({
    check_id: "",
    amount: 0,
    release_date: "",
    release_method: "check",
    mortgage_company_name: "",
    reference_number: "",
    notes: "",
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: releases } = useQuery({
    queryKey: ["mortgage-releases", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mortgage_releases")
        .select("*")
        .eq("claim_id", claimId)
        .order("release_date", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const mortgageChecks = checks.filter((c: any) => c.mortgage_flag);
  const totalHeld = mortgageChecks.reduce((sum: number, c: any) => sum + Number(c.amount), 0);
  const totalReleased = releases?.reduce((sum: number, r: any) => sum + Number(r.amount), 0) || 0;
  const stillHeld = Math.max(0, totalHeld - totalReleased);

  const resetForm = () => {
    setFormData({ check_id: "", amount: 0, release_date: "", release_method: "check", mortgage_company_name: "", reference_number: "", notes: "" });
    setEditingRelease(null);
  };

  const handleEdit = (release: any) => {
    setEditingRelease(release);
    setFormData({
      check_id: release.check_id || "",
      amount: Number(release.amount) || 0,
      release_date: release.release_date || "",
      release_method: release.release_method || "check",
      mortgage_company_name: release.mortgage_company_name || "",
      reference_number: release.reference_number || "",
      notes: release.notes || "",
    });
    setOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        claim_id: claimId,
        check_id: formData.check_id || null,
        amount: formData.amount,
        release_date: formData.release_date,
        release_method: formData.release_method,
        mortgage_company_name: formData.mortgage_company_name || null,
        reference_number: formData.reference_number || null,
        notes: formData.notes || null,
      };
      if (editingRelease) {
        const { error } = await supabase.from("mortgage_releases").update(payload).eq("id", editingRelease.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("mortgage_releases").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mortgage-releases", claimId] });
      toast({ title: editingRelease ? "Release updated" : "Release recorded" });
      setOpen(false);
      resetForm();
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("mortgage_releases").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mortgage-releases", claimId] });
      toast({ title: "Release deleted" });
    },
  });

  return (
    <div className="mt-6 border-t pt-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Mortgage Disbursements
          </h4>
          <div className="flex gap-4 text-xs text-muted-foreground mt-1">
            <span>Held: <span className="font-semibold text-foreground">${totalHeld.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></span>
            <span>Released: <span className="font-semibold text-emerald-500">${totalReleased.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></span>
            {stillHeld > 0 && <span>Remaining: <span className="font-semibold text-amber-500">${stillHeld.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></span>}
          </div>
        </div>
        {isAdmin && (
          <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline"><Plus className="h-4 w-4 mr-1" /> Record Release</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingRelease ? "Edit Release" : "Record Mortgage Release"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Amount Released</Label>
                    <Input type="number" step="0.01" value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) })} />
                  </div>
                  <div>
                    <Label>Release Date</Label>
                    <Input type="date" value={formData.release_date} onChange={(e) => setFormData({ ...formData, release_date: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Mortgage Company</Label>
                    <Input value={formData.mortgage_company_name} onChange={(e) => setFormData({ ...formData, mortgage_company_name: e.target.value })} />
                  </div>
                  <div>
                    <Label>Release Method</Label>
                    <Select value={formData.release_method} onValueChange={(v) => setFormData({ ...formData, release_method: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="check">Check</SelectItem>
                        <SelectItem value="wire">Wire Transfer</SelectItem>
                        <SelectItem value="ach">ACH</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {mortgageChecks.length > 0 && (
                  <div>
                    <Label>Associated Check (optional)</Label>
                    <Select value={formData.check_id} onValueChange={(v) => setFormData({ ...formData, check_id: v })}>
                      <SelectTrigger><SelectValue placeholder="Select check..." /></SelectTrigger>
                      <SelectContent>
                        {mortgageChecks.map((c: any) => (
                          <SelectItem key={c.id} value={c.id}>
                            #{c.check_number || "N/A"} — ${Number(c.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div>
                  <Label>Reference #</Label>
                  <Input value={formData.reference_number} onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })} />
                </div>
                <div>
                  <Label>Notes</Label>
                  <Textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
                </div>
                <Button onClick={() => saveMutation.mutate()} disabled={!formData.amount || !formData.release_date} className="w-full">
                  {editingRelease ? "Update Release" : "Record Release"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {mortgageChecks.length === 0 && (!releases || releases.length === 0) && (
        <p className="text-xs text-muted-foreground">No checks are mortgage-held. Set <span className="font-medium text-foreground">Mortgage Hold</span> on a check to track releases.</p>
      )}

      {releases && releases.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Mortgage Co.</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Ref #</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              {isAdmin && <TableHead className="w-[80px]"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {releases.map((r: any) => (
              <TableRow key={r.id}>
                <TableCell>{format(new Date(r.release_date), "MMM dd, yyyy")}</TableCell>
                <TableCell>{r.mortgage_company_name || "—"}</TableCell>
                <TableCell className="capitalize">{r.release_method}</TableCell>
                <TableCell>{r.reference_number || "—"}</TableCell>
                <TableCell className="text-right font-semibold text-primary">
                  ${Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </TableCell>
                {isAdmin && (
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(r)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => deleteMutation.mutate(r.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// Mortgage Releases Section Component (legacy, no longer rendered)
function MortgageReleasesSection({ claimId, checks, isAdmin }: { claimId: string; checks: any[]; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [editingRelease, setEditingRelease] = useState<any>(null);
  const [formData, setFormData] = useState({
    check_id: "",
    amount: 0,
    release_date: "",
    release_method: "check",
    mortgage_company_name: "",
    reference_number: "",
    notes: "",
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: releases } = useQuery({
    queryKey: ["mortgage-releases", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mortgage_releases")
        .select("*")
        .eq("claim_id", claimId)
        .order("release_date", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const mortgageChecks = checks.filter((c: any) => c.mortgage_flag);
  const totalHeld = mortgageChecks.reduce((sum: number, c: any) => sum + Number(c.amount), 0);
  const totalReleased = releases?.reduce((sum: number, r: any) => sum + Number(r.amount), 0) || 0;
  const stillHeld = Math.max(0, totalHeld - totalReleased);

  const resetForm = () => {
    setFormData({ check_id: "", amount: 0, release_date: "", release_method: "check", mortgage_company_name: "", reference_number: "", notes: "" });
    setEditingRelease(null);
  };

  const handleEdit = (release: any) => {
    setEditingRelease(release);
    setFormData({
      check_id: release.check_id || "",
      amount: Number(release.amount) || 0,
      release_date: release.release_date || "",
      release_method: release.release_method || "check",
      mortgage_company_name: release.mortgage_company_name || "",
      reference_number: release.reference_number || "",
      notes: release.notes || "",
    });
    setOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        claim_id: claimId,
        check_id: formData.check_id || null,
        amount: formData.amount,
        release_date: formData.release_date,
        release_method: formData.release_method,
        mortgage_company_name: formData.mortgage_company_name || null,
        reference_number: formData.reference_number || null,
        notes: formData.notes || null,
      };
      if (editingRelease) {
        const { error } = await supabase.from("mortgage_releases").update(payload).eq("id", editingRelease.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("mortgage_releases").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mortgage-releases", claimId] });
      toast({ title: editingRelease ? "Release updated" : "Release recorded" });
      setOpen(false);
      resetForm();
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("mortgage_releases").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mortgage-releases", claimId] });
      toast({ title: "Release deleted" });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Mortgage Disbursements
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Track funds released by the mortgage company
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-sm">
            <div className="text-muted-foreground">Held: <span className="font-semibold text-foreground">${totalHeld.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>
            <div className="text-muted-foreground">Released: <span className="font-semibold text-emerald-500">${totalReleased.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>
            {stillHeld > 0 && <div className="text-muted-foreground">Remaining: <span className="font-semibold text-amber-500">${stillHeld.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>}
          </div>
          {isAdmin && (
            <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Record Release</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{editingRelease ? "Edit Release" : "Record Mortgage Release"}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Amount Released</Label>
                      <Input type="number" step="0.01" value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) })} />
                    </div>
                    <div>
                      <Label>Release Date</Label>
                      <Input type="date" value={formData.release_date} onChange={(e) => setFormData({ ...formData, release_date: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Mortgage Company</Label>
                      <Input value={formData.mortgage_company_name} onChange={(e) => setFormData({ ...formData, mortgage_company_name: e.target.value })} />
                    </div>
                    <div>
                      <Label>Release Method</Label>
                      <Select value={formData.release_method} onValueChange={(v) => setFormData({ ...formData, release_method: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="check">Check</SelectItem>
                          <SelectItem value="wire">Wire Transfer</SelectItem>
                          <SelectItem value="ach">ACH</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {mortgageChecks.length > 0 && (
                    <div>
                      <Label>Associated Check (optional)</Label>
                      <Select value={formData.check_id} onValueChange={(v) => setFormData({ ...formData, check_id: v })}>
                        <SelectTrigger><SelectValue placeholder="Select check..." /></SelectTrigger>
                        <SelectContent>
                          {mortgageChecks.map((c: any) => (
                            <SelectItem key={c.id} value={c.id}>
                              #{c.check_number || "N/A"} — ${Number(c.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div>
                    <Label>Reference #</Label>
                    <Input value={formData.reference_number} onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })} />
                  </div>
                  <div>
                    <Label>Notes</Label>
                    <Textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
                  </div>
                  <Button onClick={() => saveMutation.mutate()} disabled={!formData.amount || !formData.release_date} className="w-full">
                    {editingRelease ? "Update Release" : "Record Release"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {mortgageChecks.length === 0 && (
          <div className="mb-4 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            No checks are marked as mortgage-held yet. Edit or add a check and set <span className="font-medium text-foreground">Mortgage Hold</span> to start tracking disbursements.
          </div>
        )}
        {releases && releases.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Mortgage Company</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                {isAdmin && <TableHead className="w-[80px]"></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>{format(new Date(r.release_date), "MMM dd, yyyy")}</TableCell>
                  <TableCell>{r.mortgage_company_name || "—"}</TableCell>
                  <TableCell className="capitalize">{r.release_method}</TableCell>
                  <TableCell>{r.reference_number || "—"}</TableCell>
                  <TableCell className="text-right font-semibold text-primary">
                    ${Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(r)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => deleteMutation.mutate(r.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-center py-6">No mortgage releases recorded yet. Mortgage-flagged checks are being held.</p>
        )}
      </CardContent>
    </Card>
  );
}

// Expenses Section Component
function ExpensesSection({ claimId, expenses, isAdmin }: any) {
  const [open, setOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<any>(null);
  const [expenseTab, setExpenseTab] = useState("not_paid");
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [selectedPayeeId, setSelectedPayeeId] = useState("");
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState("");
  const [formData, setFormData] = useState({
    expense_date: "",
    description: "",
    amount: 0,
    category: "other",
    paid_to: "",
    payment_method: "",
    notes: "",
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const paidExpenses = expenses.filter((e: any) => e.is_paid);
  const unpaidExpenses = expenses.filter((e: any) => !e.is_paid);
  const totalPaid = paidExpenses.reduce((sum: number, e: any) => sum + Number(e.amount), 0);
  const totalUnpaid = unpaidExpenses.reduce((sum: number, e: any) => sum + Number(e.amount), 0);

  const markExpenseAsPaid = async (expenseId: string) => {
    const { error } = await supabase
      .from("claim_expenses")
      .update({ is_paid: true, paid_date: format(new Date(), "yyyy-MM-dd") } as any)
      .eq("id", expenseId);
    if (error) {
      toast({ title: "Error", description: "Failed to update", variant: "destructive" });
    } else {
      toast({ title: "Marked as paid" });
      queryClient.invalidateQueries({ queryKey: ["claim-expenses", claimId] });
    }
  };

  const markExpenseAsUnpaid = async (expenseId: string) => {
    const { error } = await supabase
      .from("claim_expenses")
      .update({ is_paid: false, paid_date: null } as any)
      .eq("id", expenseId);
    if (error) {
      toast({ title: "Error", description: "Failed to update", variant: "destructive" });
    } else {
      toast({ title: "Marked as unpaid" });
      queryClient.invalidateQueries({ queryKey: ["claim-expenses", claimId] });
    }
  };

  const resetForm = () => {
    setEditingExpense(null);
    setSelectedCategoryId("");
    setSelectedPayeeId("");
    setSelectedPaymentMethodId("");
    setFormData({
      expense_date: "",
      description: "",
      amount: 0,
      category: "other",
      paid_to: "",
      payment_method: "",
      notes: "",
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      
      if (editingExpense) {
        const { error } = await supabase
          .from("claim_expenses")
          .update({
            expense_date: formData.expense_date,
            description: formData.description,
            amount: formData.amount,
            category: formData.category,
            paid_to: formData.paid_to || null,
            payment_method: formData.payment_method || null,
            notes: formData.notes || null,
          })
          .eq("id", editingExpense.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("claim_expenses")
          .insert({
            ...formData,
            claim_id: claimId,
            created_by: user?.id,
          });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-expenses", claimId] });
      setOpen(false);
      resetForm();
      toast({ title: editingExpense ? "Expense updated successfully" : "Expense added successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: editingExpense ? "Failed to update expense" : "Failed to add expense", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (expenseId: string) => {
      const { error } = await supabase
        .from("claim_expenses")
        .delete()
        .eq("id", expenseId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-expenses", claimId] });
      toast({ title: "Expense deleted successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete expense", variant: "destructive" });
    },
  });

  const handleEdit = (expense: any) => {
    setEditingExpense(expense);
    setFormData({
      expense_date: expense.expense_date || "",
      description: expense.description || "",
      amount: Number(expense.amount) || 0,
      category: expense.category || "other",
      paid_to: expense.paid_to || "",
      payment_method: expense.payment_method || "",
      notes: expense.notes || "",
    });
    setOpen(true);
  };

  const handleOpenDialog = () => {
    resetForm();
    setOpen(true);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <div>
            <CardTitle>Expenses</CardTitle>
            {expenses.length > 0 && (
              <div className="flex gap-4 mt-1 text-sm">
                <span className="text-green-700 dark:text-green-400 font-medium">Paid: ${totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                <span className="text-destructive font-medium">Not Paid: ${totalUnpaid.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            )}
          </div>
          {isAdmin && (
            <Dialog open={open} onOpenChange={(isOpen) => { setOpen(isOpen); if (!isOpen) resetForm(); }}>
              <DialogTrigger asChild>
                <Button onClick={handleOpenDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Add Expense
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingExpense ? "Edit Expense" : "Add Expense"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Date</Label>
                    <Input
                      type="date"
                      value={formData.expense_date}
                      onChange={(e) => setFormData({ ...formData, expense_date: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Category</Label>
                    <CrudDropdown
                      table="expenses_categories"
                      labelField="name"
                      value={selectedCategoryId}
                      onValueChange={setSelectedCategoryId}
                      onLabelChange={(label) => setFormData(f => ({ ...f, category: label }))}
                      placeholder="Select or add category…"
                      emptyText="No categories yet"
                      dialogTitle="Category"
                    />
                  </div>
                </div>
                <div>
                  <Label>Description</Label>
                  <Input
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Amount</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={formData.amount}
                      onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <Label>Paid To</Label>
                    <CrudDropdown
                      table="expenses_payees"
                      labelField="name"
                      value={selectedPayeeId}
                      onValueChange={setSelectedPayeeId}
                      onLabelChange={(label) => setFormData(f => ({ ...f, paid_to: label }))}
                      placeholder="Select or add payee…"
                      emptyText="No payees yet"
                      dialogTitle="Payee"
                    />
                  </div>
                </div>
                <div>
                  <Label>Payment Method</Label>
                  <CrudDropdown
                    table="payment_methods"
                    labelField="label"
                    value={selectedPaymentMethodId}
                    onValueChange={setSelectedPaymentMethodId}
                    onLabelChange={(label) => setFormData(f => ({ ...f, payment_method: label }))}
                    placeholder="Select or add method…"
                    emptyText="No payment methods yet"
                    dialogTitle="Payment Method"
                    transformRow={(row: any) => ({
                      id: row.id,
                      label: row.label,
                      sublabel: row.method_type,
                    })}
                    buildCustomInsert={(fields, userId) => ({
                      label: fields.label,
                      method_type: fields.method_type,
                      card_last_four: fields.card_last_four || null,
                      created_by: userId,
                    })}
                    renderAddForm={(props) => (
                      <PaymentMethodForm {...props} />
                    )}
                  />
                </div>
                <div>
                  <Label>Notes</Label>
                  <Textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={2}
                  />
                </div>
                <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="w-full">
                  {editingExpense ? "Update Expense" : "Add Expense"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {expenses.length > 0 ? (
          <Tabs value={expenseTab} onValueChange={setExpenseTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="not_paid">Not Paid ({unpaidExpenses.length})</TabsTrigger>
              <TabsTrigger value="paid">Paid ({paidExpenses.length})</TabsTrigger>
              <TabsTrigger value="all">All ({expenses.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="not_paid">
              {unpaidExpenses.length === 0 ? (
                <p className="text-center py-4 text-muted-foreground text-sm">All expenses are paid!</p>
              ) : (
                <ExpenseTableInner expenses={unpaidExpenses} isAdmin={isAdmin} handleEdit={handleEdit} deleteMutation={deleteMutation} markAsPaid={markExpenseAsPaid} markAsUnpaid={markExpenseAsUnpaid} />
              )}
            </TabsContent>
            <TabsContent value="paid">
              {paidExpenses.length === 0 ? (
                <p className="text-center py-4 text-muted-foreground text-sm">No paid expenses yet</p>
              ) : (
                <ExpenseTableInner expenses={paidExpenses} isAdmin={isAdmin} handleEdit={handleEdit} deleteMutation={deleteMutation} markAsPaid={markExpenseAsPaid} markAsUnpaid={markExpenseAsUnpaid} />
              )}
            </TabsContent>
            <TabsContent value="all">
              <ExpenseTableInner expenses={expenses} isAdmin={isAdmin} handleEdit={handleEdit} deleteMutation={deleteMutation} markAsPaid={markExpenseAsPaid} markAsUnpaid={markExpenseAsUnpaid} />
            </TabsContent>
          </Tabs>
        ) : (
          <p className="text-muted-foreground text-center py-8">No expenses recorded yet</p>
        )}
      </CardContent>
    </Card>
  );
}

function ExpenseTableInner({ expenses, isAdmin, handleEdit, deleteMutation, markAsPaid, markAsUnpaid }: {
  expenses: any[];
  isAdmin: boolean;
  handleEdit: (expense: any) => void;
  deleteMutation: any;
  markAsPaid: (id: string) => void;
  markAsUnpaid: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Paid To</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          {isAdmin && <TableHead className="w-[80px]"></TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {expenses.map((expense: any) => (
          <TableRow key={expense.id}>
            <TableCell>{format(new Date(expense.expense_date), "MMM dd, yyyy")}</TableCell>
            <TableCell>{expense.description}</TableCell>
            <TableCell className="capitalize">{expense.category}</TableCell>
            <TableCell>{expense.paid_to || "—"}</TableCell>
            <TableCell>{expense.payment_method || "—"}</TableCell>
            <TableCell className="text-right font-semibold text-rose-600 dark:text-rose-400">
              ${Number(expense.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </TableCell>
            <TableCell>
              {expense.is_paid ? (
                <Badge className="bg-green-100 text-green-800 cursor-pointer" onClick={() => markAsUnpaid(expense.id)}>
                  <CheckCircle className="h-3 w-3 mr-1" /> Paid {expense.paid_date ? format(new Date(expense.paid_date), "M/d") : ""}
                </Badge>
              ) : (
                <Badge variant="destructive" className="cursor-pointer opacity-80" onClick={() => markAsPaid(expense.id)}>
                  Not Paid
                </Badge>
              )}
            </TableCell>
            {isAdmin && (
              <TableCell>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" onClick={() => handleEdit(expense)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    onClick={() => deleteMutation.mutate(expense.id)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Fees Section Component
function FeesSection({ claimId, fees, grossProfit, totalChecksReceived, checks, priorOffer = 0, isAdmin }: any) {
  const [open, setOpen] = useState(false);
  
  // Calculate company fee based on percentage of checks minus prior offer
  // Prior offer is the settlement amount before involvement that we don't collect fees on
  const calculateFeeFromChecks = (percentage: number) => {
    const totalCheckAmount = checks.reduce((sum: number, check: any) => sum + Number(check.amount), 0);
    const feeableAmount = Math.max(0, totalCheckAmount - Number(priorOffer || 0));
    const rawFee = feeableAmount * (percentage / 100);
    // Round to nearest cent
    return Math.round(rawFee * 100) / 100;
  };
  
  // Calculate adjuster fee as percentage of company fee
  const calculateAdjusterFee = (companyFeeAmount: number, adjusterPercentage: number) => {
    const rawFee = companyFeeAmount * (adjusterPercentage / 100);
    // Round to nearest cent
    return Math.round(rawFee * 100) / 100;
  };
  
  // Calculate contractor fee based on percentage of checks minus prior offer
  const calculateContractorFee = (percentage: number) => {
    const totalCheckAmount = checks.reduce((sum: number, check: any) => sum + Number(check.amount), 0);
    const feeableAmount = Math.max(0, totalCheckAmount - Number(priorOffer || 0));
    const rawFee = feeableAmount * (percentage / 100);
    // Round to nearest cent
    return Math.round(rawFee * 100) / 100;
  };
  const [formData, setFormData] = useState({
    company_fee_percentage: fees?.company_fee_percentage || 0,
    company_fee_amount: fees?.company_fee_amount || 0,
    adjuster_fee_percentage: fees?.adjuster_fee_percentage || 0,
    adjuster_fee_amount: fees?.adjuster_fee_amount || 0,
    contractor_fee_percentage: fees?.contractor_fee_percentage || 0,
    contractor_fee_amount: fees?.contractor_fee_amount || 0,
    referrer_fee_percentage: 0,
    referrer_fee_amount: 0,
    notes: fees?.notes || "",
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      
      if (fees) {
        const { error } = await supabase
          .from("claim_fees")
          .update(formData)
          .eq("id", fees.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("claim_fees")
          .insert({
            ...formData,
            claim_id: claimId,
            created_by: user?.id,
          });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-fees", claimId] });
      setOpen(false);
      toast({ title: "Fees saved successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save fees", variant: "destructive" });
    },
  });

  const companyFee = Number(fees?.company_fee_amount) || 0;
  const adjusterFee = Number(fees?.adjuster_fee_amount) || 0;
  const contractorFee = Number(fees?.contractor_fee_amount) || 0;
  // Calculate total expenses directly from checks - grossProfit
  const totalExpenses = totalChecksReceived - grossProfit;
  // Net profit = Company Fee - Adjuster Fee - Expenses (rounded to cents)
  const netProfit = Math.round((companyFee - adjusterFee - totalExpenses) * 100) / 100;

  // Recalculate adjuster fee when company fee changes (contractor/referrer are independent)
  const handleCompanyFeeChange = (percentage: number) => {
    const companyAmount = calculateFeeFromChecks(percentage);
    const adjusterAmount = calculateAdjusterFee(companyAmount, formData.adjuster_fee_percentage);
    setFormData({ 
      ...formData, 
      company_fee_percentage: percentage,
      company_fee_amount: companyAmount,
      adjuster_fee_amount: adjusterAmount,
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Fees & Profit Breakdown</CardTitle>
          {isAdmin && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button onClick={() => {
                if (fees) {
                  setFormData({
                    company_fee_percentage: fees.company_fee_percentage,
                    company_fee_amount: fees.company_fee_amount,
                    adjuster_fee_percentage: fees.adjuster_fee_percentage,
                    adjuster_fee_amount: fees.adjuster_fee_amount,
                    contractor_fee_percentage: fees.contractor_fee_percentage || 0,
                    contractor_fee_amount: fees.contractor_fee_amount || 0,
                    referrer_fee_percentage: 0,
                    referrer_fee_amount: 0,
                    notes: fees.notes || "",
                  });
                }
              }}>
                <Plus className="h-4 w-4 mr-2" />
                {fees ? "Edit" : "Set"} Fees
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{fees ? "Edit" : "Set"} Fees</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                {priorOffer > 0 && (
                  <div className="p-3 bg-warning/10 rounded-lg border border-warning/20 text-sm">
                    <p className="font-medium text-warning">Prior Offer: ${Number(priorOffer).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                    <p className="text-muted-foreground text-xs">Fees are calculated on amounts above this prior offer only</p>
                  </div>
                )}
                <div className="space-y-2">
                  <Label>Company Fee (% of checks minus prior offer)</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">Percentage</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.company_fee_percentage}
                        onChange={(e) => handleCompanyFeeChange(parseFloat(e.target.value) || 0)}
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Amount ($)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.company_fee_amount}
                        onChange={(e) => {
                          const amount = parseFloat(e.target.value) || 0;
                          const adjusterAmount = calculateAdjusterFee(amount, formData.adjuster_fee_percentage);
                          setFormData({ ...formData, company_fee_amount: amount, adjuster_fee_amount: adjusterAmount });
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Adjuster Fee (% of company fee)</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">Percentage</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.adjuster_fee_percentage}
                        onChange={(e) => {
                          const percentage = parseFloat(e.target.value) || 0;
                          const amount = calculateAdjusterFee(formData.company_fee_amount, percentage);
                          setFormData({ 
                            ...formData, 
                            adjuster_fee_percentage: percentage,
                            adjuster_fee_amount: amount
                          });
                        }}
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Amount ($)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.adjuster_fee_amount}
                        onChange={(e) => setFormData({ ...formData, adjuster_fee_amount: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Contractor Fee (% of checks minus prior offer)</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">Percentage</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.contractor_fee_percentage}
                        onChange={(e) => {
                          const percentage = parseFloat(e.target.value) || 0;
                          const amount = calculateContractorFee(percentage);
                          setFormData({ 
                            ...formData, 
                            contractor_fee_percentage: percentage,
                            contractor_fee_amount: amount
                          });
                        }}
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Amount ($)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.contractor_fee_amount}
                        onChange={(e) => setFormData({ ...formData, contractor_fee_amount: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                  </div>
                </div>
                <div>
                  <Label>Notes</Label>
                  <Textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={2}
                  />
                </div>
                <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="w-full">
                  Save Fees
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 border rounded-lg">
              <p className="text-sm text-muted-foreground">Total Income</p>
              <p className="text-xl font-bold text-success">${totalChecksReceived.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-sm text-muted-foreground">Gross Profit</p>
              <p className="text-xl font-bold">${grossProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              <p className="text-xs text-muted-foreground">Income - Expenses</p>
            </div>
          </div>
          
          <div className="space-y-2">
            <div className="flex justify-between items-center p-3 bg-muted/50 rounded">
              <span className="text-sm">Company Fee</span>
              <span className="font-semibold">
                ${companyFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                {fees?.company_fee_percentage > 0 && (
                  <span className="text-xs text-muted-foreground ml-2">({fees.company_fee_percentage}%)</span>
                )}
              </span>
            </div>
            <div className="flex justify-between items-center p-3 bg-muted/50 rounded">
              <span className="text-sm">Adjuster Fee</span>
              <span className="font-semibold">
                ${adjusterFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                {fees?.adjuster_fee_percentage > 0 && (
                  <span className="text-xs text-muted-foreground ml-2">({fees.adjuster_fee_percentage}%)</span>
                )}
              </span>
            </div>
            <div className="flex justify-between items-center p-3 bg-muted/50 rounded">
              <span className="text-sm">Contractor Fee</span>
              <span className="font-semibold">
                ${contractorFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                {fees?.contractor_fee_percentage > 0 && (
                  <span className="text-xs text-muted-foreground ml-2">({fees.contractor_fee_percentage}%)</span>
                )}
              </span>
            </div>
          </div>

          <div className="p-4 bg-primary/10 rounded-lg border-2 border-primary">
            <div className="flex justify-between items-center">
              <span className="font-semibold">Net Profit</span>
              <span className="text-2xl font-bold text-primary">
                ${netProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Company Fee - Adjuster Fee - Expenses
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
