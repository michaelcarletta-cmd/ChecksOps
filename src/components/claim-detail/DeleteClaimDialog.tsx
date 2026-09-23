import { useState } from "react";
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
import { supabase } from "@/integrations/aws/client";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

interface DeleteClaimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  claimId: string;
  claimNumber: string;
}

export function DeleteClaimDialog({ open, onOpenChange, claimId, claimNumber }: DeleteClaimDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("claims")
        .delete()
        .eq("id", claimId);

      if (error) throw error;

      toast.success("Claim deleted successfully");
      navigate("/claims");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete claim");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Claim</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to permanently delete claim <strong>{claimNumber}</strong>? This action cannot be undone and will delete all associated data including:
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Files and documents</li>
              <li>Tasks and inspections</li>
              <li>Communications and notes</li>
              <li>Accounting records</li>
              <li>All other claim data</li>
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleting ? "Deleting..." : "Delete Claim"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
