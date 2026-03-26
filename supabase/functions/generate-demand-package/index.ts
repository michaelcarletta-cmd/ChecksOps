import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { callOpenAIText } from "../_shared/ai-router.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Json = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function truncate(text: string, max = 60000): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n\n[TRUNCATED]` : text;
}

function money(value: unknown): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
}

function pick(obj: Record<string, any>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return fallback;
}

function normalizeLower(value: unknown): string {
  return safeString(value).toLowerCase();
}

function looksLikeInspectionFile(file: Record<string, any>): boolean {
  const name = `${normalizeLower(file.file_name)} ${normalizeLower(file.name)} ${normalizeLower(file.doc_type)} ${normalizeLower(file.category)} ${normalizeLower(file.analysis_type)}`;
  return ["inspection", "photo packet", "damage assessment", "field report", "site report", "scope report", "engineer", "photos", "inspection report"].some((term) => name.includes(term));
}

function looksLikeEstimateFile(file: Record<string, any>): boolean {
  const name = `${normalizeLower(file.file_name)} ${normalizeLower(file.name)} ${normalizeLower(file.doc_type)} ${normalizeLower(file.category)} ${normalizeLower(file.analysis_type)}`;
  return ["estimate", "xactimate", "scope", "repair estimate", "rebuild", "loss estimate"].some((term) => name.includes(term));
}

function summarizeEstimateLines(lines: Record<string, any>[]) {
  const roomTradeTotals = new Map<string, number>();
  const tradeTotals = new Map<string, number>();
  let grandTotal = 0;

  for (const line of lines) {
    const room = pick(line, ["room_name", "room", "area"], "Unassigned Room");
    const trade = pick(line, ["trade", "category"], "General");
    const total = Number(line.total) || Number(line.rcv_total) || (Number(line.quantity) || 0) * (Number(line.unit_price) || 0);
    grandTotal += total;
    const roomTradeKey = `${room}__${trade}`;
    roomTradeTotals.set(roomTradeKey, (roomTradeTotals.get(roomTradeKey) || 0) + total);
    tradeTotals.set(trade, (tradeTotals.get(trade) || 0) + total);
  }

  const tradeSummary = [...tradeTotals.entries()].sort((a, b) => b[1] - a[1]).map(([trade, total]) => `${trade}: ${money(total)}`).join("\n");
  const roomTradeSummary = [...roomTradeTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([key, total]) => {
    const [room, trade] = key.split("__");
    return `${room} | ${trade}: ${money(total)}`;
  }).join("\n");

  return { grandTotal, tradeSummary, roomTradeSummary };
}

function estimateLinesToText(lines: Record<string, any>[]) {
  if (!lines.length) return "";
  const summary = summarizeEstimateLines(lines);
  const detailLines = lines.slice(0, 800).map((line) => {
    const room = pick(line, ["room_name", "room", "area"], "Unassigned Room");
    const trade = pick(line, ["trade", "category"], "General");
    const code = pick(line, ["code", "line_code", "item_code"]);
    const description = pick(line, ["description", "item_description"], "No description");
    const quantity = pick(line, ["quantity", "qty"], "0");
    const unit = pick(line, ["unit", "uom"], "");
    const unitPrice = money(line.unit_price ?? line.price ?? 0);
    const total = money(line.total ?? line.rcv_total ?? (Number(line.quantity ?? line.qty ?? 0) * Number(line.unit_price ?? line.price ?? 0)));
    return [`Room: ${room}`, `Trade: ${trade}`, code ? `Code: ${code}` : null, `Description: ${description}`, `Qty: ${quantity} ${unit}`.trim(), `Unit Price: ${unitPrice}`, `Total: ${total}`].filter(Boolean).join(" | ");
  }).join("\n");

  return [`ESTIMATE GRAND TOTAL: ${money(summary.grandTotal)}`, "", "TRADE SUMMARY:", summary.tradeSummary || "None", "", "ROOM / TRADE SUMMARY:", summary.roomTradeSummary || "None", "", "DETAILED LINE ITEMS:", detailLines].join("\n");
}

function buildDemandPrompt(args: {
  claim: Record<string, any> | null;
  masterState: Record<string, any> | null;
  intelligence: Record<string, any> | null;
  inspectionText: string;
  estimateText: string;
  timelineText: string;
  priorPaymentsText: string;
  userNotes: string;
  carrierPositionText: string;
}) {
  const claim = args.claim || {};
  const insuredName = pick(claim, ["insured_name", "insured", "policyholder_name"], "Insured");
  const propertyAddress = pick(claim, ["property_address", "loss_address", "address", "propertyLocation"], "");
  const dateOfLoss = pick(claim, ["date_of_loss", "loss_date", "dol"], "");
  const claimNumber = pick(claim, ["claim_number", "claim_no", "number"], "");
  const carrier = pick(claim, ["carrier", "carrier_name", "insurance_company"], "");
  const policyNumber = pick(claim, ["policy_number", "policy_no"], "");

  const masterStateText = args.masterState ? JSON.stringify(args.masterState, null, 2) : "No master state available.";
  const intelligenceText = args.intelligence ? JSON.stringify(args.intelligence, null, 2) : "No intelligence summary available.";

  return `
You are Darwin, an elite public adjuster demand-package engine.

Your task is to analyze:
1. A third-party inspection report / damage assessment
2. A repair estimate
3. Claim timeline context
4. Claim intelligence context

Then generate a HIGH-PRESSURE, TECHNICALLY SOUND, COVERAGE-FOCUSED DEMAND PACKAGE that expands on the documents and presents the claim in a way that makes payment the reasonable next step for the carrier.

IMPORTANT WRITING RULES:
- Write as a professional public adjuster claim demand.
- No markdown bullets in the final body unless needed for a sectioned schedule.
- Do not mention AI.
- Do not say "based on the prompt" or "based on the documents provided."
- Do not merely summarize. Expand, connect, and persuade.
- Every major damage observation should connect to scope and payment necessity.
- Use counterfactual causation logic where helpful:
  "If not for the reported loss event, the observed condition would not be present."
- Argue against incomplete, piecemeal, cosmetic, or partial repairs where the facts support full repair/replacement.
- Emphasize repairability limits, interdependency, matching, access, disturbance, code, manufacturer requirements, and restoration sequencing where supported.
- If timeline facts support it, highlight claim-handling delay, inadequate investigation, under-scoping, or failure to account for the full loss.
- Keep it assertive, evidence-driven, and carrier-facing.
- Do not invent code citations or policy language. If not provided, refer generally to applicable policy obligations and standards of good-faith claim handling.
- Use the estimate total as the demand amount unless the materials support another specific figure.
- If the inspection report identifies room/component-specific damage, fold that into the narrative so the estimate reads inevitable and justified.
- If there are weak points or missing proof, identify them in the "strategic_notes" field only, not in the demand body.

RETURN STRICT JSON with this exact shape:
{
  "title": "string",
  "subject_line": "string",
  "demand_amount": "string",
  "executive_summary": "string",
  "cause_of_loss_analysis": "string",
  "detailed_damage_findings": "string",
  "scope_and_repair_justification": "string",
  "repair_vs_replacement_analysis": "string",
  "code_and_compliance_requirements": "string",
  "system_interdependency_analysis": "string",
  "carrier_risk_and_exposure": "string",
  "formal_demand": "string",
  "full_demand_package": "string",
  "strategic_notes": "string",
  "missing_evidence": ["string"],
  "confidence_score": 0
}

CLAIM FACTS:
Insured Name: ${insuredName}
Property Address: ${propertyAddress}
Date of Loss: ${dateOfLoss}
Claim Number: ${claimNumber}
Carrier: ${carrier}
Policy Number: ${policyNumber}

CLAIM MASTER STATE:
${masterStateText}

CLAIM INTELLIGENCE:
${intelligenceText}

CLAIM TIMELINE:
${args.timelineText || "No timeline context available."}

PRIOR PAYMENTS / CHECKS:
${args.priorPaymentsText || "No prior payment context available."}

KNOWN CARRIER POSITION / DISPUTE:
${args.carrierPositionText || "No specific carrier position provided."}

USER NOTES / STRATEGY:
${args.userNotes || "No additional notes provided."}

THIRD-PARTY INSPECTION REPORT / DAMAGE ASSESSMENT:
${args.inspectionText || "No inspection report text available."}

REPAIR ESTIMATE:
${args.estimateText || "No estimate text available."}

FINAL REQUIREMENT:
The "full_demand_package" field must be a polished, carrier-ready demand document with clear section headings:
1. Executive Summary
2. Cause of Loss Analysis
3. Detailed Damage Findings
4. Scope and Repair Justification
5. Repair vs. Replacement Analysis
6. Code and Compliance Requirements
7. System Interdependency Analysis
8. Carrier Risk and Exposure
9. Formal Demand

The document should read like something a serious public adjuster would actually send to a carrier to push payment now.
`.trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing Supabase environment variables");
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = (await req.json()) as Json;

    const claimId = safeString(body.claimId);
    const inspectionReportTextOverride = safeString(body.inspectionReportText);
    const estimateTextOverride = safeString(body.estimateText);
    const carrierPositionText = safeString(body.carrierPositionText);
    const userNotes = safeString(body.userNotes);
    const saveToMasterState = Boolean(body.saveToMasterState ?? true);

    if (!claimId) {
      return json({ error: "claimId is required" }, 400);
    }

    const [claimRes, filesRes, estimateLinesRes, masterStateRes, intelligenceRes, eventsRes, paymentsRes] = await Promise.all([
      supabase.from("claims").select("*").eq("id", claimId).maybeSingle(),
      supabase.from("claim_files").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(100),
      supabase.from("darwin_estimate_lines").select("*").eq("claim_id", claimId).order("created_at", { ascending: true }),
      supabase.from("claim_master_state").select("*").eq("claim_id", claimId).maybeSingle(),
      supabase.from("claim_intelligence_summary").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("claim_events").select("*").eq("claim_id", claimId).order("occurred_at", { ascending: true }).limit(200),
      supabase.from("claim_payments").select("*").eq("claim_id", claimId).order("created_at", { ascending: true }).limit(50),
    ]);

    const claim = claimRes.data || null;
    const files = filesRes.data || [];
    const estimateLines = estimateLinesRes.data || [];
    const masterState = masterStateRes.data || null;
    const intelligence = intelligenceRes.data || null;
    const events = eventsRes.data || [];
    const payments = paymentsRes.data || [];

    const inspectionFiles = files.filter((f: Record<string, any>) => looksLikeInspectionFile(f));
    const estimateFiles = files.filter((f: Record<string, any>) => looksLikeEstimateFile(f));

    const inspectionTextFromFiles = inspectionFiles.map((f: Record<string, any>) =>
      [`FILE: ${pick(f, ["file_name", "name"], "Unknown file")}`, safeString(f.extracted_text)].filter(Boolean).join("\n")
    ).filter(Boolean).join("\n\n");

    const estimateTextFromFiles = estimateFiles.map((f: Record<string, any>) =>
      [`FILE: ${pick(f, ["file_name", "name"], "Unknown file")}`, safeString(f.extracted_text)].filter(Boolean).join("\n")
    ).filter(Boolean).join("\n\n");

    const estimateLinesText = estimateLinesToText(estimateLines);

    const inspectionText = truncate(inspectionReportTextOverride || inspectionTextFromFiles, 70000);
    const estimateText = truncate(estimateTextOverride || [estimateLinesText, estimateTextFromFiles].filter(Boolean).join("\n\n"), 70000);

    const timelineText = truncate(
      events.map((e: Record<string, any>) => {
        const occurredAt = pick(e, ["occurred_at", "created_at"], "");
        const type = pick(e, ["event_type", "type"], "event");
        const summary = pick(e, ["summary", "description", "title"], "");
        return `${occurredAt} | ${type} | ${summary}`;
      }).join("\n"),
      15000
    );

    const priorPaymentsText = truncate(
      payments.map((p: Record<string, any>) => {
        const createdAt = pick(p, ["created_at", "paid_at", "issued_at"], "");
        const amount = money(p.amount ?? p.payment_amount ?? 0);
        const type = pick(p, ["payment_type", "type"], "payment");
        const note = pick(p, ["note", "memo", "summary"], "");
        return `${createdAt} | ${type} | ${amount} | ${note}`;
      }).join("\n"),
      8000
    );

    if (!inspectionText) {
      return json({ error: "No inspection report text found. Provide inspectionReportText directly or make sure claim_files.extracted_text exists for the inspection report." }, 400);
    }

    if (!estimateText) {
      return json({ error: "No estimate text found. Provide estimateText directly or make sure darwin_estimate_lines / claim_files estimate text exists." }, 400);
    }

    const prompt = buildDemandPrompt({
      claim,
      masterState,
      intelligence,
      inspectionText,
      estimateText,
      timelineText,
      priorPaymentsText,
      userNotes,
      carrierPositionText,
    });

    // Use centralized AI router with reasoning model for demand packages
    const aiResult = await callOpenAIText({
      system: "You generate carrier-ready insurance demand packages and return only valid JSON.",
      user: prompt,
      reasoningEffort: "high",
      temperature: 0.25,
      maxOutputTokens: 4000,
    });

    const rawContent = aiResult.text || "";

    let demandPackage: Record<string, unknown>;
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        demandPackage = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON object found in AI response");
      }
    } catch {
      throw new Error("Model returned invalid JSON");
    }

    const responsePayload = {
      success: true,
      claimId,
      generatedAt: new Date().toISOString(),
      inputSummary: {
        inspectionChars: inspectionText.length,
        estimateChars: estimateText.length,
        estimateLineCount: estimateLines.length,
        inspectionFileCount: inspectionFiles.length,
        estimateFileCount: estimateFiles.length,
      },
      demandPackage,
    };

    if (saveToMasterState && masterState?.id) {
      try {
        const currentState = (masterState.state_json as Record<string, any> | null) || {};
        const nextState = {
          ...currentState,
          demand_package: {
            generated_at: new Date().toISOString(),
            title: demandPackage?.title || "",
            subject_line: demandPackage?.subject_line || "",
            demand_amount: demandPackage?.demand_amount || "",
            executive_summary: demandPackage?.executive_summary || "",
            full_demand_package: demandPackage?.full_demand_package || "",
            strategic_notes: demandPackage?.strategic_notes || "",
            missing_evidence: demandPackage?.missing_evidence || [],
            confidence_score: demandPackage?.confidence_score || 0,
          },
        };
        await supabase.from("claim_master_state").update({ state_json: nextState, updated_at: new Date().toISOString() }).eq("id", masterState.id);
      } catch (saveError) {
        console.error("Failed saving demand package to master state", saveError);
      }
    }

    return json(responsePayload);
  } catch (error) {
    console.error("generate-demand-package error", error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
