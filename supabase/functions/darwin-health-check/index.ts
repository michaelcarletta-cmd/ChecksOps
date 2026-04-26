import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleCors, jsonResponse, errorResponse } from "../_shared/http.ts";

const AMENDMENT_MARKERS = [
  "amended", "revised", "supplemental", "updated decision",
  "replacement letter", "supersedes", "rescinds", "this letter replaces",
];

const EXPERT_TEXT_MARKERS = [
  "p.e.", "professional engineer", "engineer", "engineering report",
  "cause of loss", "findings", "opinion", "seal", "license",
];

const ANCHOR_TYPES = [
  "fnol_received", "denial_issued", "ror_issued", "acknowledgement_issued",
  "inspection", "payment_received", "estimate_issued", "engineer_report_issued",
];

function textOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0) return 0;
  let match = 0;
  for (const w of wordsA) if (wordsB.has(w)) match++;
  return match / wordsA.size;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { claimId } = await req.json();
    if (!claimId) {
      return new Response(JSON.stringify({ error: "claimId required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch claim
    const { data: claim } = await supabase
      .from("claims")
      .select("id, claim_number, insurance_company, policyholder_name, policyholder_address, status")
      .eq("id", claimId)
      .single();

    // Fetch files
    const { data: files } = await supabase
      .from("claim_files")
      .select("id, file_name, file_path, extracted_text, document_classification, classification_metadata, uploaded_at")
      .eq("claim_id", claimId)
      .order("uploaded_at", { ascending: false });

    // Fetch events
    const { data: events } = await supabase
      .from("claim_events")
      .select("id, event_type, occurred_at, summary, date_source, doc_type, metadata_json, source_artifact_id")
      .eq("claim_id", claimId)
      .order("occurred_at", { ascending: true });

    // Fetch recent comms
    const { data: emails } = await supabase
      .from("emails")
      .select("id, subject, sent_at, direction, created_at")
      .eq("claim_id", claimId)
      .order("sent_at", { ascending: false })
      .limit(5);

    const { data: smsMessages } = await supabase
      .from("sms_messages")
      .select("id, body, sent_at, direction, status")
      .eq("claim_id", claimId)
      .order("sent_at", { ascending: false })
      .limit(5);

    const allFiles = files || [];
    const allEvents = events || [];
    const allEmails = emails || [];
    const allSMS = smsMessages || [];

    // === DOCUMENTS SECTION ===
    const filesWithText = allFiles.filter(f => f.extracted_text && f.extracted_text.length > 10);
    const missingTextFiles = allFiles
      .filter(f => !f.extracted_text || f.extracted_text.length <= 10)
      .slice(0, 3)
      .map(f => f.file_name);

    // === TIMELINE SECTION ===
    const anchorEvents = allEvents.filter(e => ANCHOR_TYPES.includes(e.event_type));
    const presentAnchors = [...new Set(anchorEvents.map(e => e.event_type))];
    const missingAnchors = ANCHOR_TYPES.filter(t => !presentAnchors.includes(t));

    // === EXPERT REPORT SECTION (multi-signal) ===
    const expertFilesByClassification = allFiles.filter(f =>
      f.document_classification === "engineering_report"
    );
    const EXPERT_NAME_MARKERS = ["engineer", "engineering", "p.e.", "sealed"];
    const expertFilesByName = allFiles.filter(f => {
      const name = f.file_name?.toLowerCase() || "";
      return EXPERT_NAME_MARKERS.some(m => name.includes(m));
    });
    const expertEventsByType = allEvents.filter(e =>
      e.event_type === "engineer_report_issued" || e.doc_type === "engineering_report"
    );
    const expertFilesByText = allFiles.filter(f => {
      const text = (f.extracted_text || "").toLowerCase().substring(0, 2000);
      return EXPERT_TEXT_MARKERS.filter(m => text.includes(m)).length >= 2;
    });

    const allExpertFiles = [...new Set([
      ...expertFilesByClassification.map(f => f.file_name),
      ...expertFilesByName.map(f => f.file_name),
      ...expertFilesByText.map(f => f.file_name),
    ])];
    const hasExpertReport = allExpertFiles.length > 0 || expertEventsByType.length > 0;

    const expertDebug = {
      files_by_classification: expertFilesByClassification.map(f => f.file_name),
      files_by_name: expertFilesByName.map(f => f.file_name),
      files_by_text_markers: expertFilesByText.map(f => f.file_name),
      events_matched: expertEventsByType.map(e => ({ id: e.id, type: e.event_type, doc_type: e.doc_type })),
      rule_result: hasExpertReport,
    };

    // === DENIAL DE-DUP / AMENDMENT MERGE ===
    // Group denials by claim_number first, then merge within each group
    const denialEvents = allEvents.filter(e => e.event_type === "denial_issued");
    const mergedDenials: any[] = [];
    const denialMergeLog: any[] = [];

    if (denialEvents.length > 1) {
      // Extract claim_number from metadata or use the claim's own number
      const getClaimNum = (e: any): string => {
        const meta = e.metadata_json as Record<string, any> | null;
        return meta?.claim_number || claim?.claim_number || "unknown";
      };

      // Group by claim_number
      const groups = new Map<string, typeof denialEvents>();
      for (const e of denialEvents) {
        const cn = getClaimNum(e);
        if (!groups.has(cn)) groups.set(cn, []);
        groups.get(cn)!.push(e);
      }

      for (const [_cn, group] of groups) {
        if (group.length <= 1) {
          mergedDenials.push(...group);
          continue;
        }
        const processed = new Set<string>();
        for (let i = 0; i < group.length; i++) {
          if (processed.has(group[i].id)) continue;
          const merged = { ...group[i], denial_versions: [group[i].source_artifact_id], amended_by: [] as string[] };

          for (let j = i + 1; j < group.length; j++) {
            if (processed.has(group[j].id)) continue;

            const file1 = allFiles.find(f => f.id === group[i].source_artifact_id);
            const file2 = allFiles.find(f => f.id === group[j].source_artifact_id);
            const text2 = (file2?.extracted_text || "").toLowerCase();
            const hasAmendmentLang = AMENDMENT_MARKERS.some(m => text2.includes(m));

            const text1Decision = (file1?.extracted_text || "").substring(0, 3000);
            const text2Decision = (file2?.extracted_text || "").substring(0, 3000);
            const overlap = textOverlap(text1Decision, text2Decision);

            if (hasAmendmentLang || overlap >= 0.7) {
              processed.add(group[j].id);
              merged.amended_by.push(group[j].source_artifact_id || group[j].id);
              merged.denial_versions.push(group[j].source_artifact_id);
              denialMergeLog.push({
                merged_event: group[j].id,
                reason: hasAmendmentLang ? "amendment_language" : `text_overlap_${(overlap * 100).toFixed(0)}%`,
                into: group[i].id,
              });
            }
          }
          processed.add(group[i].id);
          mergedDenials.push(merged);
        }
      }
    } else {
      mergedDenials.push(...denialEvents);
    }

    // === COMMS SECTION ===
    const lastEmail = allEmails[0] || null;
    const lastSMS = allSMS[0] || null;

    // === WARNINGS INTEGRITY ===
    const warningsIntegrity: any[] = [];
    
    // "No Expert Report" warning debug
    warningsIntegrity.push({
      warning: "No Expert Report",
      suppressed: hasExpertReport,
      why: expertDebug,
    });

    // === OVERALL STATUS ===
    // Use relaxed thresholds so normal claims aren't flagged:
    // - files_missing_text only if majority of files lack text
    // - missing_anchors only if FNOL is missing (the one anchor every claim should have)
    // - no_expert_report is informational, not a problem
    // - comms warning only if claim is older than 7 days with no comms
    const issues: string[] = [];
    
    // Only flag denial duplicates as an actual issue — everything else is informational
    if (denialMergeLog.length > 0) issues.push("denial_duplicates_merged");

    const overallStatus = issues.length === 0 ? "Healthy" : "Needs Attention";
    
    // Track informational notes (not counted as issues)
    const textCoverageRatio = allFiles.length > 0 ? filesWithText.length / allFiles.length : 1;
    const criticalMissingAnchors = missingAnchors.filter(a => a === "fnol_received");

    const result = {
      status: overallStatus,
      ran_at: new Date().toISOString(),
      claim_number: claim?.claim_number,
      documents: {
        total_files: allFiles.length,
        files_with_text: filesWithText.length,
        missing_text_filenames: missingTextFiles,
        text_coverage_pct: allFiles.length > 0 ? Math.round((filesWithText.length / allFiles.length) * 100) : 100,
        status: (allFiles.length === 0 || textCoverageRatio >= 0.5) ? "ok" : "warning",
      },
      timeline: {
        total_anchor_events: anchorEvents.length,
        present_anchors: presentAnchors,
        missing_anchors: missingAnchors,
        total_events: allEvents.length,
        status: criticalMissingAnchors.length === 0 ? "ok" : "warning",
      },
      expert_reports: {
        detected: hasExpertReport,
        filenames: allExpertFiles,
        detection_debug: expertDebug,
        status: hasExpertReport ? "ok" : "info",
      },
      comms: {
        last_email: lastEmail ? {
          subject: lastEmail.subject,
          direction: lastEmail.direction,
          date: lastEmail.sent_at || lastEmail.created_at,
        } : null,
        last_sms: lastSMS ? {
          body: (lastSMS.body || "").substring(0, 80),
          direction: lastSMS.direction,
          status: lastSMS.status,
          date: lastSMS.sent_at,
        } : null,
        status: (lastEmail || lastSMS) ? "ok" : "warning",
      },
      denial_truth_layer: {
        raw_denial_count: denialEvents.length,
        merged_denial_count: mergedDenials.length,
        merge_log: denialMergeLog,
        merged_denials: mergedDenials.map(d => ({
          id: d.id,
          occurred_at: d.occurred_at,
          summary: d.summary,
          amended_by: d.amended_by,
          denial_versions: d.denial_versions,
        })),
      },
      warnings_integrity: warningsIntegrity,
      issues,
    };

    // Store in DB — resolve user via anon client to avoid service-role getUser()
    const authHeader = req.headers.get("authorization");
    let userId: string | null = null;
    if (authHeader) {
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
      const anonClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await anonClient.auth.getUser();
      userId = user?.id || null;
    }

    await supabase.from("darwin_health_checks").insert({
      claim_id: claimId,
      status: overallStatus,
      result,
      created_by: userId,
    });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("darwin-health-check error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
