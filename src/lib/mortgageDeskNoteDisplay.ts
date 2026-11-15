/**
 * Compact tenant display of Mortgage Desk notes (owner 2026-11-15: "When mortgage desk adds a
 * note the boxes/notifications show large. Let's make those notifications smaller but easily
 * to notice from a tenant that there is an update.").
 *
 * Display only: reads existing check_messages rows and the existing per-user
 * check_message_reads.last_read_at (the same "read" mark the check thread sets when it opens).
 * No new server state.
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */
import {
  MORTGAGE_DESK_MESSAGE_PREFIXES,
  displayCheckMessageBody,
  isReturnMessage,
} from "./mortgageDeskReturn.ts";
import { MORTGAGE_DESK_NOTE_PREFIX } from "./mortgageDeskWrites.ts";

export const MORTGAGE_DESK_NOTE_LABEL = "Mortgage Desk";
/** A note longer than this, or on more than one line, starts clamped with a "Show more" toggle. */
export const MORTGAGE_DESK_NOTE_CLAMP_CHARS = 140;
/** How many of the newest notes the compact list shows before "Show all". */
export const MORTGAGE_DESK_NOTES_VISIBLE = 3;

/**
 * A check-thread message the Desk posted, recognised by its prefix (notes, upload and label
 * notices, the completed-work note) or the return marker. The tenant's acknowledgement of a
 * return is not a Desk note.
 */
export function isMortgageDeskThreadMessage(body: string | null | undefined): boolean {
  if (typeof body !== "string" || body.trim() === "") return false;
  if (isReturnMessage(body)) return true;
  return MORTGAGE_DESK_MESSAGE_PREFIXES.some((prefix) => body.startsWith(prefix));
}

/** The note text without the "📝 ChecksOps Mortgage Desk note: " prefix (the row shows the label). */
export function mortgageDeskNoteText(body: string | null | undefined): string {
  const text = displayCheckMessageBody(body);
  return text.startsWith(MORTGAGE_DESK_NOTE_PREFIX) ? text.slice(MORTGAGE_DESK_NOTE_PREFIX.length).trim() : text;
}

export function mortgageDeskNoteIsLong(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.length > MORTGAGE_DESK_NOTE_CLAMP_CHARS || text.includes("\n");
}

/**
 * Whether a note is new to this user: posted after their last read of the check thread.
 * `lastReadAt` undefined means the read state is unknown (not loaded, or the read failed):
 * nothing is marked. null means the user has never opened the thread: every note is new.
 */
export function isUnreadMortgageDeskNote(
  createdAt: string | null | undefined,
  lastReadAt: string | null | undefined,
): boolean {
  if (lastReadAt === undefined || !createdAt) return false;
  if (lastReadAt === null) return true;
  const created = new Date(createdAt).getTime();
  const read = new Date(lastReadAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(read)) return false;
  return created > read;
}

export function countUnreadMortgageDeskNotes(
  notes: Array<{ created_at?: string | null }>,
  lastReadAt: string | null | undefined,
): number {
  return notes.filter((n) => isUnreadMortgageDeskNote(n.created_at, lastReadAt)).length;
}

/** Newest first, so the latest update is at the top of the compact list. */
export function newestMortgageDeskNotesFirst<T extends { created_at?: string | null }>(notes: T[]): T[] {
  return notes
    .slice()
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
}
