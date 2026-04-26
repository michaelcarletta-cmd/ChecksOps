import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleCors, jsonResponse, errorResponse } from "../_shared/http.ts";

interface CanonicalTimelineEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  summary: string | null;
  actor: string | null;
  source_artifact_id: string | null;
  source_artifact_type: string | null;
  source_table: string | null;
  source_row_id: string | null;
  metadata_json: Record<string, unknown>;
  date_source?: string | null;
  date_confidence?: number | null;
  date_evidence?: string | null;
  doc_type?: string | null;
  is_manual?: boolean;
  is_editable?: boolean;
  is_pinned?: boolean;
  importance_score?: number | null;
  dispute_tag?: string | null;
  supports_escalation?: boolean;
  supports_rebuttal?: boolean;
  is_verified?: boolean;
  verification_basis?: string | null;
  derived?: boolean;
}

const isoOrNow = (value?: string | null) => {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

const safeNum = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const pushIfDate = (
  events: CanonicalTimelineEvent[],
  row: Omit<CanonicalTimelineEvent, "occurred_at"> & { occurred_at?: string | null }
) => {
  if (!row.occurred_at) return;
  events.push({
    ...row,
    occurred_at: isoOrNow(row.occurred_at),
  });
};

Deno.serve(async (req) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const claimId = (body as { claimId?: string }).claimId;

    if (!claimId) {
      return errorResponse("claimId required", 400);
    }

    const events: CanonicalTimelineEvent[] = [];

    // 1) Claim overview / claims table
    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .select(`
        id,
        created_at,
        updated_at,
        claim_number,
        loss_date,
        loss_type,
        status,
        carrier_name,
        policyholder_name,
        assigned_adjuster,
        fnol_date
      `)
      .eq("id", claimId)
      .maybeSingle();

    if (claimErr) {
      console.error("claim lookup error:", claimErr);
    }

    if (claim) {
      pushIfDate(events, {
        id: `claim-created-${claim.id}`,
        event_type: "claim_created",
        occurred_at: claim.created_at,
        summary: `Claim created${claim.claim_number ? ` (${claim.claim_number})` : ""}`,
        actor: null,
        source_artifact_id: claim.id,
        source_artifact_type: "claim",
        source_table: "claims",
        source_row_id: claim.id,
        metadata_json: {
          claim_number: claim.claim_number,
          status: claim.status,
          loss_type: claim.loss_type,
          carrier_name: claim.carrier_name,
          policyholder_name: claim.policyholder_name,
        },
        date_source: "system_record",
        date_confidence: 1,
        date_evidence: "claims.created_at",
        doc_type: null,
        is_manual: false,
        is_editable: false,
        is_pinned: false,
        importance_score: 4,
        dispute_tag: null,
        supports_escalation: false,
        supports_rebuttal: false,
        is_verified: true,
        verification_basis: "Claim record",
        derived: false,
      });

      pushIfDate(events, {
        id: `loss-date-${claim.id}`,
        event_type: "loss_event",
        occurred_at: claim.loss_date,
        summary: `Date of loss${claim.loss_type ? ` — ${claim.loss_type}` : ""}`,
        actor: null,
        source_artifact_id: claim.id,
        source_artifact_type: "claim",
        source_table: "claims",
        source_row_id: claim.id,
        metadata_json: {
          loss_type: claim.loss_type,
          carrier_name: claim.carrier_name,
        },
        date_source: "claim_overview",
        date_confidence: 0.95,
        date_evidence: "claims.loss_date",
        doc_type: null,
        is_manual: false,
        is_editable: false,
        is_pinned: true,
        importance_score: 10,
        dispute_tag: "origin",
        supports_escalation: true,
        supports_rebuttal: true,
        is_verified: true,
        verification_basis: "Claim overview",
        derived: false,
      });

      pushIfDate(events, {
        id: `fnol-${claim.id}`,
        event_type: "fnol_received",
        occurred_at: claim.fnol_date,
        summary: "First notice of loss received",
        actor: null,
        source_artifact_id: claim.id,
        source_artifact_type: "claim",
        source_table: "claims",
        source_row_id: claim.id,
        metadata_json: {},
        date_source: "claim_overview",
        date_confidence: 0.95,
        date_evidence: "claims.fnol_date",
        doc_type: null,
        is_manual: false,
        is_editable: false,
        is_pinned: false,
        importance_score: 9,
        dispute_tag: null,
        supports_escalation: true,
        supports_rebuttal: true,
        is_verified: true,
        verification_basis: "Claim overview",
        derived: false,
      });
    }

    // 2) Canonical stored claim_events
    const { data: claimEvents, error: evErr } = await supabase
      .from("claim_events")
      .select(`
        id,
        claim_id,
        event_type,
        occurred_at,
        summary,
        actor,
        source_artifact_id,
        source_artifact_type,
        metadata_json,
        date_source,
        date_confidence,
        date_evidence,
        doc_type,
        is_manual,
        is_editable,
        is_pinned,
        importance_score,
        dispute_tag,
        supports_escalation,
        supports_rebuttal
      `)
      .eq("claim_id", claimId)
      .order("occurred_at", { ascending: false });

    if (!evErr && claimEvents?.length) {
      events.push(
        ...claimEvents.map((e: any) => ({
          id: e.id,
          event_type: e.event_type,
          occurred_at: isoOrNow(e.occurred_at),
          summary: e.summary ?? null,
          actor: e.actor ?? null,
          source_artifact_id: e.source_artifact_id ?? null,
          source_artifact_type: e.source_artifact_type ?? null,
          source_table: "claim_events",
          source_row_id: e.id,
          metadata_json: (e.metadata_json as Record<string, unknown>) ?? {},
          date_source: e.date_source ?? null,
          date_confidence: e.date_confidence ?? null,
          date_evidence: e.date_evidence ?? null,
          doc_type: e.doc_type ?? null,
          is_manual: !!e.is_manual,
          is_editable: !!e.is_editable,
          is_pinned: !!e.is_pinned,
          importance_score: e.importance_score ?? null,
          dispute_tag: e.dispute_tag ?? null,
          supports_escalation: !!e.supports_escalation,
          supports_rebuttal: !!e.supports_rebuttal,
          is_verified: ["document_extracted", "document_text_regex", "claim_overview", "system_record", "manual"].includes(e.date_source ?? ""),
          verification_basis:
            e.date_source === "document_extracted" ? "Verified from document text" :
            e.date_source === "document_text_regex" ? "Matched from document text pattern" :
            e.date_source === "manual" ? "Manual event" :
            e.date_source === "claim_overview" ? "Claim overview" :
            "Stored claim event",
          derived: false,
        }))
      );
    }

    // 3) Claim notes / updates
    const { data: updates } = await supabase
      .from("claim_updates")
      .select("id, content, update_type, created_at")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (updates?.length) {
      for (const u of updates) {
        pushIfDate(events, {
          id: `update-${u.id}`,
          event_type: "claim_note",
          occurred_at: u.created_at,
          summary: u.content ? String(u.content).slice(0, 240) : `Claim note${u.update_type ? ` (${u.update_type})` : ""}`,
          actor: null,
          source_artifact_id: u.id,
          source_artifact_type: "claim_update",
          source_table: "claim_updates",
          source_row_id: u.id,
          metadata_json: {
            update_type: u.update_type,
            full_content: u.content,
          },
          date_source: "system_record",
          date_confidence: 0.9,
          date_evidence: "claim_updates.created_at",
          doc_type: null,
          is_manual: false,
          is_editable: false,
          is_pinned: false,
          importance_score: 3,
          dispute_tag: null,
          supports_escalation: false,
          supports_rebuttal: false,
          is_verified: true,
          verification_basis: "Claim note timestamp",
          derived: true,
        });
      }
    }

    // 4) Files
    const { data: files } = await supabase
      .from("claim_files")
      .select(`
        id,
        file_name,
        created_at,
        uploaded_at,
        extracted_text,
        document_classification,
        processed_by_darwin
      `)
      .eq("claim_id", claimId)
      .order("uploaded_at", { ascending: false })
      .limit(100);

    if (files?.length) {
      for (const f of files) {
        const fileDate = f.uploaded_at ?? f.created_at;
        pushIfDate(events, {
          id: `file-${f.id}`,
          event_type: "file_uploaded",
          occurred_at: fileDate,
          summary: `File uploaded: ${f.file_name}`,
          actor: null,
          source_artifact_id: f.id,
          source_artifact_type: "claim_file",
          source_table: "claim_files",
          source_row_id: f.id,
          metadata_json: {
            file_name: f.file_name,
            document_classification: f.document_classification,
            processed_by_darwin: f.processed_by_darwin,
            has_extracted_text: !!(f.extracted_text && f.extracted_text.length > 50),
          },
          date_source: "system_record",
          date_confidence: 0.95,
          date_evidence: "claim_files.uploaded_at",
          doc_type: f.document_classification ?? null,
          is_manual: false,
          is_editable: false,
          is_pinned: false,
          importance_score: 2,
          dispute_tag: null,
          supports_escalation: false,
          supports_rebuttal: false,
          is_verified: true,
          verification_basis: "Upload timestamp",
          derived: true,
        });
      }
    }

    // 5) Emails
    const { data: emails } = await supabase
      .from("emails")
      .select("id, subject, sent_at, created_at, recipient_email, recipient_name")
      .eq("claim_id", claimId)
      .order("sent_at", { ascending: false })
      .limit(100);

    if (emails?.length) {
      for (const e of emails) {
        const at = e.sent_at ?? e.created_at;
        const subject = e.subject ?? "Email sent";
        const lower = subject.toLowerCase();

        let eventType = "email_sent";
        let rebuttal = false;
        let escalation = false;
        let importance = 3;

        if (lower.includes("denial")) {
          eventType = "denial_issued";
          rebuttal = true;
          escalation = true;
          importance = 10;
        } else if (lower.includes("reservation of rights") || lower.includes("ror")) {
          eventType = "ror_issued";
          rebuttal = true;
          escalation = true;
          importance = 8;
        } else if (lower.includes("estimate")) {
          eventType = "estimate_issued";
          rebuttal = true;
          importance = 7;
        }

        pushIfDate(events, {
          id: `email-${e.id}`,
          event_type: eventType,
          occurred_at: at,
          summary: subject,
          actor: null,
          source_artifact_id: e.id,
          source_artifact_type: "email",
          source_table: "emails",
          source_row_id: e.id,
          metadata_json: {
            recipient_email: e.recipient_email,
            recipient_name: e.recipient_name,
          },
          date_source: "system_record",
          date_confidence: 0.95,
          date_evidence: e.sent_at ? "emails.sent_at" : "emails.created_at",
          doc_type: "email",
          is_manual: false,
          is_editable: false,
          is_pinned: false,
          importance_score: importance,
          dispute_tag: null,
          supports_escalation: escalation,
          supports_rebuttal: rebuttal,
          is_verified: true,
          verification_basis: "Email record",
          derived: true,
        });
      }
    }

    // 6) Inspections
    const { data: inspections } = await supabase
      .from("inspections")
      .select("id, inspection_date, inspection_type, status, inspector_name")
      .eq("claim_id", claimId)
      .order("inspection_date", { ascending: false });

    if (inspections?.length) {
      for (const i of inspections) {
        pushIfDate(events, {
          id: `inspection-${i.id}`,
          event_type: "inspection",
          occurred_at: i.inspection_date,
          summary: `${i.inspection_type || "Inspection"}${i.status ? ` — ${i.status}` : ""}`,
          actor: i.inspector_name ?? null,
          source_artifact_id: i.id,
          source_artifact_type: "inspection",
          source_table: "inspections",
          source_row_id: i.id,
          metadata_json: {
            inspection_type: i.inspection_type,
            status: i.status,
            inspector_name: i.inspector_name,
          },
          date_source: "system_record",
          date_confidence: 0.95,
          date_evidence: "inspections.inspection_date",
          doc_type: null,
          is_manual: false,
          is_editable: false,
          is_pinned: false,
          importance_score: 8,
          dispute_tag: null,
          supports_escalation: false,
          supports_rebuttal: true,
          is_verified: true,
          verification_basis: "Inspection record",
          derived: true,
        });
      }
    }

    // 7) Payments
    const { data: payments } = await supabase
      .from("claim_payments")
      .select("id, amount, payment_date, payment_method")
      .eq("claim_id", claimId)
      .order("payment_date", { ascending: false });

    if (payments?.length) {
      for (const p of payments) {
        pushIfDate(events, {
          id: `payment-${p.id}`,
          event_type: "payment_received",
          occurred_at: p.payment_date,
          summary: `Payment: $${safeNum(p.amount).toLocaleString()} (${p.payment_method ?? "—"})`,
          actor: null,
          source_artifact_id: p.id,
          source_artifact_type: "payment",
          source_table: "claim_payments",
          source_row_id: p.id,
          metadata_json: {
            amount: p.amount,
            payment_method: p.payment_method,
          },
          date_source: "system_record",
          date_confidence: 0.95,
          date_evidence: "claim_payments.payment_date",
          doc_type: null,
          is_manual: false,
          is_editable: false,
          is_pinned: false,
          importance_score: 9,
          dispute_tag: null,
          supports_escalation: true,
          supports_rebuttal: true,
          is_verified: true,
          verification_basis: "Payment record",
          derived: true,
        });
      }
    }

    // 8) Checks
    const { data: checks } = await supabase
      .from("claim_checks")
      .select("id, amount, check_date, received_date, check_type, check_number")
      .eq("claim_id", claimId)
      .order("check_date", { ascending: false });

    if (checks?.length) {
      for (const c of checks) {
        pushIfDate(events, {
          id: `check-${c.id}`,
          event_type: "payment_issued",
          occurred_at: c.received_date ?? c.check_date,
          summary: `Check ${c.check_number ?? ""} for $${safeNum(c.amount).toLocaleString()}${c.check_type ? ` (${c.check_type})` : ""}`.trim(),
          actor: null,
          source_artifact_id: c.id,
          source_artifact_type: "claim_check",
          source_table: "claim_checks",
          source_row_id: c.id,
          metadata_json: {
            amount: c.amount,
            check_date: c.check_date,
            received_date: c.received_date,
            check_type: c.check_type,
            check_number: c.check_number,
          },
          date_source: "system_record",
          date_confidence: 0.95,
          date_evidence: c.received_date ? "claim_checks.received_date" : "claim_checks.check_date",
          doc_type: null,
          is_manual: false,
          is_editable: false,
          is_pinned: false,
          importance_score: 9,
          dispute_tag: null,
          supports_escalation: true,
          supports_rebuttal: true,
          is_verified: true,
          verification_basis: "Check record",
          derived: true,
        });
      }
    }

    // Deduplicate by source + type + day + summary
    const dedupedMap = new Map<string, CanonicalTimelineEvent>();
    for (const e of events) {
      const day = e.occurred_at?.split("T")[0] ?? "unknown";
      const key = [
        e.source_table ?? "unknown",
        e.source_row_id ?? e.id,
        e.event_type,
        day,
        e.summary ?? ""
      ].join("|");

      const existing = dedupedMap.get(key);
      if (!existing) {
        dedupedMap.set(key, e);
      } else {
        const existingScore = safeNum(existing.importance_score);
        const newScore = safeNum(e.importance_score);
        if (newScore > existingScore) dedupedMap.set(key, e);
      }
    }

    const merged = Array.from(dedupedMap.values()).sort(
      (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
    );

    const summary = {
      total_events: merged.length,
      verified_events: merged.filter(e => e.is_verified).length,
      document_backed_events: merged.filter(e => ["document_extracted", "document_text_regex"].includes(e.date_source ?? "")).length,
      manual_events: merged.filter(e => e.is_manual).length,
      escalation_candidates: merged.filter(e => e.supports_escalation).length,
      rebuttal_candidates: merged.filter(e => e.supports_rebuttal).length,
    };

    console.log(`[get-claim-timeline] claim=${claimId} returning ${merged.length} events (verified=${summary.verified_events}, doc_backed=${summary.document_backed_events}, manual=${summary.manual_events})`);

    return jsonResponse({
      claimId,
      claim,
      summary,
      events: merged,
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500, e);
  }
});
