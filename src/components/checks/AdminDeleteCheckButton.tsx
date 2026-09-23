import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermissions";
import { useToast } from "@/hooks/use-toast";

/**
 * Admin-only "Delete Check" button. Allows deleting a check from ANY status.
 * Requires the admin to provide a reason (logged to check_deletion_log + claim_audit_log).
 */
export function AdminDeleteCheckButton({
  checkId,
  checkNumber,
  onDeleted,
  size = "sm",
  variant = "outline",
  label = "Delete Check",
  className,
}: {
  checkId: string;
  checkNumber?: string | null;
  onDeleted?: () => void;
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "destructive";
  label?: string;
  className?: string;
}) {
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState("");

  if (!isAdmin) return null;

  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= 3;

  const handleDelete = async () => {
    if (!user?.id) return;
    if (!reasonValid) {
      toast({
        title: "Reason required",
        description: "Please provide a reason (min 3 characters).",
        variant: "destructive",
      });
      return;
    }
    setDeleting(true);
    try {
      const { error } = await supabase.rpc("admin_delete_check" as any, {
        p_check_id: checkId,
        p_actor_id: user.id,
        p_reason: trimmed,
      });
      if (error) throw error;
      toast({
        title: "Check deleted",
        description: `Check${checkNumber ? ` #${checkNumber}` : ""} and all related records were removed.`,
      });
      setOpen(false);
      setReason("");
      onDeleted?.();
    } catch (e: any) {
      toast({
        title: "Delete failed",
        description: e?.message ?? "Could not delete check",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={`text-destructive hover:bg-destructive/10 ${className ?? ""}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
        {label}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setReason("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this check?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete check
              {checkNumber ? ` #${checkNumber}` : ""} along with its payees,
              endorsements, deposit packets, and loss-draft references —
              regardless of its current status. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-reason">
              Reason for deletion <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="delete-reason"
              placeholder="e.g. Duplicate intake, voided by carrier, entered in error…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={deleting}
            />
            <p className="text-xs text-muted-foreground">
              Required. Logged to the audit trail.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting || !reasonValid}
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
