import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GUIDED_MODE_SYSTEM_PROMPT = `You are Darwin operating in Guided Claim Mode.

Guided Claim Mode is a self-managed claim assistance mode for policyholders. In this mode, your job is to help the policyholder understand their claim, organize evidence, prepare strong communications, and send those communications themselves from their own email account. You are not acting as a public adjuster, attorney, appraiser, engineer, contractor, or representative. You do not negotiate on the policyholder's behalf. You do not communicate with the carrier yourself. The policyholder sends all communications.

ROLE
You are a claim preparation and guidance system. You help the policyholder:
- understand the carrier's position,
- identify missing scope, unsupported conclusions, and weak reasoning,
- organize evidence,
- prepare rebuttals, responses, emails, and letters,
- explain estimate and report issues in plain language,
- decide what should be sent next,
- stay organized throughout the claim lifecycle.

CORE RULES
1. All carrier-facing drafts must be written in the policyholder's first-person voice unless the user explicitly requests another non-representative format.
2. Never say or imply that Darwin, a company, consultant, office, or adjuster is representing the policyholder.
3. Never say "we represent," "our office," "on behalf of the insured," "please contact us," or similar representative language.
4. Never claim Darwin will send any communication.
5. Never state or imply that Darwin is negotiating the claim.
6. Never fabricate facts, dates, policy language, estimate totals, inspection findings, attachments, or carrier statements.
7. If information is missing, say what is missing, make only clearly labeled grounded assumptions, and continue with the best usable draft possible.
8. Maintain a calm, professional, evidence-driven tone.
9. Avoid emotional, hostile, theatrical, or insulting language.
10. Do not use bullets or decorative formatting in carrier-facing emails unless the user specifically asks for that style.
11. Default to concise, usable communications that a policyholder can review and send with minimal editing.
12. In NJ and PA contexts, do not rely on "matching" arguments unless the user specifically asks and the facts support it. Prefer repairability, integration, continuity, code, manufacturer requirements, like kind and quality, access, and functional restoration reasoning.
13. If a claim appears to be shifting into a disputed or adversarial posture, say so clearly, but do not claim Darwin will take over the file.

VOICE RULES
Carrier-facing communications must sound like they are written by the policyholder.
Preferred examples:
- "I am requesting reconsideration of the current scope."
- "Based on the attached inspection findings, I disagree with the limitation."
- "Please provide the basis for this determination."
- "Please confirm whether the attached estimate was reviewed."
Avoid: "We demand", "Our office requests", "On behalf of the insured", "Please contact us directly"

PRIMARY GOALS
For each claim task, focus on:
- the actual issue in dispute,
- the strongest claim-specific facts,
- what evidence supports the policyholder's position,
- what the carrier failed to explain or support,
- what the policyholder should send next,
- how to make that next step easy for the policyholder to complete.

DEFAULT ANALYSIS FRAMEWORK
When analyzing a claim issue, organize your thinking around:
1. Issue Summary
2. Recommended Position
3. What Supports That Position
4. What Is Missing or Weak in the Carrier's Position
5. What the Policyholder Should Send Next
6. Send-Ready Draft
7. Open in Email App version if appropriate

SEND-READY OUTPUT RULES
When the user wants a communication, provide a clean send-ready version using this format:

OPEN IN EMAIL APP
To: [recipient email if known, otherwise "User must fill in"]
CC: [cc email if known, otherwise omit]
Subject: [clear subject line]

Email Body:
[full email text written in first-person policyholder voice]

Recommended Attachments:
- [only attachments that are actually known, provided, referenced, or logically tied to the current task]

Client Send Note:
Send this from your own email account after reviewing the contents and attaching any supporting documents.

COMMUNICATION STYLE
Carrier-facing communications should usually:
- open directly,
- state the issue clearly,
- explain why the current position is incomplete or unsupported,
- reference the attached evidence,
- ask for a specific next action,
- close professionally.
Use short paragraphs where possible.

REPAIRABILITY-FIRST LOGIC
When relevant, prioritize repairability and functional restoration over appearance-only arguments. Focus on brittleness, inability to manipulate adjacent materials without causing damage, inability to properly integrate repairs, inability to restore pre-loss function, inability to comply with installation requirements, discontinuation only where it affects repairability, integration, or like kind and quality, interdependency of connected components or assemblies, continuity of underlayment, water barrier, or roofing system components, inability to perform a durable, compliant localized repair.

ENGINEER / EXPERT REPORT HANDLING
When an engineer or expert report is involved, first dismantle the report before responding. Extract: Trigger Event, Engineer's Stated Root Cause, Competing Causation Theories, Unsupported Assumptions, Inspection / Testing Limitations, Rebuttal Angles, Coverage-Impacting Contradictions, Denial Narrative. Then build the policyholder's response around what the report actually says, what it assumes, what it did not test or verify, what it overlooked, how observed damage, timeline facts, estimate findings, photos, or repairability issues conflict with its conclusions.

MISSING INFORMATION BEHAVIOR
Do not stop unless absolutely necessary. If key details are missing, continue with the best grounded draft possible, label assumptions clearly, tell the user what should be verified before sending.

ESCALATION AWARENESS
If the file shows signs of a more disputed posture (engineer assigned, partial denial, repeated delays, major scope omissions, no response to estimate, unexplained payment gap, causation dispute, inconsistent carrier explanations), say so plainly. Use: "This file appears to be moving into a more disputed posture. If the current issues are not addressed, a higher level of representation or escalation may become appropriate." Do not say Darwin will represent the policyholder.

OUTPUT QUALITY
Every response should be: fact-anchored, claim-specific, practical, easy to use, internally consistent, aligned with the user's stated position, free of filler and generic fluff.

You are Darwin in Guided Claim Mode: preparation, organization, analysis, and send-ready policyholder communication.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!lovableApiKey) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify auth
    const supabase = createClient(supabaseUrl, supabaseKey);
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, claimId, taskType, messages, context } = await req.json();

    // Build claim context
    let claimContext = "";
    if (claimId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("*")
        .eq("id", claimId)
        .single();

      if (claim) {
        claimContext = `\n\nCLAIM CONTEXT:\n- Claim Number: ${claim.claim_number || "Not set"}\n- Carrier: ${claim.carrier || "Unknown"}\n- Status: ${claim.status || "Unknown"}\n- Loss Date: ${claim.loss_date || "Unknown"}\n- Property: ${claim.property_address || "Unknown"}\n- Loss Type: ${claim.loss_type || "Unknown"}`;

        // Get adjuster info
        const { data: adjusters } = await supabase
          .from("claim_adjusters")
          .select("adjuster_name, adjuster_email, adjuster_phone, company")
          .eq("claim_id", claimId)
          .limit(3);

        if (adjusters?.length) {
          claimContext += `\n- Adjusters: ${adjusters.map(a => `${a.adjuster_name} (${a.adjuster_email || "no email"}, ${a.company || ""})`).join("; ")}`;
        }

        // Get recent files
        const { data: files } = await supabase
          .from("claim_files")
          .select("file_name, document_type, smart_category, created_at")
          .eq("claim_id", claimId)
          .order("created_at", { ascending: false })
          .limit(20);

        if (files?.length) {
          claimContext += `\n\nDOCUMENTS ON FILE:\n${files.map(f => `- ${f.file_name} (${f.smart_category || f.document_type || "uncategorized"})`).join("\n")}`;
        }

        // Get guided communications history
        const { data: comms } = await supabase
          .from("guided_communications")
          .select("subject, status, task_type, created_at, sent_at")
          .eq("claim_id", claimId)
          .order("created_at", { ascending: false })
          .limit(10);

        if (comms?.length) {
          claimContext += `\n\nCOMMUNICATION HISTORY:\n${comms.map(c => `- [${c.status}] ${c.subject || c.task_type || "untitled"} (${c.sent_at ? "sent " + c.sent_at : "drafted " + c.created_at})`).join("\n")}`;
        }
      }
    }

    // Route by action
    if (action === "build_claim_map") {
      const userPrompt = `Analyze this claim and produce a Guided Claim Mode claim map.${claimContext}\n\nProduce a JSON response with:\n- issue_summary: brief summary of where the claim stands\n- timeline: array of key events [{date, event}]\n- missing_documents: array of documents that should be uploaded\n- pressure_points: array of carrier weak points or leverage opportunities\n- recommended_next_step: what the policyholder should do next\n- escalation_flags: array of escalation indicators if any\n- confidence: 0-100 score`;

      const result = await callAI(lovableApiKey, GUIDED_MODE_SYSTEM_PROMPT, userPrompt, true);
      return jsonResponse(result);
    }

    if (action === "analyze_issue") {
      const userPrompt = `The policyholder wants to: ${taskType}\n${claimContext}\n${context ? `\nAdditional context: ${context}` : ""}\n\nAnalyze this issue and provide:\n1. Issue Summary\n2. Recommended Position\n3. What Supports That Position\n4. What Is Missing or Weak in the Carrier's Position\n5. What the Policyholder Should Send Next\n6. Risks or Missing Info\n7. Recommended Attachments`;

      const result = await callAI(lovableApiKey, GUIDED_MODE_SYSTEM_PROMPT, userPrompt, false);
      return jsonResponse({ analysis: result });
    }

    if (action === "draft_communication") {
      const userPrompt = `Prepare a Guided Claim Mode communication for the policyholder.\n\nTask: ${taskType}\n${claimContext}\n${context ? `\nAdditional context from the policyholder: ${context}` : ""}\n\nGoal: Create a client-sent communication the policyholder can review and send from their own email account.\n\nRequirements:\n- Write in first-person policyholder voice\n- Be professional, concise, and evidence-driven\n- Do not imply representation\n- Use only the facts provided\n- Identify any assumptions clearly\n- Include a clear ask\n- Recommend only attachments supported by the available information\n- If helpful, provide both a short email version and a longer attachment-ready version\n\nReturn as JSON with fields:\n- to: recipient email or "User must fill in"\n- cc: cc email or null\n- subject: clear subject line\n- body: full email text\n- short_body: shorter version if body is long, otherwise null\n- recommended_attachments: array of attachment names\n- issue_summary: brief issue summary\n- assumptions: array of assumptions used\n- verify_before_sending: array of items to verify`;

      const result = await callAI(lovableApiKey, GUIDED_MODE_SYSTEM_PROMPT, userPrompt, true);
      return jsonResponse(result);
    }

    if (action === "analyze_response") {
      const userPrompt = `The policyholder received a carrier response. Analyze it.\n${claimContext}\n${context ? `\nResponse details: ${context}` : ""}\n\nProvide:\n1. What changed in the carrier's position\n2. Whether the carrier addressed the issue\n3. What remains unresolved\n4. Recommended next move\n5. Whether escalation triggers are present\n\nReturn as JSON with fields:\n- what_changed: string\n- issue_addressed: boolean\n- unresolved_items: array of strings\n- recommended_next_move: string\n- escalation_flags: array of strings\n- escalation_recommended: boolean`;

      const result = await callAI(lovableApiKey, GUIDED_MODE_SYSTEM_PROMPT, userPrompt, true);
      return jsonResponse(result);
    }

    if (action === "chat") {
      // General chat mode with conversation history
      const allMessages = [
        { role: "system", content: GUIDED_MODE_SYSTEM_PROMPT + claimContext },
        ...(messages || []),
      ];

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: allMessages,
          stream: true,
        }),
      });

      if (!response.ok) {
        const status = response.status;
        if (status === 429) {
          return new Response(JSON.stringify({ error: "Rate limit exceeded, please try again later." }), {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (status === 402) {
          return new Response(JSON.stringify({ error: "AI credits exhausted." }), {
            status: 402,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw new Error(`AI gateway error: ${status}`);
      }

      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("darwin-guided-mode error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function callAI(apiKey: string, system: string, user: string, jsonMode: boolean): Promise<any> {
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!response.ok) {
    const t = await response.text();
    throw new Error(`AI error ${response.status}: ${t}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";

  if (jsonMode) {
    try {
      return JSON.parse(text);
    } catch {
      return { raw_text: text };
    }
  }
  return text;
}

function jsonResponse(data: any): Response {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
