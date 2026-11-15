import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Headset } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import {
  mortgageDeskReturnedWorkAnchorId,
  selectMortgageDeskNotes,
} from "@/lib/mortgageDeskReturn";
import { MORTGAGE_DESK_FILE_SOURCE } from "@/lib/mortgageDeskWrites";
import {
  MORTGAGE_DESK_NOTE_LABEL,
  MORTGAGE_DESK_NOTES_VISIBLE,
  countUnreadMortgageDeskNotes,
  isUnreadMortgageDeskNote,
  newestMortgageDeskNotesFirst,
} from "@/lib/mortgageDeskNoteDisplay";
import { MortgageDeskNoteRow } from "./MortgageDeskNoteRow";

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
  const { user } = useAuth();
  const [showAllNotes, setShowAllNotes] = useState(false);
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

  // "New" uses the existing per-user read mark of the check thread (check_message_reads, set
  // when the thread opens). The key sits under "check-unread-counts", so the thread's
  // invalidation on open refreshes it. A failed read marks nothing.
  const { data: readState } = useQuery({
    queryKey: ["check-unread-counts", "mortgage-desk-notes", checkId, user?.id ?? null],
    enabled: !!checkId && !!user?.id && !!data?.notes.length,
    queryFn: async (): Promise<{ known: boolean; lastReadAt: string | null }> => {
      const { data: row, error } = await supabase
        .from("check_message_reads")
        .select("last_read_at")
        .eq("user_id", user!.id)
        .eq("check_id", checkId)
        .maybeSingle();
      if (error) return { known: false, lastReadAt: null };
      return { known: true, lastReadAt: (row as { last_read_at?: string | null } | null)?.last_read_at ?? null };
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

  const sortedNotes = newestMortgageDeskNotesFirst(data.notes);
  const visibleNotes = showAllNotes ? sortedNotes : sortedNotes.slice(0, MORTGAGE_DESK_NOTES_VISIBLE);
  const lastReadAt = readState?.known ? readState.lastReadAt : undefined;
  const newCount = countUnreadMortgageDeskNotes(data.notes, lastReadAt);

  // Compact (owner 2026-11-15): an amber accent, the "Mortgage Desk" label and a "New" count
  // keep an update easy to notice; each note is one small clamped row with "Show more".
  return (
    <div
      id={mortgageDeskReturnedWorkAnchorId(checkId)}
      className="w-full rounded-md border border-border/60 border-l-2 border-l-amber-400 bg-muted/30 px-2 py-1.5 text-xs space-y-1.5 scroll-mt-4"
      data-testid="mortgage-desk-returned-work"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Headset className="h-3 w-3 shrink-0 text-amber-400" />
        <span className="text-[11px] font-semibold">{MORTGAGE_DESK_NOTE_LABEL}</span>
        <span className="truncate text-[10px] text-muted-foreground">
          {[
            data.notes.length > 0 ? `${data.notes.length} note${data.notes.length === 1 ? "" : "s"}` : null,
            data.files.length > 0 ? `${data.files.length} doc${data.files.length === 1 ? "" : "s"}` : null,
          ].filter(Boolean).join(" · ")}
        </span>
        {newCount > 0 && (
          <Badge
            className="ml-auto h-4 shrink-0 bg-amber-500 px-1.5 text-[9px] font-semibold text-black hover:bg-amber-500"
            data-testid="mortgage-desk-notes-new"
          >
            {newCount} new
          </Badge>
        )}
      </div>

      {visibleNotes.length > 0 && (
        <ul className="space-y-1">
          {visibleNotes.map((note) => (
            <li key={note.id}>
              <MortgageDeskNoteRow
                body={note.body}
                createdAt={note.created_at}
                isNew={isUnreadMortgageDeskNote(note.created_at, lastReadAt)}
              />
            </li>
          ))}
        </ul>
      )}
      {sortedNotes.length > MORTGAGE_DESK_NOTES_VISIBLE && (
        <button
          type="button"
          className="text-[10px] font-medium text-primary hover:underline"
          aria-expanded={showAllNotes}
          onClick={() => setShowAllNotes((v) => !v)}
        >
          {showAllNotes ? "Show fewer notes" : `Show all ${sortedNotes.length} notes`}
        </button>
      )}

      {data.files.length > 0 && (
        <ul className="space-y-0.5 border-t border-border/40 pt-1">
          {data.files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1">
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium">{file.file_name}</p>
                  {file.description && (
                    <p className="truncate text-[10px] text-muted-foreground">{file.description}</p>
                  )}
                </div>
              </div>
              <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[10px]" onClick={() => void openFile(file)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
