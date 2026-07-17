import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Loader2, Link2, Copy, Send } from "lucide-react";

interface Props {
  /** Claim tied to this check. Required — the tracking link is per-claim. */
  claimId: string | null | undefined;
  tenantId?: string | null;
  /** Optional pre-fill; falls back to claim.policyholder_* on open. */
  defaultName?: string | null;
  defaultEmail?: string | null;
  defaultPhone?: string | null;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "ghost" | "secondary";
  label?: string;
  className?: string;
  /** Force sender identity (e.g., 'checksops' for Mortgage Ops desk). */
  senderOverride?: "checksops" | null;
}

/**
 * One-click "Send homeowner tracking link" for any check.
 * Uses the existing tokenized ledger (/ledger/:token) — no login required.
 */
export function SendCheckTrackingLinkButton({
  claimId,
  tenantId,
  defaultName,
  defaultEmail,
  defaultPhone,
  size = "sm",
  variant = "outline",
  label = "Send tracking link",
  className,
  senderOverride = null,
}: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName || "");
  const [email, setEmail] = useState(defaultEmail || "");
  const [phone, setPhone] = useState(defaultPhone || "");
  const [busy, setBusy] = useState(false);
  const [sentUrl, setSentUrl] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  const openDialog = async () => {
    setOpen(true);
    if (prefilled || !claimId) return;
    const { data } = await supabase
      .from("claims")
      .select("policyholder_name,policyholder_email,policyholder_phone")
      .eq("id", claimId)
      .maybeSingle();
    if (data) {
      setName((v) => v || data.policyholder_name || "");
      setEmail((v) => v || data.policyholder_email || "");
      setPhone((v) => v || data.policyholder_phone || "");
    }
    setPrefilled(true);
  };

  const send = async () => {
    if (!email && !phone) {
      toast.error("Add an email or phone");
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("homeowner-ledger-send", {
        body: {
          claim_id: claimId ?? null,
          tenant_id: tenantId ?? undefined,
          homeowner_email: email || null,
          homeowner_phone: phone || null,
          homeowner_name: name || null,
          rotate: false,
          origin: window.location.origin,
        },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      const url = (data as any)?.url as string;
      setSentUrl(url);
      toast.success(email ? "Tracking link emailed to homeowner" : "Tracking link created");
    } catch (e: any) {
      toast.error(e?.message || "Send failed");
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!sentUrl) return;
    navigator.clipboard.writeText(sentUrl);
    toast.success("Link copied");
  };

  const reset = () => {
    setOpen(false);
    setSentUrl(null);
  };

  if (!claimId) {
    return (
      <Button size={size} variant={variant} className={className} disabled title="Link this check to a claim first">
        <Link2 className="h-3.5 w-3.5 mr-1" /> {label}
      </Button>
    );
  }

  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={openDialog}>
        <Link2 className="h-3.5 w-3.5 mr-1" /> {label}
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : reset())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send homeowner tracking link</DialogTitle>
            <DialogDescription>
              The homeowner gets a private link to follow every check on this claim — status,
              endorsements, deposits, mortgage/loss-draft docs, and messages. No login required.
            </DialogDescription>
          </DialogHeader>

          {sentUrl ? (
            <div className="space-y-3">
              <div className="text-sm">Link is live:</div>
              <div className="p-2 bg-muted rounded text-xs break-all font-mono">{sentUrl}</div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={copy}>
                  <Copy className="h-4 w-4 mr-1" /> Copy
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={sentUrl} target="_blank" rel="noreferrer">Preview</a>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {email ? `Email sent to ${email}.` : "No email on file — copy the link and share it manually."}
                {" "}The same link works for every check on this claim.
              </p>
              <DialogFooter>
                <Button size="sm" onClick={reset}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="hlink-name">Homeowner name</Label>
                  <Input id="hlink-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="hlink-email">Email</Label>
                  <Input id="hlink-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="hlink-phone">Phone (optional)</Label>
                  <Input id="hlink-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={reset} disabled={busy}>Cancel</Button>
                <Button onClick={send} disabled={busy || (!email && !phone)}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                  Send link
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
