/**
 * Tenant Management desk view (SQL 158). Owner 2026-11-12: Tenant Management (the platform owner) sees every
 * tenant's Mortgage Desk work with its age, assigns a queued request to an agent ("If no agent then tenant
 * management can assign"), and messages the assigned agent ("Message agent": an email AND a private note that only
 * Tenant Management and that agent can read). Everything goes through POST /functions/v1/mortgage-desk-esign
 * (actions desk_overview, desk_agents, assign_agent, message_agent, agent_notes); SQL 158 checks every caller itself.
 */
import { invokeMortgageDeskEsign, type MortgageDeskFunctionsClient } from "./mortgageDeskEsign.ts";

export type MortgageDeskOversightStatus = "requested" | "in_progress" | "completed";
export const MORTGAGE_DESK_OVERSIGHT_STATUSES: readonly MortgageDeskOversightStatus[] = ["requested", "in_progress", "completed"];
/** A page of the overview; the server allows 1..500. */
export const MORTGAGE_DESK_OVERSIGHT_PAGE = 100;
/** SQL 158 d: a message is 1 to 2000 characters, at most 10 per request per hour. */
export const MORTGAGE_DESK_AGENT_NOTE_MAX = 2000;

export type MortgageDeskOverviewRow = {
  request_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  status: MortgageDeskOversightStatus;
  mortgage_company: string | null;
  loan_number: string | null;
  claim_number: string | null;
  homeowner_name: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  created_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  status_since: string | null;
  seconds_in_status: number | string | null;
  turnaround_seconds: number | string | null;
  note_count: number | null;
  last_note_at: string | null;
};

export type MortgageDeskAssignableAgent = { agent_id: string; agent_name: string | null; in_progress_count: number | null };

export type MortgageDeskAgentNote = {
  note_id: string;
  request_id: string;
  author_id: string | null;
  agent_id: string | null;
  body: string;
  email_status: "pending" | "sent" | "failed" | "skipped" | string;
  emailed_at: string | null;
  created_at: string;
};

export function deskOversightStatusLabel(status: string | null | undefined): string {
  if (status === "requested") return "Queued";
  if (status === "in_progress") return "In progress";
  if (status === "completed") return "Completed";
  return String(status || "Unknown");
}

/** "<1m", "12m", "3h 5m", "2d 4h": a duration in whole seconds, the two largest units. */
export function formatDeskAge(seconds: number | string | null | undefined): string {
  const n = Number(seconds);
  if (seconds === null || seconds === undefined || seconds === "" || !Number.isFinite(n) || n < 0) return "—";
  const s = Math.floor(n);
  if (s < 60) return "<1m";
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** A queued request older than a day, or one in progress longer than three days, is flagged. */
export function deskAgeIsLate(row: Pick<MortgageDeskOverviewRow, "status" | "seconds_in_status">): boolean {
  const s = Number(row.seconds_in_status);
  if (!Number.isFinite(s)) return false;
  if (row.status === "requested") return s >= 24 * 3600;
  if (row.status === "in_progress") return s >= 3 * 24 * 3600;
  return false;
}

/** "Owner Co / Big Bank / loan 12345", the parts that are present. */
export function deskRequestLabel(row: Pick<MortgageDeskOverviewRow, "tenant_name" | "mortgage_company" | "loan_number">): string {
  return [row.tenant_name, row.mortgage_company, row.loan_number ? `loan ${row.loan_number}` : null]
    .filter((part) => part && String(part).trim())
    .join(" / ") || "Mortgage Desk request";
}

/** Assign to a queued, unassigned request; message an assigned one (in progress or completed). */
export function canAssignDeskRequest(row: Pick<MortgageDeskOverviewRow, "status" | "assigned_agent_id">): boolean {
  return row.status === "requested" && !row.assigned_agent_id;
}

export function canMessageDeskAgent(row: Pick<MortgageDeskOverviewRow, "status" | "assigned_agent_id">): boolean {
  return !!row.assigned_agent_id && (row.status === "in_progress" || row.status === "completed");
}

/** The agent page shows the notes to the platform owner and to the agent the request is assigned to (SQL 158 f). */
export function canReadMortgageDeskAgentNotes(
  req: { status?: string | null; assigned_employee_id?: string | null } | null | undefined,
  userId: string | null | undefined,
  platformOwner: boolean,
): boolean {
  if (!req || !req.assigned_employee_id) return false;
  if (req.status !== "in_progress" && req.status !== "completed") return false;
  return platformOwner || (!!userId && req.assigned_employee_id === userId);
}

export function deskNoteEmailLabel(status: string | null | undefined): string {
  if (status === "sent") return "Emailed";
  if (status === "failed") return "Email failed";
  if (status === "skipped") return "No email on file";
  return "Email pending";
}

/** A message the server would refuse for its length, or null. */
export function deskAgentNoteError(body: string): string | null {
  const text = String(body ?? "").trim();
  if (!text) return "Write a message first.";
  if (text.length > MORTGAGE_DESK_AGENT_NOTE_MAX) return `The message must be at most ${MORTGAGE_DESK_AGENT_NOTE_MAX} characters.`;
  return null;
}

export async function loadDeskOverview(
  client: MortgageDeskFunctionsClient,
  params: { status?: MortgageDeskOversightStatus | null; tenantId?: string | null; limit?: number; offset?: number } = {},
): Promise<{ data: { rows: MortgageDeskOverviewRow[]; total: number } | null; error: string | null }> {
  const body: Record<string, unknown> = {
    action: "desk_overview",
    limit: params.limit ?? MORTGAGE_DESK_OVERSIGHT_PAGE,
    offset: params.offset ?? 0,
  };
  if (params.status) body.status = params.status;
  if (params.tenantId) body.tenant_id = params.tenantId;
  const out = await invokeMortgageDeskEsign<{ data: MortgageDeskOverviewRow[]; total: number }>(client, body);
  if (out.error) return { data: null, error: out.error };
  const rows = out.data?.data;
  if (!Array.isArray(rows)) return { data: null, error: "Unexpected reply" };
  return { data: { rows, total: Number(out.data?.total) || 0 }, error: null };
}

export async function loadDeskAssignableAgents(
  client: MortgageDeskFunctionsClient,
): Promise<{ data: MortgageDeskAssignableAgent[] | null; error: string | null }> {
  const out = await invokeMortgageDeskEsign<{ data: MortgageDeskAssignableAgent[] }>(client, { action: "desk_agents" });
  if (out.error) return { data: null, error: out.error };
  const rows = out.data?.data;
  if (!Array.isArray(rows)) return { data: null, error: "Unexpected reply" };
  return { data: rows, error: null };
}

export async function assignDeskAgent(
  client: MortgageDeskFunctionsClient,
  requestId: string,
  agentId: string,
): Promise<{ data: { noticeStatus: string | null } | null; error: string | null }> {
  const out = await invokeMortgageDeskEsign<{ notice?: { status?: string } }>(client, {
    action: "assign_agent",
    request_id: requestId,
    agent_id: agentId,
  });
  if (out.error) return { data: null, error: out.error };
  return { data: { noticeStatus: out.data?.notice?.status ?? null }, error: null };
}

export async function messageDeskAgent(
  client: MortgageDeskFunctionsClient,
  requestId: string,
  body: string,
): Promise<{ data: { emailStatus: string | null } | null; error: string | null }> {
  const invalid = deskAgentNoteError(body);
  if (invalid) return { data: null, error: invalid };
  const out = await invokeMortgageDeskEsign<{ email?: { status?: string } }>(client, {
    action: "message_agent",
    request_id: requestId,
    body: body.trim(),
  });
  if (out.error) return { data: null, error: out.error };
  return { data: { emailStatus: out.data?.email?.status ?? null }, error: null };
}

export async function loadDeskAgentNotes(
  client: MortgageDeskFunctionsClient,
  requestId: string,
): Promise<{ data: MortgageDeskAgentNote[] | null; error: string | null }> {
  const out = await invokeMortgageDeskEsign<{ data: MortgageDeskAgentNote[] }>(client, { action: "agent_notes", request_id: requestId });
  if (out.error) return { data: null, error: out.error };
  const rows = out.data?.data;
  if (!Array.isArray(rows)) return { data: null, error: "Unexpected reply" };
  return { data: rows, error: null };
}
