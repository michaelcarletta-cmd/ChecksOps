import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, X as XIcon, Building2 } from "lucide-react";

export function NewLossDraftDialog({ onCreated }: { onCreated: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [claimId, setClaimId] = useState("");
  const [mortgageCompanyId, setMortgageCompanyId] = useState("");
  const [servicer, setServicer] = useState("");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [loanNumber, setLoanNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  // Optional 2nd mortgagee (when the same check has two mortgage companies
  // listed on it). Creates an additional loss_draft_tracking row alongside
  // the primary one — each independently runs its own monitored /
  // not-monitored workflow.
  const [showSecond, setShowSecond] = useState(false);
  const [servicer2, setServicer2] = useState("");
  const [contact2, setContact2] = useState("");
  const [phone2, setPhone2] = useState("");
  const [email2, setEmail2] = useState("");
  const [loanNumber2, setLoanNumber2] = useState("");

  const { data: claims = [] } = useQuery({
    queryKey: ["claims-for-loss-draft"],
    queryFn: async () => {
      const { data } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name, mortgage_company_id, loan_number")
        .eq("is_closed", false)
        .order("created_at", { ascending: false })
        .limit(200);
      return data ?? [];
    },
    enabled: open,
  });

  const { data: mortgageCompanies = [] } = useQuery({
    queryKey: ["mortgage-companies-for-loss-draft"],
    queryFn: async () => {
      const { data } = await supabase
        .from("mortgage_companies")
        .select("id, name, contact_name, phone, email, loan_number")
        .eq("is_active", true)
        .order("name");
      return data ?? [];
    },
    enabled: open,
  });

  // When a claim is selected, auto-select its mortgage company if one is linked
  useEffect(() => {
    if (!claimId) return;
    const claim = claims.find(c => c.id === claimId);
    if (claim?.mortgage_company_id) {
      setMortgageCompanyId(claim.mortgage_company_id);
      applyMortgageCompany(claim.mortgage_company_id);
    }
    if (claim?.loan_number && !loanNumber) {
      setLoanNumber(claim.loan_number);
    }
  }, [claimId, claims]);

  const applyMortgageCompany = (companyId: string) => {
    const company = mortgageCompanies.find(m => m.id === companyId);
    if (company) {
      setServicer(company.name);
      setContact(company.contact_name || "");
      setPhone(company.phone || "");
      setEmail(company.email || "");
      if (company.loan_number && !loanNumber) {
        setLoanNumber(company.loan_number);
      }
    }
  };

  const handleMortgageSelect = (companyId: string) => {
    setMortgageCompanyId(companyId);
    applyMortgageCompany(companyId);
  };

  const handleSave = async () => {
    if (!claimId || !servicer) {
      toast({ title: "Required", description: "Select a claim and mortgage company.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const { data: existing } = await supabase
        .from("loss_draft_tracking")
        .select("id")
        .eq("claim_id", claimId)
        .ilike("mortgage_servicer", servicer.trim())
        .neq("escrow_status", "final_release_complete")
        .limit(1);

      if (existing && existing.length > 0) {
        toast({ title: "Already exists", description: "An active loss draft already exists for this claim and servicer.", variant: "destructive" });
        setSaving(false);
        return;
      }

      const { data: inserted, error } = await supabase
        .from("loss_draft_tracking")
        .insert({
          claim_id: claimId,
          mortgage_servicer: servicer.trim(),
          loss_draft_contact: contact || null,
          loss_draft_phone: phone || null,
          loss_draft_email: email || null,
          loan_number: loanNumber || null,
          total_escrowed: amount ? parseFloat(amount) : 0,
          notes: notes || null,
          created_by: user?.id,
        })
        .select("id")
        .single();
      if (error) throw error;

      await supabase.rpc("init_loss_draft_documents", { p_loss_draft_id: inserted.id });

      await supabase.from("loss_draft_audit_log").insert({
        loss_draft_id: inserted.id,
        action: "created",
        actor_id: user?.id,
        amount: amount ? parseFloat(amount) : null,
        notes: `Created loss draft for ${servicer}`,
      });

      // Optionally create a 2nd loss_draft row when the same check has a
      // second mortgage company on it. We don't fail the whole operation
      // if the secondary insert fails — primary is already saved.
      if (showSecond && servicer2.trim()) {
        try {
          const trimmed2 = servicer2.trim();
          const { data: existing2 } = await supabase
            .from("loss_draft_tracking")
            .select("id")
            .eq("claim_id", claimId)
            .ilike("mortgage_servicer", trimmed2)
            .neq("escrow_status", "final_release_complete")
            .limit(1);
          if (!existing2 || existing2.length === 0) {
            const { data: inserted2 } = await supabase
              .from("loss_draft_tracking")
              .insert({
                claim_id: claimId,
                mortgage_servicer: trimmed2,
                loss_draft_contact: contact2 || null,
                loss_draft_phone: phone2 || null,
                loss_draft_email: email2 || null,
                loan_number: loanNumber2 || null,
                created_by: user?.id,
              })
              .select("id")
              .single();
            if (inserted2?.id) {
              await supabase.rpc("init_loss_draft_documents" as any, { p_loss_draft_id: inserted2.id });
              await supabase.from("loss_draft_audit_log").insert({
                loss_draft_id: inserted2.id,
                action: "created",
                actor_id: user?.id,
                notes: `Created loss draft for ${trimmed2} (2nd mortgagee on check)`,
              });
            }
          }
        } catch (e2) {
          console.error("Secondary loss draft creation failed:", e2);
        }
      }

      toast({
        title: showSecond && servicer2.trim() ? "Two loss drafts created" : "Loss draft created",
      });
      setOpen(false);
      resetForm();
      onCreated();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    setClaimId(""); setMortgageCompanyId(""); setServicer(""); setContact(""); setPhone("");
    setEmail(""); setLoanNumber(""); setAmount(""); setNotes("");
    setShowSecond(false); setServicer2(""); setContact2(""); setPhone2(""); setEmail2(""); setLoanNumber2("");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Loss Draft</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Loss Draft / Mortgage Escrow</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Claim *</Label>
            <Select value={claimId} onValueChange={setClaimId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select claim" />
              </SelectTrigger>
              <SelectContent>
                {claims.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.claim_number} — {c.policyholder_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Mortgage Company *</Label>
            <Select value={mortgageCompanyId} onValueChange={handleMortgageSelect}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select mortgage company" />
              </SelectTrigger>
              <SelectContent>
                {mortgageCompanies.map(m => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Mortgage companies are managed in Networking
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Loss Draft Contact</Label>
              <Input value={contact} onChange={e => setContact(e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-xs">Phone</Label>
              <Input value={phone} onChange={e => setPhone(e.target.value)} className="h-9" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Email</Label>
              <Input value={email} onChange={e => setEmail(e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-xs">Loan Number</Label>
              <Input value={loanNumber} onChange={e => setLoanNumber(e.target.value)} className="h-9" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Total Escrowed Amount</Label>
            <Input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className="h-9" />
          </div>
          <div>
            <Label className="text-xs">Notes</Label>
            <Textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} className="text-xs" />
          </div>
          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? "Creating..." : "Create Loss Draft"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
