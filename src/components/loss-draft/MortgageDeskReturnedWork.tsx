import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { FileText, Headset, StickyNote } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import {
  displayCheckMessageBody,
  mortgageDeskReturnedWorkAnchorId,
  selectMortgageDeskNotes,
} from "@/lib/mortgageDeskReturn";
import { MORTGAGE_DESK_FILE_SOURCE } from "@/lib/mortgageDeskWrites";

type DeskRequestRow = {
  id: string;
  assigned_employee_id: string | null;
  status: string;
  mortgage_company: string | null;
  completed_at: string | null;
};

type DeskMessageRow = {
  id: string;
  sender_id: string | null;
  body: string;
  created_at: string | null;
  is_deleted: boolean | null;
};

type DeskFileRow = {
  id: string;
  file_name: string;
  file_path: string;
  category: string | null;
  description: string | null;
  created_at: string | null;
};

/**
 * Tenant view of what the ChecksOps Mortgage Desk returned on a check: every
 * note the Desk posted on the check thread (updates, mid-work notes, the
 * completed-work note) and every document it attached (check_files with
 * source 'mortgage_ops', shipping labels included). The banner's "Review
 * Returned File" scrolls here.
 */
export function MortgageDeskReturnedWork({ checkId }: { checkId: string }) {
  const { data } = useQuery({
    queryKey: ["mortgage-desk-returned-work", checkId],
    enabled: !!checkId,
    queryFn: async () => {
      const { data: requests } = await supabase
        .from("mortgage_handling_requests")
        .select("id, assigned_employee_id, status, mortgage_company, completed_at")
        .eq("check_intake_item_id", checkId)
        .order("created_at", { ascending: true });
      const deskRequests = (requests || []) as unknown as DeskRequestRow[];
      if (!deskRequests.length) return { requests: deskRequests, notes: [], files: [] };
      const [{ data: messages }, { data: files }] = await Promise.all([
        supabase
          .from("check_messages")
          .select("id, sender_id, body, created_at, is_deleted")
          .eq("check_id", checkId)
          .eq("is_deleted", false)
          .order("created_at", { ascending: true })
          .limit(500),
        supabase
          .from("check_files")
          .select("id, file_name, file_path, category, description, created_at")
          .eq("check_intake_item_id", checkId)
          .eq("source", MORTGAGE_DESK_FILE_SOURCE)
          .order("created_at", { ascending: true }),
      ]);
      const notes = selectMortgageDeskNotes(
        (messages || []) as unknown as DeskMessageRow[],
        deskRequests.map((r) => r.assigned_employee_id),
      );
      return { requests: deskRequests, notes, files: (files || []) as unknown as DeskFileRow[] };
    },
  });

  if (!data?.requests.length || (!data.notes.length && !data.files.length)) return null;

  const openFile = async (file: DeskFileRow) => {
    const { data: signed, error } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(file.file_path, 300, { download: file.file_name });
    if (error || !signed?.signedUrl) {
      toast({ title: "Could not open document", description: error?.message, variant: "destructive" });
      return;
    }
    window.open(signed.signedUrl, "_blank", "noopener");
  };

  return (
    <div
      id={mortgageDeskReturnedWorkAnchorId(checkId)}
      className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs space-y-3 scroll-mt-4"
      data-testid="mortgage-desk-returned-work"
    >
      <div className="flex items-center gap-2">
        <Headset className="h-3.5 w-3.5 text-amber-400" />
        <span className="font-semibold">Mortgage Desk notes &amp; documents</span>
      </div>

      {data.notes.length > 0 && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1 text-[10px] tracking-wide text-muted-foreground">
            <StickyNote className="h-3 w-3" /> Notes ({data.notes.length})
          </p>
          <ul className="space-y-1.5">
            {data.notes.map((note) => (
              <li key={note.id} className="rounded bg-background/60 p-2">
                <p className="whitespace-pre-wrap leading-snug">{displayCheckMessageBody(note.body)}</p>
                {note.created_at && (
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {format(new Date(note.created_at), "MMM d, yyyy h:mm a")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.files.length > 0 && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1 text-[10px] tracking-wide text-muted-foreground">
            <FileText className="h-3 w-3" /> Documents ({data.files.length})
          </p>
          <ul className="space-y-1">
            {data.files.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{file.file_name}</p>
                  {file.description && (
                    <p className="truncate text-[10px] text-muted-foreground">{file.description}</p>
                  )}
                </div>
                <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[10px]" onClick={() => void openFile(file)}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
