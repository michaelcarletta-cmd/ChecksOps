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
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermissions";
import { useToast } from "@/hooks/use-toast";

/**
 * Admin-only "Delete Check" button.
 * Hidden for non-admins. Opens a confirmation dialog before invoking
 * the `admin_delete_check` RPC, which cascades cleanup of payees,
 * endorsements, deposit-ops rows, loss-draft references, and the check.
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

  if (!isAdmin) return null;

  const handleDelete = async () => {
    if (!user?.id) return;
    setDeleting(true);
    try {
      const { error } = await supabase.rpc("admin_delete_check" as any, {
        p_check_id: checkId,
        p_actor_id: user.id,
      });
      if (error) throw error;
      toast({
        title: "Check deleted",
        description: `Check${checkNumber ? ` #${checkNumber}` : ""} and all related records were removed.`,
      });
      setOpen(false);
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
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this check?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete check
              {checkNumber ? ` #${checkNumber}` : ""} along with its payees,
              endorsements, deposit packets, and loss-draft references. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
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
