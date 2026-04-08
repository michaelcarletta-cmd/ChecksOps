import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}

export function BlockTaskDialog({ open, onClose, onConfirm }: Props) {
  const [reason, setReason] = useState("");

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Block Task</DialogTitle>
        </DialogHeader>
        <div>
          <Label>What's blocking this task?</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g., Waiting for carrier response..." rows={3} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { onConfirm(reason); setReason(""); }} disabled={!reason.trim()}>
            Block Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
