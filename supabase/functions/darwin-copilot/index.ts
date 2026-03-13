import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

type CopilotMode = 'operational' | 'rebuttal' | 'estimate' | 'war_room' | 'training' | 'strategy';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    const { claimId, mode, userQuestion, conversationHistory } = await req.json();
    if (!claimId) throw new Error('claimId required');

    const copilotMode: CopilotMode = mode || 'operational';

    // Gather full claim intelligence in parallel — now includes timeline & estimate builder context
    const [
      claimRes, filesRes, estimateRes, photoRes, strategyRes, argsRes, 
      rebuttalsRes, deadlinesRes, outcomesRes, knowledgeRes, intelSummaryRes,
      timelineEventsRes, estimateLinesRes
    ] = await Promise.all([
      supabase.from('claims').select('*').eq('id', claimId).single(),
      supabase.from('claim_files').select('id, file_name, document_type, folder_key, created_at').eq('claim_id', claimId),
      supabase.from('claim_estimate_analysis').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(1),
      supabase.from('claim_photo_findings').select('*').eq('claim_id', claimId),
      supabase.from('claim_strategy_simulations').select('*').eq('claim_id', claimId).order('score', { ascending: false }),
      supabase.from('claim_argument_map').select('*').eq('claim_id', claimId),
      supabase.from('carrier_argument_rebuttals').select('*').eq('claim_id', claimId),
      supabase.from('claim_carrier_deadlines').select('*').eq('claim_id', claimId),
      supabase.from('claim_outcome_learning').select('*').ilike('carrier', `%${''}`).limit(10),
      supabase.from('ai_knowledge_chunks').select('content').limit(15),
      supabase.from('claim_intelligence_summary').select('*').eq('claim_id', claimId).maybeSingle(),
      // Timeline events with escalation/rebuttal flags
      supabase.from('claim_events').select('event_type, occurred_at, summary, importance_score, is_pinned, supports_escalation, supports_rebuttal, dispute_tag')
        .eq('claim_id', claimId).order('occurred_at', { ascending: true }).limit(100),
      // Estimate builder lines — top disputes and rebuttal-linked
      supabase.from('darwin_estimate_lines').select('description, quantity, unit_price, carrier_quantity, carrier_unit_price, variance_amount, reason_tag, rationale, used_in_rebuttal, recovery_impact_rank')
        .eq('claim_id', claimId).eq('is_accepted', true).order('recovery_impact_rank', { ascending: true }).limit(50),
    ]);

    const claim = claimRes.data;
    const carrier = claim?.insurance_company || 'Unknown';

    const { data: carrierOutcomes } = await supabase
      .from('claim_outcome_learning')
      .select('outcome, recovery_delta, winning_arguments, key_turning_point')
      .ilike('carrier', `%${carrier}%`)
      .limit(10);

    const intelSummary = intelSummaryRes.data;

    // Build timeline intelligence digest
    const timelineEvents = timelineEventsRes.data || [];
    const escalationEvents = timelineEvents.filter((e: any) => e.supports_escalation);
    const rebuttalTimelineEvents = timelineEvents.filter((e: any) => e.supports_rebuttal);
    const pinnedEvents = timelineEvents.filter((e: any) => e.is_pinned);
    const disputeTaggedEvents = timelineEvents.filter((e: any) => e.dispute_tag);

    const timelineIntel = {
      total_events: timelineEvents.length,
      milestones: timelineEvents.filter((e: any) => ['denial', 'denial_issued', 'payment', 'payment_received', 'payment_issued', 'legal_escalation', 'inspection', 'supplement'].includes(e.event_type)),
      escalation_support: escalationEvents.map((e: any) => ({ date: e.occurred_at?.split('T')[0], type: e.event_type, summary: e.summary })),
      rebuttal_support: rebuttalTimelineEvents.map((e: any) => ({ date: e.occurred_at?.split('T')[0], type: e.event_type, summary: e.summary })),
      pinned: pinnedEvents.map((e: any) => ({ date: e.occurred_at?.split('T')[0], type: e.event_type, summary: e.summary })),
      dispute_tagged: disputeTaggedEvents.map((e: any) => ({ date: e.occurred_at?.split('T')[0], type: e.event_type, summary: e.summary, dispute: e.dispute_tag })),
    };

    // Build estimate builder intelligence digest
    const estimateLines = estimateLinesRes.data || [];
    const topDisputes = estimateLines.filter((l: any) => l.recovery_impact_rank != null && l.recovery_impact_rank <= 5);
    const rebuttalLinkedLines = estimateLines.filter((l: any) => l.used_in_rebuttal);
    const totalDarwinRcv = estimateLines.reduce((s: number, l: any) => s + (Number(l.quantity) * Number(l.unit_price)), 0);
    const totalCarrierRcv = estimateLines.reduce((s: number, l: any) => s + (l.carrier_quantity != null ? Number(l.carrier_quantity) * Number(l.carrier_unit_price || 0) : 0), 0);

    const estimateIntel = {
      total_lines: estimateLines.length,
      darwin_rcv: totalDarwinRcv,
      carrier_rcv: totalCarrierRcv,
      total_variance: totalDarwinRcv - totalCarrierRcv,
      top_disputes: topDisputes.map((l: any) => ({
        description: l.description,
        darwin_amount: Number(l.quantity) * Number(l.unit_price),
        carrier_amount: l.carrier_quantity != null ? Number(l.carrier_quantity) * Number(l.carrier_unit_price || 0) : null,
        variance: Number(l.variance_amount || 0),
        reason: l.reason_tag,
        rationale: l.rationale,
      })),
      rebuttal_linked: rebuttalLinkedLines.map((l: any) => ({
        description: l.description,
        variance: Number(l.variance_amount || 0),
        reason: l.reason_tag,
        rationale: l.rationale,
      })),
    };

    const claimIntel = {
      claim,
      orchestrator_summary: intelSummary ? {
        most_important_issue: intelSummary.most_important_issue,
        strongest_evidence: intelSummary.strongest_evidence,
        largest_recovery_opportunity: intelSummary.largest_recovery_opportunity,
        carrier_weakest_argument: intelSummary.carrier_weakest_argument,
        recommended_next_action: intelSummary.recommended_next_action,
        missing_evidence: intelSummary.missing_evidence,
        confidence_score: intelSummary.confidence_score,
      } : null,
      files: (filesRes.data || []).length,
      estimate_analysis: estimateRes.data?.[0] || null,
      photo_findings: {
        total: (photoRes.data || []).length,
        by_type: {} as Record<string, number>,
        strong_evidence: (photoRes.data || []).filter((f: any) => f.evidence_strength === 'strong').length,
      },
      strategy_simulations: (strategyRes.data || []).slice(0, 3),
      carrier_arguments: (argsRes.data || []).length,
      rebuttals: (rebuttalsRes.data || []).length,
      deadlines: deadlinesRes.data || [],
      carrier_outcomes: carrierOutcomes || [],
      // NEW: cross-surface intelligence
      timeline_intelligence: timelineIntel,
      estimate_builder_intelligence: estimateIntel,
    };

    (photoRes.data || []).forEach((f: any) => {
      claimIntel.photo_findings.by_type[f.finding_type] = (claimIntel.photo_findings.by_type[f.finding_type] || 0) + 1;
    });

    const trainingKb = (knowledgeRes.data || []).map((c: any) => c.content).join('\n---\n').slice(0, 4000);

    const modeInstructions: Record<CopilotMode, string> = {
      operational: `Focus on claim operations: status, next steps, pending tasks, deadlines, missing documentation.`,
      rebuttal: `Focus on carrier arguments, contradictions, evidence gaps, and rebuttal strategies. Reference specific carrier positions and counter them. Use timeline events marked as rebuttal support and estimate lines marked as used in rebuttal as primary evidence anchors.`,
      estimate: `Focus on estimate gaps, supplement opportunities, pricing disparities, code upgrades, and O&P analysis. Reference the top 5 estimate disputes by recovery impact and explain why each matters.`,
      war_room: `Focus on strategic options: which strategy scores highest, predicted outcomes, risk levels, and recommended next moves based on cross-claim learning. Reference timeline milestones, escalation-flagged events, and top estimate disputes to explain which events and line items are driving strategy.`,
      training: `Reference training materials and knowledge base to educate the user on best practices, techniques, and approaches relevant to this claim scenario.`,
      strategy: `You are in CLAIM STRATEGY CONVERSATION mode. The user wants to reason through disputes step-by-step.

Your job is to be a senior claims strategist who:
- Evaluates carrier positions and identifies weaknesses in their arguments
- Suggests specific evidence needed and where to find it
- Proposes rebuttal paths with concrete language the user can adapt
- Explains policy interpretation in plain terms
- Drafts argument language when requested
- Identifies which timeline events and estimate line items support the strategy
- References cross-claim outcomes from similar carrier scenarios
- Cites internal claim evidence (photos, documents, estimates) by name when possible
- References external standards (building codes, manufacturer specs, industry practices) when relevant

Maintain a conversational, collaborative tone. Ask clarifying questions when the user's intent is ambiguous. Build on prior messages in this conversation. When proposing a strategy, explain WHY it works and what risks exist.`,
    };

    const orchestratorBrief = intelSummary ? `
DARWIN ORCHESTRATOR INTELLIGENCE (use this as your PRIMARY source — it synthesizes all layers):
- PRIORITY ISSUE: ${intelSummary.most_important_issue || 'Not computed'}
- CONFIDENCE: ${intelSummary.confidence_score || 0}%
- RECOMMENDED ACTION: ${JSON.stringify(intelSummary.recommended_next_action || {})}
- CARRIER WEAKNESS: ${JSON.stringify(intelSummary.carrier_weakest_argument || {})}
- RECOVERY OPPORTUNITY: ${JSON.stringify(intelSummary.largest_recovery_opportunity || {})}
- MISSING EVIDENCE: ${JSON.stringify(intelSummary.missing_evidence || [])}
- STRONGEST EVIDENCE: ${JSON.stringify(intelSummary.strongest_evidence || [])}
` : '';

    const timelineBrief = timelineIntel.total_events > 0 ? `
TIMELINE INTELLIGENCE (${timelineIntel.total_events} events):
- MILESTONES: ${timelineIntel.milestones.length} key milestones
- ESCALATION SUPPORT (${timelineIntel.escalation_support.length} events flagged): ${JSON.stringify(timelineIntel.escalation_support.slice(0, 5))}
- REBUTTAL SUPPORT (${timelineIntel.rebuttal_support.length} events flagged): ${JSON.stringify(timelineIntel.rebuttal_support.slice(0, 5))}
- PINNED EVENTS: ${JSON.stringify(timelineIntel.pinned.slice(0, 5))}
- DISPUTE-TAGGED: ${JSON.stringify(timelineIntel.dispute_tagged.slice(0, 5))}
When explaining strategy, CITE specific timeline events that support or undermine the position.
` : '';

    const estimateBrief = estimateIntel.total_lines > 0 ? `
ESTIMATE BUILDER INTELLIGENCE (${estimateIntel.total_lines} lines, $${estimateIntel.total_variance.toFixed(0)} total variance):
- DARWIN RCV: $${estimateIntel.darwin_rcv.toFixed(0)} vs CARRIER RCV: $${estimateIntel.carrier_rcv.toFixed(0)}
- TOP 5 DISPUTES: ${JSON.stringify(estimateIntel.top_disputes)}
- REBUTTAL-LINKED ITEMS (${estimateIntel.rebuttal_linked.length}): ${JSON.stringify(estimateIntel.rebuttal_linked)}
When explaining recovery opportunity, CITE specific line items and their variance amounts.
` : '';

    const systemPrompt = `You are Darwin Copilot — an embedded intelligence assistant for public adjusters.

MODE: ${copilotMode.toUpperCase()}
${modeInstructions[copilotMode]}

${orchestratorBrief}
${timelineBrief}
${estimateBrief}

CLAIM INTELLIGENCE:
${JSON.stringify(claimIntel, null, 2).slice(0, 8000)}

TRAINING KNOWLEDGE:
${trainingKb}

EVERY response MUST answer these 5 questions:
1. **What matters most right now?** — The single highest-priority item
2. **What is missing?** — Evidence, documents, or analysis gaps
3. **What should happen next?** — Specific actionable next step
4. **What is the carrier's weak point?** — Exploitable weakness in their position
5. **What action or letter does Darwin recommend NOW?** — Concrete deliverable

CROSS-SURFACE LINKAGE RULES:
- When recommending strategy, explain WHICH timeline events support it (by date and type)
- When discussing recovery, explain WHICH estimate line items drive the opportunity (by description and variance)
- When discussing rebuttals, reference both timeline events AND estimate items marked for rebuttal use
- Always connect timeline milestones to estimate disputes when both are relevant

If orchestrator intelligence is available, START with its priority issue and recommended action. Cite specific evidence.
Be direct, strategic, and cite specific evidence from the claim intelligence. Never use generic advice.
Format with clear headers and bullet points.`;

    const aiResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userQuestion || `Give me the full Darwin Copilot briefing for this claim in ${copilotMode} mode.` },
        ],
        stream: true,
      }),
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded, please try again shortly.' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: 'Credits required. Add funds in Settings → Workspace → Usage.' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`AI gateway error ${aiResp.status}`);
    }

    return new Response(aiResp.body, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' },
    });
  } catch (err: any) {
    console.error('darwin-copilot error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
