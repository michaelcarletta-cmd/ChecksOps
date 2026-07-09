import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, CheckCircle2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

const LOSS_TYPES = [
  "Roof / Wind / Hail",
  "Water / Plumbing leak",
  "Fire / Smoke",
  "Mold",
  "Hurricane / Storm",
  "Theft / Vandalism",
  "Other",
];

const schema = z.object({
  homeowner_name: z.string().trim().min(2, "Enter your name").max(120),
  homeowner_email: z.string().trim().email("Enter a valid email").max(255),
  homeowner_phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[\d\s()+\-.]*$/, "Phone can only contain digits and () + - .")
    .optional()
    .or(z.literal("")),
  property_zip: z
    .string()
    .trim()
    .regex(/^\d{5}$/, "5-digit ZIP")
    .optional()
    .or(z.literal("")),
  loss_type: z.string().max(80).optional().or(z.literal("")),
  message: z.string().trim().max(1000).optional().or(z.literal("")),
});

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contractor: {
    id: string;
    display_name: string;
    user_id?: string | null;
  } | null;
};

export function HomeownerIntroRequestModal({ open, onOpenChange, contractor }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [zip, setZip] = useState("");
  const [lossType, setLossType] = useState<string>("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState("");

  const reset = () => {
    setName("");
    setEmail("");
    setPhone("");
    setZip("");
    setLossType("");
    setMessage("");
    setSubmitted(false);
    setLeadId(null);
    setSubmittedEmail("");
  };

  const handleClose = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  const submit = async () => {
    if (!contractor) return;
    const parsed = schema.safeParse({
      homeowner_name: name,
      homeowner_email: email,
      homeowner_phone: phone,
      property_zip: zip,
      loss_type: lossType,
      message,
    });
    if (!parsed.success) {
      const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
      toast.error(first ?? "Please fix the highlighted fields");
      return;
    }

    setSubmitting(true);
    try {
      // Look up user_id if not passed in
      let contractorUserId = contractor.user_id ?? null;
      if (!contractorUserId) {
        const { data: prof } = await supabase
          .from("contractor_profiles")
          .select("user_id")
          .eq("id", contractor.id)
          .maybeSingle();
        contractorUserId = prof?.user_id ?? null;
      }
      if (!contractorUserId) throw new Error("Contractor unavailable");

      const { data: inserted, error } = await supabase
        .from("homeowner_intro_requests")
        .insert({
          contractor_profile_id: contractor.id,
          contractor_user_id: contractorUserId,
          homeowner_name: parsed.data.homeowner_name,
          homeowner_email: parsed.data.homeowner_email,
          homeowner_phone: parsed.data.homeowner_phone || null,
          property_zip: parsed.data.property_zip || null,
          loss_type: parsed.data.loss_type || null,
          message: parsed.data.message || null,
        })
        .select("id")
        .single();
      if (error) throw error;

      // Fire-and-forget email notification to the contractor
      if (inserted?.id) {
        supabase.functions
          .invoke("notify-homeowner-lead", { body: { lead_id: inserted.id } })
          .catch(() => {
            /* non-blocking; the lead is already saved */
          });
      }
      setLeadId(inserted?.id ?? null);
      setSubmittedEmail(parsed.data.homeowner_email);
      setSubmitted(true);
    } catch (e: any) {
      toast.error(e.message ?? "Could not send your request");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        {submitted ? (
          <div className="py-6 text-center space-y-3">
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
            <DialogTitle className="text-xl">Request sent</DialogTitle>
            <p className="text-sm text-muted-foreground">
              {contractor?.display_name} has been notified. They typically respond within 1 business day.
              Watch your email — including spam.
            </p>
            <Button className="w-full" onClick={() => handleClose(false)}>
              Done
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Contact {contractor?.display_name}</DialogTitle>
              <DialogDescription className="flex items-start gap-2 text-xs pt-2">
                <ShieldCheck className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
                <span>
                  Your info goes directly to this pro through ChecksOps. We never sell your details or
                  share them with anyone else on the directory.
                </span>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="space-y-1.5">
                <Label htmlFor="hir-name">Your name *</Label>
                <Input id="hir-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="hir-email">Email *</Label>
                  <Input
                    id="hir-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={255}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="hir-phone">Phone</Label>
                  <Input
                    id="hir-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    maxLength={30}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="hir-zip">Property ZIP</Label>
                  <Input
                    id="hir-zip"
                    inputMode="numeric"
                    value={zip}
                    onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
                    maxLength={5}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Type of loss</Label>
                  <Select value={lossType} onValueChange={setLossType}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {LOSS_TYPES.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hir-msg">What do you need help with?</Label>
                <Textarea
                  id="hir-msg"
                  value={message}
                  onChange={(e) => setMessage(e.target.value.slice(0, 1000))}
                  placeholder="Briefly describe your claim or property damage…"
                  className="min-h-[90px]"
                />
                <p className="text-[10px] text-muted-foreground text-right">{message.length}/1000</p>
              </div>
              <Button className="w-full" onClick={submit} disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Send request
              </Button>
              <p className="text-[10px] text-muted-foreground text-center">
                By sending, you agree ChecksOps may share your details with this contractor to respond.
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
