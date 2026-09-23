import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/aws/client";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Eraser, PenTool } from "lucide-react";

const CONSENT_TEXT = "I am the named payee (or authorized signer) and consent to sign this insurance check endorsement electronically. I authorize staff to capture my signature in person on my behalf. I intend my electronic signature to be legally binding.";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endorsementId?: string; // real endorsement id, or omit if using payeeId
  payeeId?: string;
  payeeName: string;
  onComplete: () => void;
}

export function InPersonSignatureDialog({ open, onOpenChange, endorsementId, payeeId, payeeName, onComplete }: Props) {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    const parent = containerRef.current;
    if (!canvas || !parent) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = parent.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(180 * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `180px`;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rect.width, 180);
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    hasInkRef.current = false;
  }, [open]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    hasInkRef.current = true;
  };
  const end = () => { drawingRef.current = false; };

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    hasInkRef.current = false;
  };

  const submit = async () => {
    if (!hasInkRef.current) {
      toast({ title: "Please draw a signature", variant: "destructive" });
      return;
    }
    if (!consent) {
      toast({ title: "Consent required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const dataUrl = canvasRef.current!.toDataURL("image/png");
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");
      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: {
          action: "sign_in_person",
          endorsementId,
          payeeId,
          signatureData: dataUrl,
          eSignConsentAccepted: true,
          consentText: CONSENT_TEXT,
        },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });
      if (error) throw new Error(await getFunctionErrorMessage(error, "Failed to capture signature"));
      toast({ title: `${payeeName} signed in person` });
      onComplete();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Failed to submit", description: e.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenTool className="h-4 w-4" /> Sign in person — {payeeName}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Hand the device to the payee and have them sign below. This captures a legally binding e-signature.
          </DialogDescription>
        </DialogHeader>

        <div ref={containerRef} className="rounded-md border border-border bg-white">
          <canvas
            ref={canvasRef}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
            className="touch-none rounded-md"
            style={{ display: "block" }}
          />
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={clear} className="text-xs">
            <Eraser className="h-3 w-3 mr-1" /> Clear
          </Button>
        </div>

        <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
          <span>{CONSENT_TEXT}</span>
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !consent}>
            {submitting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <PenTool className="h-3 w-3 mr-1" />}
            Capture signature
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
