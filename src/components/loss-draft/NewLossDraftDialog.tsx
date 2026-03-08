import { useState } from "react";
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
import { Plus } from "lucide-react";

export function NewLossDraftDialog({ onCreated }: { onCreated: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [claimId, setClaimId] = useState("");
  const [servicer, setServicer] = useState("");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [loanNumber, setLoanNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  const { data: claims = [] } = useQuery({
    queryKey: ["claims-for-loss-draft"],
    queryFn: async () => {
      const { data } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name")
        .eq("is_closed", false)
        .order("created_at", { ascending: false })
        .limit(200);
      return data ?? [];
    },
    enabled: open,
  });

  const handleSave = async () => {
    if (!claimId || !servicer) {
      toast({ title: "Required", description: "Select a claim and enter servicer name.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      // Check for existing active draft for same claim + servicer (idempotent guard)
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

      // Initialize doc checklist
      await supabase.rpc("init_loss_draft_documents", { p_loss_draft_id: inserted.id });

      // Audit
      await supabase.from("loss_draft_audit_log").insert({
        loss_draft_id: inserted.id,
        action: "created",
        actor_id: user?.id,
        amount: amount ? parseFloat(amount) : null,
        notes: `Created loss draft for ${servicer}`,
      });

      toast({ title: "Loss draft created" });
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
    setClaimId(""); setServicer(""); setContact(""); setPhone("");
    setEmail(""); setLoanNumber(""); setAmount(""); setNotes("");
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
            <Label className="text-xs">Mortgage Servicer *</Label>
            <Input value={servicer} onChange={e => setServicer(e.target.value)} placeholder="e.g. Mr. Cooper" className="h-9" />
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
