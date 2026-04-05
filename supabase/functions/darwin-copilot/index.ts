import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { callPerplexityResearch, runDarwinTask } from "../_shared/ai-router.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

type CopilotMode = 'operational' | 'rebuttal' | 'estimate' | 'war_room' | 'training' | 'strategy';

function getLatestUserTurn(userQuestion?: string, conversationHistory?: Array<{ role?: string; content?: string }>) {
  if (Array.isArray(conversationHistory)) {
    for (let i = conversationHistory.length - 1; i >= 0; i -= 1) {
      const msg = conversationHistory[i];
      if (msg?.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content.trim();
      }
    }
  }

  return (userQuestion || '').trim();
}

function isExplicitDraftOrActionRequest(message: string) {
  return /\b(?:draft|write|compose|prepare|generate|create|add|make|log)\b[\s\S]{0,40}\b(?:email|letter|message|note|task|todo|reminder|update|timeline entry|activity)\b|\b(?:email|letter|message|note|task|todo|reminder|update|timeline entry|activity)\b[\s\S]{0,20}\b(?:draft|write|compose|prepare|generate|create|add|make|log)\b/i.test(message);
}

function isAnalysisQuestion(message: string) {
  return /\b(?:how|what|why|explain|analy[sz]e|review|assess|rebut|respond|strategy|argument|weakness|weakest|next step|next move|denial|coverage|carrier position|contradiction|pressure|should we|what do you think)\b/i.test(message);
}

function startsWithActionConfirmation(message: string) {
  const prefix = (message || '').slice(0, 180);
  return /\b(?:note added|added note|task created|created task|task added|email drafted|draft created|reminder created|update added|queued for review|saved to|logged to|activity added)\b/i.test(prefix);
}

function looksLikeToolStyleFailure(message: string) {
  const prefix = (message || '').slice(0, 240);
  return /\b(?:no communications found matching|no emails found matching|no notes found matching|no tasks found matching|no activity found matching|no results found(?: matching)?|could not find any communications|searched .* but found nothing)\b/i.test(prefix);
}

function shouldExcludeAssistantHistory(message: string) {
  const trimmed = (message || '').trim();
  if (!trimmed) return true;
  return startsWithActionConfirmation(trimmed) || looksLikeToolStyleFailure(trimmed);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    // AI routing handled by _shared/ai-router.ts (OPENAI_API_KEY required)

    const { claimId, mode, userQuestion, conversationHistory } = await req.json();
    if (!claimId) throw new Error('claimId required');

    const copilotMode: CopilotMode = mode || 'operational';
    const latestUserTurn = getLatestUserTurn(userQuestion, conversationHistory);
    const explicitDraftOrActionRequest = isExplicitDraftOrActionRequest(latestUserTurn);
    const directAnswerOnlyTurn = isAnalysisQuestion(latestUserTurn) && !explicitDraftOrActionRequest;

    // ── Fetch calling user's profile for identity injection ──────────────
    let authorName: string | undefined;
    let authorTitle: string | undefined;
    try {
      const authHeader = req.headers.get('authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      if (token) {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        const { data: userData } = await userClient.auth.getUser(token);
        if (userData?.user?.id) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name, title')
            .eq('id', userData.user.id)
            .maybeSingle();
          if (profile?.full_name) authorName = profile.full_name;
          if (profile?.title) authorTitle = profile.title;
        }
      }
    } catch (profileErr) {
      console.warn('Could not fetch user profile for identity injection:', profileErr);
    }

    const authorIdentity = authorName
      ? `The author of all external communications is ${authorName}${authorTitle ? `, ${authorTitle}` : ''}. Write in their voice using first person.`
      : 'Write as if authored by the public adjuster or claims professional handling the claim.';

    // Gather full claim intelligence in parallel — now includes timeline, estimate builder, & regulatory context
    const [
      claimRes, filesRes, estimateRes, photoRes, strategyRes, argsRes, 
      rebuttalsRes, deadlinesRes, intelSummaryRes,
      timelineEventsRes, estimateLinesRes, feedbackRes, regulationsRes,
      claimUpdatesRes, emailsRes, docIntelRes, userNotesRes
    ] = await Promise.all([
      supabase.from('claims').select('*').eq('id', claimId).single(),
      supabase.from('claim_files').select('id, file_name, document_type, folder_key, created_at').eq('claim_id', claimId),
      supabase.from('claim_estimate_analysis').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(1),
      supabase.from('claim_photo_findings').select('*').eq('claim_id', claimId),
      supabase.from('claim_strategy_simulations').select('*').eq('claim_id', claimId).order('score', { ascending: false }),
      supabase.from('claim_argument_map').select('*').eq('claim_id', claimId),
      supabase.from('carrier_argument_rebuttals').select('*').eq('claim_id', claimId),
      supabase.from('claim_carrier_deadlines').select('*').eq('claim_id', claimId),
      supabase.from('claim_intelligence_summary').select('*').eq('claim_id', claimId).maybeSingle(),
      supabase.from('claim_events').select('event_type, occurred_at, summary, importance_score, is_pinned, supports_escalation, supports_rebuttal, dispute_tag')
        .eq('claim_id', claimId).order('occurred_at', { ascending: true }).limit(100),
      supabase.from('darwin_estimate_lines').select('description, quantity, unit_price, carrier_quantity, carrier_unit_price, variance_amount, reason_tag, rationale, used_in_rebuttal, recovery_impact_rank')
        .eq('claim_id', claimId).eq('is_accepted', true).order('recovery_impact_rank', { ascending: true }).limit(50),
      supabase.from('darwin_feedback_events').select('output_type, feedback_type, actual_outcome, actual_recovery_delta, feedback_detail')
        .eq('claim_id', claimId).order('created_at', { ascending: false }).limit(20),
      supabase.from('state_insurance_regulations').select('*').order('regulation_type'),
      supabase.from('claim_updates').select('update_type, content, created_at')
        .eq('claim_id', claimId).order('created_at', { ascending: false }).limit(20),
      supabase.from('emails').select('subject, body, recipient_name, recipient_type, sent_at')
        .eq('claim_id', claimId).order('sent_at', { ascending: false }).limit(15),
      // Document intelligence — extracted facts, denial reasons, coverage positions from all processed files
      supabase.from('claim_document_intelligence')
        .select('document_type, document_subtype, summary, coverage_position, denial_reasons, exclusions_cited, testing_performed, testing_missing, estimate_totals, scope_positions, contradictions, cause_of_loss, extracted_facts, code_references, manufacturer_references, confidence_score, sender, recipient')
        .eq('claim_id', claimId)
        .order('confidence_score', { ascending: false })
        .limit(30),
      // User notes for this claim context
      supabase.from('claim_updates').select('id, update_type, content, created_at, user_id')
        .eq('claim_id', claimId)
        .eq('update_type', 'note')
        .order('created_at', { ascending: false })
        .limit(30),
    ]);

    const claim = claimRes.data;
    const carrier = claim?.insurance_company || 'Unknown';
    const lossType = claim?.damage_type || claim?.loss_type || claim?.type_of_loss || '';
    const stateCode = claim?.state || '';
    const denialRationale = claim?.denial_reason || '';

    // ── Contextual cross-claim outcome learning ──────────────
    // Multi-dimensional query: carrier + loss_type + state for precise pattern matching
    const outcomeQueries = [
      // Exact match: carrier + loss type + state
      supabase.from('claim_outcome_learning')
        .select('outcome, recovery_delta, winning_arguments, key_turning_point, strategy_sequence, evidence_patterns, denial_rationale, loss_type, carrier, state_code, tags')
        .ilike('carrier', `%${carrier}%`)
        .ilike('loss_type', `%${lossType}%`)
        .limit(10),
      // Broader: carrier + state (different loss type)
      supabase.from('claim_outcome_learning')
        .select('outcome, recovery_delta, winning_arguments, key_turning_point, strategy_sequence, denial_rationale, loss_type, carrier, state_code')
        .ilike('carrier', `%${carrier}%`)
        .eq('state_code', stateCode)
        .limit(10),
      // Broadest: same loss type across all carriers
      lossType ? supabase.from('claim_outcome_learning')
        .select('outcome, recovery_delta, winning_arguments, key_turning_point, loss_type, carrier, state_code')
        .ilike('loss_type', `%${lossType}%`)
        .order('created_at', { ascending: false })
        .limit(10) : null,
    ].filter(Boolean);

    // ── Contextual knowledge base retrieval ──────────────
    // Build search terms from claim context for relevant KB chunks
    const kbSearchTerms = [carrier, lossType, stateCode, denialRationale, claim?.roof_material, claim?.construction_trade]
      .filter(Boolean).join(' ');

    const kbQueries = [
      // Priority 1: Manufacturer docs, standards, statutes
      supabase.from('ai_knowledge_chunks')
        .select('content, metadata')
        .or(`content.ilike.%${lossType}%,content.ilike.%${carrier}%,content.ilike.%${claim?.roof_material || 'n/a'}%`)
        .limit(20),
      // Priority 2: General relevant chunks
      supabase.from('ai_knowledge_chunks')
        .select('content, metadata')
        .order('created_at', { ascending: false })
        .limit(10),
    ];

    // ── Successful argument patterns retrieval ──────────────
    // Find rebuttals that received positive feedback or were used in won claims
    const argPatternQuery = supabase.from('carrier_argument_rebuttals')
      .select('argument_type, principle, carrier_ready_paragraph, what_proves_damage, why_different, confidence, citations, damage_mechanism, exclusion_invoked')
      .or(`claim_id.neq.${claimId}`)
      .gte('confidence', 70)
      .order('confidence', { ascending: false })
      .limit(15);

    // Execute all secondary queries in parallel
    const [outcomeResults, kbPriorityRes, kbGeneralRes, argPatternsRes] = await Promise.all([
      Promise.all(outcomeQueries.map((q: any) => q)),
      kbQueries[0],
      kbQueries[1],
      argPatternQuery,
    ]);

    // Deduplicate and merge outcome results by claim_id-like uniqueness
    const seenOutcomes = new Set<string>();
    const carrierOutcomes: any[] = [];
    for (const res of outcomeResults) {
      for (const o of (res?.data || [])) {
        const key = `${o.carrier}-${o.loss_type}-${o.outcome}-${o.recovery_delta}`;
        if (!seenOutcomes.has(key)) {
          seenOutcomes.add(key);
          carrierOutcomes.push(o);
        }
      }
    }

    // Merge and prioritize KB chunks — deduplicate by content hash
    const seenKbContent = new Set<string>();
    const prioritizedKbChunks: string[] = [];
    const categorizeChunk = (c: any) => {
      const meta = c.metadata || {};
      const cat = (meta.category || '').toLowerCase();
      // Prioritize manufacturer, standards, statutes, codes
      return ['manufacturer', 'standard', 'statute', 'code', 'regulation', 'technical'].some(t => cat.includes(t));
    };
    // Add priority chunks first
    for (const c of (kbPriorityRes.data || [])) {
      const hash = c.content.slice(0, 100);
      if (!seenKbContent.has(hash)) {
        seenKbContent.add(hash);
        if (categorizeChunk(c)) {
          prioritizedKbChunks.unshift(c.content); // high priority first
        } else {
          prioritizedKbChunks.push(c.content);
        }
      }
    }
    // Fill with general chunks
    for (const c of (kbGeneralRes.data || [])) {
      const hash = c.content.slice(0, 100);
      if (!seenKbContent.has(hash) && prioritizedKbChunks.length < 25) {
        seenKbContent.add(hash);
        prioritizedKbChunks.push(c.content);
      }
    }

    // Build argument pattern library
    const argPatterns = (argPatternsRes.data || []).map((r: any) => ({
      type: r.argument_type,
      principle: r.principle,
      paragraph: r.carrier_ready_paragraph?.slice(0, 300),
      proves_damage: r.what_proves_damage?.slice(0, 200),
      confidence: r.confidence,
      mechanism: r.damage_mechanism,
      exclusion: r.exclusion_invoked,
    }));

    // Feedback patterns for this claim
    const feedbackPatterns = (feedbackRes.data || []).reduce((acc: any, f: any) => {
      if (f.feedback_type === 'thumbs_up' || f.feedback_type === 'used_as_is') {
        acc.successful.push({ type: f.output_type, detail: f.feedback_detail });
      } else if (f.feedback_type === 'thumbs_down' || f.feedback_type === 'override') {
        acc.rejected.push({ type: f.output_type, detail: f.feedback_detail });
      }
      return acc;
    }, { successful: [], rejected: [] });

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

    // ── Timeline-based regulatory violation detection ──────────────
    const claimState = claim?.state_code || stateCode || '';
    const stateRegs = (regulationsRes.data || []).filter((r: any) => r.state_code === claimState);
    const detectedViolations: Array<{
      issue: string;
      regulation: string;
      citation: string;
      supporting_events: string[];
      recommended_action: string;
      severity: 'high' | 'medium' | 'low';
    }> = [];

    const deadlines = deadlinesRes.data || [];
    const lossDate = claim?.loss_date ? new Date(claim.loss_date) : null;
    const claimCreatedAt = claim?.created_at ? new Date(claim.created_at) : null;

    // Pattern 1: Delayed acknowledgment / response
    if (claimCreatedAt) {
      const firstCarrierResponse = timelineEvents.find((e: any) =>
        ['carrier_response', 'acknowledgment', 'carrier_contact', 'inspection_scheduled'].includes(e.event_type)
      );
      if (firstCarrierResponse) {
        const daysToRespond = Math.floor((new Date(firstCarrierResponse.occurred_at).getTime() - claimCreatedAt.getTime()) / 86400000);
        const ackReg = stateRegs.find((r: any) => r.regulation_type === 'acknowledgment' || r.regulation_title?.toLowerCase().includes('acknowledg'));
        const ackDeadlineDays = ackReg?.deadline_days || 15;
        if (daysToRespond > ackDeadlineDays) {
          detectedViolations.push({
            issue: `Carrier took ${daysToRespond} days to respond (${ackDeadlineDays}-day deadline)`,
            regulation: ackReg?.regulation_title || 'Acknowledgment deadline',
            citation: ackReg?.regulation_citation || 'State unfair claims settlement practices',
            supporting_events: [`Claim filed: ${claimCreatedAt.toISOString().split('T')[0]}`, `First response: ${firstCarrierResponse.occurred_at?.split('T')[0]}`],
            recommended_action: 'Cite delayed acknowledgment in regulatory complaint or demand letter',
            severity: daysToRespond > ackDeadlineDays * 2 ? 'high' : 'medium',
          });
        }
      } else {
        // No carrier response found at all
        const daysSinceFiled = Math.floor((Date.now() - claimCreatedAt.getTime()) / 86400000);
        if (daysSinceFiled > 15) {
          const ackReg = stateRegs.find((r: any) => r.regulation_type === 'acknowledgment' || r.regulation_title?.toLowerCase().includes('acknowledg'));
          detectedViolations.push({
            issue: `No carrier response detected — ${daysSinceFiled} days since claim filed`,
            regulation: ackReg?.regulation_title || 'Acknowledgment deadline',
            citation: ackReg?.regulation_citation || 'State unfair claims settlement practices',
            supporting_events: [`Claim filed: ${claimCreatedAt.toISOString().split('T')[0]}`, 'No acknowledgment event in timeline'],
            recommended_action: 'Send formal demand for acknowledgment citing regulatory deadline',
            severity: 'high',
          });
        }
      }
    }

    // Pattern 2: Missed carrier deadlines (from deadline tracking)
    for (const dl of deadlines) {
      if (dl.days_overdue && dl.days_overdue > 0) {
        const matchedReg = stateRegs.find((r: any) =>
          r.regulation_type === dl.deadline_type ||
          r.regulation_title?.toLowerCase().includes(dl.deadline_type?.toLowerCase() || '')
        );
        detectedViolations.push({
          issue: `${dl.deadline_type} deadline missed by ${dl.days_overdue} days`,
          regulation: matchedReg?.regulation_title || dl.deadline_type,
          citation: matchedReg?.regulation_citation || 'State claims handling regulation',
          supporting_events: [`Trigger: ${dl.trigger_date}`, `Deadline: ${dl.deadline_date}`, `Status: ${dl.status}`],
          recommended_action: dl.bad_faith_potential ? 'Document bad faith pattern — escalate to regulatory complaint' : 'Cite deadline violation in next carrier communication',
          severity: dl.bad_faith_potential ? 'high' : 'medium',
        });
      }
    }

    // Pattern 3: Denial without investigation
    const denialEvents = timelineEvents.filter((e: any) => ['denial', 'denial_issued'].includes(e.event_type));
    const investigationEvents = timelineEvents.filter((e: any) => ['inspection', 'investigation', 'site_visit', 'engineer_inspection'].includes(e.event_type));
    for (const denial of denialEvents) {
      const denialDate = new Date(denial.occurred_at);
      const priorInvestigation = investigationEvents.find((e: any) => new Date(e.occurred_at) < denialDate);
      if (!priorInvestigation) {
        const investReg = stateRegs.find((r: any) =>
          r.regulation_title?.toLowerCase().includes('investigation') || r.regulation_type === 'investigation'
        );
        detectedViolations.push({
          issue: 'Denial issued without documented investigation or inspection',
          regulation: investReg?.regulation_title || 'Duty to investigate',
          citation: investReg?.regulation_citation || 'Unfair claims settlement practices — failure to investigate',
          supporting_events: [`Denial date: ${denial.occurred_at?.split('T')[0]}`, 'No prior inspection or investigation event found in timeline'],
          recommended_action: 'Challenge denial on grounds of inadequate investigation — strong bad faith indicator',
          severity: 'high',
        });
      }
    }

    // Pattern 4: Unexplained payment gaps (payment much less than estimate)
    const paymentEvents = timelineEvents.filter((e: any) => ['payment', 'payment_received', 'payment_issued'].includes(e.event_type));
    if (paymentEvents.length > 0 && estimateIntel.darwin_rcv > 0 && estimateIntel.carrier_rcv > 0) {
      const gapRatio = estimateIntel.carrier_rcv / estimateIntel.darwin_rcv;
      if (gapRatio < 0.5) {
        const lowballReg = stateRegs.find((r: any) =>
          r.regulation_title?.toLowerCase().includes('settlement') || r.regulation_type === 'fair_settlement'
        );
        detectedViolations.push({
          issue: `Carrier payment represents only ${(gapRatio * 100).toFixed(0)}% of documented damage — potential lowball settlement`,
          regulation: lowballReg?.regulation_title || 'Fair settlement practices',
          citation: lowballReg?.regulation_citation || 'Unfair claims settlement — inadequate payment',
          supporting_events: [`Darwin RCV: $${estimateIntel.darwin_rcv.toFixed(0)}`, `Carrier RCV: $${estimateIntel.carrier_rcv.toFixed(0)}`, `Gap: $${estimateIntel.total_variance.toFixed(0)}`],
          recommended_action: 'Demand itemized explanation for payment shortfall — supplement or appraisal',
          severity: 'high',
        });
      }
    }

    // Pattern 5: Long delays between events (carrier inaction)
    const sortedEvents = [...timelineEvents].sort((a: any, b: any) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
    for (let i = 1; i < sortedEvents.length; i++) {
      const gap = (new Date(sortedEvents[i].occurred_at).getTime() - new Date(sortedEvents[i - 1].occurred_at).getTime()) / 86400000;
      if (gap > 30) {
        const delayReg = stateRegs.find((r: any) =>
          r.regulation_title?.toLowerCase().includes('delay') || r.regulation_type === 'prompt_handling'
        );
        detectedViolations.push({
          issue: `${Math.floor(gap)}-day gap in claim activity between events`,
          regulation: delayReg?.regulation_title || 'Prompt claims handling',
          citation: delayReg?.regulation_citation || 'State prompt handling requirements',
          supporting_events: [`Before: ${sortedEvents[i - 1].occurred_at?.split('T')[0]} (${sortedEvents[i - 1].event_type})`, `After: ${sortedEvents[i].occurred_at?.split('T')[0]} (${sortedEvents[i].event_type})`],
          recommended_action: 'Document delay pattern for regulatory leverage',
          severity: gap > 60 ? 'high' : 'low',
        });
      }
    }

    // ── Violation prioritization scoring ──────────────
    // Score each violation on 5 dimensions to surface strongest escalation points
    function scoreViolation(v: typeof detectedViolations[0]): number {
      let score = 0;
      // 1. Timeline evidence quality (more supporting events = stronger)
      score += Math.min(v.supporting_events.length * 8, 24);
      // 2. Clarity of statutory match (has real citation vs generic)
      if (v.citation && !v.citation.includes('State unfair') && !v.citation.includes('State claims') && !v.citation.includes('State prompt')) score += 20;
      else score += 5;
      // 3. Severity of conduct
      if (v.severity === 'high') score += 30;
      else if (v.severity === 'medium') score += 15;
      else score += 5;
      // 4. Days overdue / magnitude (extract from issue text)
      const daysMatch = v.issue.match(/(\d+)[- ]day/);
      if (daysMatch) {
        const days = parseInt(daysMatch[1]);
        score += Math.min(days / 3, 15); // cap at 15
      }
      const pctMatch = v.issue.match(/(\d+)%/);
      if (pctMatch) {
        const pct = parseInt(pctMatch[1]);
        if (pct < 50) score += 12; // large gap
      }
      // 5. Bad-faith potential (keywords)
      const badFaithKeywords = ['without investigation', 'no carrier', 'no acknowledgment', 'bad faith', 'lowball'];
      if (badFaithKeywords.some(k => v.issue.toLowerCase().includes(k) || v.recommended_action.toLowerCase().includes(k))) score += 15;
      return score;
    }

    // Score and sort violations
    const scoredViolations = detectedViolations.map(v => ({ ...v, _score: scoreViolation(v) }));
    scoredViolations.sort((a, b) => b._score - a._score);
    // Replace original array with scored order
    detectedViolations.length = 0;
    detectedViolations.push(...scoredViolations.map(({ _score, ...rest }) => rest));

    // Detect cumulative pattern: 3+ low/medium violations = systemic unfair handling
    const lowerViolations = scoredViolations.filter(v => v.severity !== 'high');
    const hasCumulativePattern = lowerViolations.length >= 3;
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

    // Build claim updates and email history digest
    const claimUpdates = (claimUpdatesRes.data || []).map((u: any) => ({
      type: u.update_type,
      content: (u.content || '').slice(0, 300),
      date: u.created_at ? new Date(u.created_at).toLocaleDateString() : 'Unknown',
    }));
    const emailHistory = (emailsRes.data || []).map((e: any) => ({
      subject: e.subject,
      recipient: e.recipient_name,
      recipient_type: e.recipient_type,
      date: e.sent_at ? new Date(e.sent_at).toLocaleDateString() : 'Unknown',
      body_preview: (e.body || '').slice(0, 200),
    }));

    // Build document intelligence digest — extracted facts from all processed files
    const docIntelligence = (docIntelRes.data || []).map((d: any) => ({
      type: d.document_type,
      subtype: d.document_subtype,
      summary: (d.summary || '').slice(0, 400),
      coverage_position: d.coverage_position,
      denial_reasons: d.denial_reasons,
      exclusions: d.exclusions_cited,
      testing_done: d.testing_performed,
      testing_missing: d.testing_missing,
      estimate_totals: d.estimate_totals,
      scope_positions: d.scope_positions,
      contradictions: d.contradictions,
      cause_of_loss: d.cause_of_loss,
      extracted_facts: d.extracted_facts,
      code_refs: d.code_references,
      manufacturer_refs: d.manufacturer_references,
      confidence: d.confidence_score,
      from: d.sender,
      to: d.recipient,
    }));

    // Build user notes digest
    const claimNotes = (userNotesRes.data || []).map((n: any) => ({
      content: (n.content || '').slice(0, 500),
      date: n.created_at ? new Date(n.created_at).toLocaleDateString() : 'Unknown',
    }));

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
      file_list: (filesRes.data || []).map((f: any) => ({ name: f.file_name, type: f.document_type, folder: f.folder_key })),
      document_intelligence: docIntelligence,
      estimate_analysis: estimateRes.data?.[0] || null,
      photo_findings: {
        total: (photoRes.data || []).length,
        by_type: {} as Record<string, number>,
        strong_evidence: (photoRes.data || []).filter((f: any) => f.evidence_strength === 'strong').length,
      },
      strategy_simulations: (strategyRes.data || []).slice(0, 3),
      carrier_arguments: (argsRes.data || []).map((a: any) => ({
        type: a.argument_type,
        text: (a.argument_text || '').slice(0, 300),
        category: a.argument_category,
        carrier_position: (a.carrier_position_summary || '').slice(0, 300),
        strength: a.strength_score,
        rebuttal_confidence: a.rebuttal_confidence,
        rebuttal_strategies: a.rebuttal_strategies,
        contradictions: a.contradictions,
        evidence_gaps: a.evidence_gaps,
      })),
      rebuttals: (rebuttalsRes.data || []).map((r: any) => ({
        type: r.argument_type,
        carrier_position: (r.carrier_position || '').slice(0, 300),
        principle: r.principle,
        what_proves_damage: (r.what_proves_damage || '').slice(0, 300),
        why_different: (r.why_different || '').slice(0, 300),
        carrier_ready_paragraph: (r.carrier_ready_paragraph || '').slice(0, 500),
        confidence: r.confidence,
        damage_mechanism: r.damage_mechanism,
        exclusion_invoked: r.exclusion_invoked,
      })),
      deadlines: deadlinesRes.data || [],
      carrier_outcomes: carrierOutcomes,
      argument_patterns_library: argPatterns.slice(0, 8),
      feedback_patterns: feedbackPatterns,
      claim_notes: claimNotes,
      // Cross-surface intelligence
      timeline_intelligence: timelineIntel,
      estimate_builder_intelligence: estimateIntel,
      // Communication history for client updates
      recent_updates: claimUpdates,
      recent_emails: emailHistory,
    };

    (photoRes.data || []).forEach((f: any) => {
      claimIntel.photo_findings.by_type[f.finding_type] = (claimIntel.photo_findings.by_type[f.finding_type] || 0) + 1;
    });

    // Build contextual KB digest — prioritized by relevance
    const trainingKb = prioritizedKbChunks.join('\n---\n').slice(0, 6000);

    // Build cross-claim outcome digest with win/loss patterns
    const outcomeDigest = carrierOutcomes.length > 0 ? (() => {
      const wins = carrierOutcomes.filter((o: any) => o.outcome === 'won' || o.outcome === 'settled');
      const losses = carrierOutcomes.filter((o: any) => o.outcome === 'lost' || o.outcome === 'denied');
      const avgRecovery = wins.length > 0
        ? wins.reduce((s: number, o: any) => s + (o.recovery_delta || 0), 0) / wins.length
        : 0;
      const winningArgs = wins.flatMap((o: any) => (o.winning_arguments || []).map((a: any) => a.argument_type || a.summary)).filter(Boolean);
      const turningPoints = wins.map((o: any) => o.key_turning_point).filter(Boolean);
      return {
        total_outcomes: carrierOutcomes.length,
        win_rate: ((wins.length / carrierOutcomes.length) * 100).toFixed(1),
        avg_recovery_delta: avgRecovery,
        common_winning_arguments: [...new Set(winningArgs)].slice(0, 5),
        key_turning_points: turningPoints.slice(0, 3),
        loss_patterns: losses.map((o: any) => o.denial_rationale).filter(Boolean).slice(0, 3),
      };
    })() : null;

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

EXTERNAL RESEARCH may be provided below. When it is, you MUST clearly separate sources in your response using these labels:
- **📋 Internal Claim Evidence** — facts from this claim's documents, photos, timeline, estimates
- **🔁 Darwin Cross-Claim Learning** — patterns and outcomes from prior similar claims
- **🌐 External Research** — industry standards, manufacturer guidance, statutes, regulations, or technical references from outside sources

When giving substantive strategic analysis, structure responses with a CARRIER PRESSURE MAP before the strategy:

1. **Claim Issue** — what is being disputed and why

2. **🎯 Carrier Pressure Map** — Identify the carrier's weakest points across five dimensions. For EACH dimension, provide:
   - A 🔴 High / 🟡 Moderate / 🟢 Low rating with a one-line explanation citing evidence
   - **→ Tactic:** one concise, actionable negotiation move
   - **→ Confidence: X%** — your confidence this tactic will succeed, derived from: (a) strength of internal claim evidence supporting it, (b) cross-claim outcome patterns for similar scenarios, (c) authority tier of corroborating external research — T1 sources provide full confidence uplift, T2 sources provide moderate uplift, T3 sources provide minimal uplift and should be noted as weak authority, (d) completeness of supporting documentation. Briefly note the primary driver AND authority tier when external research is used, e.g. "Confidence: 82% — strong photo evidence + [T1] IRC code support + 3 similar carrier reversals" or "Confidence: 58% — [T3] blog reference only, no manufacturer or code authority found"

   Dimensions:
   - **Policy Interpretation** — gaps, ambiguities, or misapplied exclusions in their coverage position
   - **Technical Contradictions** — inconsistencies between their adjuster findings, engineer reports, or scope vs. industry standards
   - **Evidence Leverage** — where our documentation (photos, measurements, timeline events) undermines their position
   - **Financial Exposure** — the dollar magnitude of disputed items and bad faith / regulatory risk
   - **Timeline / Delay Pressure** — missed statutory deadlines, delayed responses, or procedural violations (cite specific dates and regulations when applicable)

3. **Best Argument Path** — the strongest line of reasoning, explaining WHY the pressure map supports it
4. **Missing Evidence** — what would strengthen the position
5. **Recommended Next Move** — concrete actionable step

Only use this full structure when giving substantive strategic analysis. For quick follow-ups or drafting, respond naturally.

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

    // Build regulatory violation brief from timeline analysis — prioritized by strength score
    const regulatoryViolationBrief = detectedViolations.length > 0 ? `
REGULATORY VIOLATION ANALYSIS (${detectedViolations.length} violations detected — RANKED BY STRENGTH, strongest first):

TOP ESCALATION POINTS (surface these first in strategy recommendations):
${detectedViolations.slice(0, 3).map((v, i) => `★ ${i + 1}. [${v.severity.toUpperCase()}] ${v.issue}
   Regulation: ${v.regulation} (${v.citation})
   Evidence: ${v.supporting_events.join(' → ')}
   Action: ${v.recommended_action}
   WHY STRONGEST: ${v.severity === 'high' ? 'High-severity conduct violation' : 'Clear statutory match with documented evidence'}${v.issue.toLowerCase().includes('without investigation') || v.issue.toLowerCase().includes('no acknowledgment') ? ' — strong bad faith indicator' : ''}`).join('\n')}
${detectedViolations.length > 3 ? `
SECONDARY VIOLATIONS:
${detectedViolations.slice(3).map((v, i) => `${i + 4}. [${v.severity.toUpperCase()}] ${v.issue}
   Regulation: ${v.regulation} (${v.citation})
   Evidence: ${v.supporting_events.join(' → ')}`).join('\n')}` : ''}
${hasCumulativePattern ? `
⚠ CUMULATIVE PATTERN DETECTED: ${lowerViolations.length} individual violations (delayed responses, inactivity gaps, procedural lapses) collectively establish a PATTERN OF UNFAIR CLAIM HANDLING under state unfair claims settlement practices. When recommending escalation, explicitly frame these as a systemic pattern — not isolated incidents — as this significantly strengthens regulatory complaints and bad faith exposure.` : ''}

ESCALATION GUIDANCE:
- ${detectedViolations.filter(v => v.severity === 'high').length} HIGH severity violations detected — consider regulatory complaint (DOBI/DOI)
- In Strategy mode, LEAD with the top 3 strongest violations when recommending escalation and explain WHY each is a strong escalation point (evidence quality, statutory clarity, conduct severity)
- High-severity violations (missed deadlines, denial without investigation, no acknowledgment) are strong bad faith indicators
` : '';

    // Build continuous learning briefs
    const outcomeLearningBrief = outcomeDigest ? `
CROSS-CLAIM OUTCOME LEARNING (${outcomeDigest.total_outcomes} similar outcomes, ${outcomeDigest.win_rate}% win rate):
- AVG RECOVERY DELTA: $${outcomeDigest.avg_recovery_delta.toFixed(0)}
- WINNING ARGUMENT TYPES: ${outcomeDigest.common_winning_arguments.join(', ') || 'None recorded'}
- KEY TURNING POINTS: ${outcomeDigest.key_turning_points.join('; ') || 'None recorded'}
- COMMON LOSS PATTERNS: ${outcomeDigest.loss_patterns.join('; ') || 'None recorded'}
Use these patterns to inform strategy recommendations. When a winning argument type matches the current dispute, cite it with confidence.
` : '';

    const argPatternsBrief = argPatterns.length > 0 ? `
PROVEN ARGUMENT PATTERNS (${argPatterns.length} high-confidence rebuttals from similar disputes):
${argPatterns.slice(0, 5).map((a: any, i: number) => `${i + 1}. [${a.type}] ${a.principle} (confidence: ${a.confidence}%) — ${a.mechanism || 'general'}`).join('\n')}
When generating rebuttals, check if a proven argument pattern matches the current dispute type. Adapt the proven language rather than generating from scratch.
` : '';

    const feedbackBrief = (feedbackPatterns.successful.length > 0 || feedbackPatterns.rejected.length > 0) ? `
USER FEEDBACK PATTERNS FOR THIS CLAIM:
- SUCCESSFUL outputs (${feedbackPatterns.successful.length}): ${feedbackPatterns.successful.map((f: any) => f.type).join(', ')}
- REJECTED outputs (${feedbackPatterns.rejected.length}): ${feedbackPatterns.rejected.map((f: any) => `${f.type}: ${f.detail || 'no detail'}`).join('; ')}
Lean toward approaches that match successful patterns. Avoid repeating rejected approaches.
` : '';

    // Build document intelligence brief — extracted content from all processed files
    const docIntelBrief = docIntelligence.length > 0 ? `
DOCUMENT INTELLIGENCE (${docIntelligence.length} documents analyzed — extracted facts from denial letters, estimates, engineering reports, correspondence, and more):
${docIntelligence.map((d: any, i: number) => {
  const parts = [`${i + 1}. [${d.type}${d.subtype ? '/' + d.subtype : ''}] ${d.summary}`];
  if (d.coverage_position) parts.push(`   Coverage Position: ${JSON.stringify(d.coverage_position)}`);
  if (d.denial_reasons) parts.push(`   Denial Reasons: ${JSON.stringify(d.denial_reasons)}`);
  if (d.exclusions) parts.push(`   Exclusions Cited: ${JSON.stringify(d.exclusions)}`);
  if (d.contradictions) parts.push(`   Contradictions Found: ${JSON.stringify(d.contradictions)}`);
  if (d.testing_done) parts.push(`   Testing Performed: ${JSON.stringify(d.testing_done)}`);
  if (d.testing_missing) parts.push(`   Testing Missing: ${JSON.stringify(d.testing_missing)}`);
  if (d.estimate_totals) parts.push(`   Estimate Totals: ${JSON.stringify(d.estimate_totals)}`);
  if (d.scope_positions) parts.push(`   Scope Positions: ${JSON.stringify(d.scope_positions)}`);
  if (d.cause_of_loss) parts.push(`   Cause of Loss: ${d.cause_of_loss}`);
  if (d.extracted_facts) parts.push(`   Key Facts: ${JSON.stringify(d.extracted_facts)}`);
  if (d.code_refs) parts.push(`   Code References: ${JSON.stringify(d.code_refs)}`);
  if (d.manufacturer_refs) parts.push(`   Manufacturer References: ${JSON.stringify(d.manufacturer_refs)}`);
  if (d.from) parts.push(`   From: ${d.from}`);
  return parts.join('\n');
}).join('\n\n')}
This is your PRIMARY source for answering questions about what documents say, what the carrier argued, what the denial basis is, and what evidence exists. USE THIS DATA to answer questions directly.
` : '';

    // Build notes brief
    const notesBrief = claimNotes.length > 0 ? `
USER NOTES ON THIS CLAIM (${claimNotes.length} notes):
${claimNotes.map((n: any) => `[${n.date}] ${n.content}`).join('\n')}
These notes contain the adjuster's own observations, thoughts, and reminders. Reference them when relevant.
` : '';

    // Build a data availability summary so the AI knows EXACTLY what it has
    const dataAvailability = [
      docIntelligence.length > 0 ? `✅ ${docIntelligence.length} processed documents with extracted intelligence (denial reasons, coverage positions, contradictions, facts)` : '❌ No document intelligence extracted yet',
      (rebuttalsRes.data || []).length > 0 ? `✅ ${(rebuttalsRes.data || []).length} carrier argument rebuttals ready` : null,
      (argsRes.data || []).length > 0 ? `✅ ${(argsRes.data || []).length} carrier arguments mapped` : null,
      timelineEvents.length > 0 ? `✅ ${timelineEvents.length} timeline events` : null,
      estimateIntel.total_lines > 0 ? `✅ ${estimateIntel.total_lines} estimate lines ($${estimateIntel.total_variance.toFixed(0)} variance)` : null,
      emailHistory.length > 0 ? `✅ ${emailHistory.length} emails in history` : null,
      claimNotes.length > 0 ? `✅ ${claimNotes.length} adjuster notes` : null,
      carrierOutcomes.length > 0 ? `✅ ${carrierOutcomes.length} cross-claim outcome patterns` : null,
      detectedViolations.length > 0 ? `✅ ${detectedViolations.length} regulatory violations detected` : null,
      prioritizedKbChunks.length > 0 ? `✅ ${prioritizedKbChunks.length} knowledge base chunks` : null,
    ].filter(Boolean).join('\n');

    const turnBehaviorBrief = directAnswerOnlyTurn
      ? `CURRENT TURN RULE: The latest user message is an analysis/conversation request, not a create/save action request.
- Answer the user's question directly using the available claim intelligence.
- Do NOT create, add, log, queue, save, or pretend to create any note, task, reminder, activity, email, or update.
- Do NOT open with action confirmations like "Note added", "Task created", "Email drafted", or "Reminder created".
- If a note, task, or email would help, mention it only as an OPTIONAL follow-up after answering the question.`
      : explicitDraftOrActionRequest
        ? `CURRENT TURN RULE: The latest user message explicitly asks for a draft or action-style deliverable.
- Provide draft content only.
- Never claim it was saved, sent, logged, or created in the system.`
        : `CURRENT TURN RULE: Stay conversational and helpful. If the user asks for analysis, answer directly. If the user asks for a draft, provide a draft only.`;

    const systemPrompt = `You are Darwin Copilot — a senior claims strategist embedded alongside the public adjuster. You are their trusted colleague sitting right next to them, discussing the claim together to strengthen their case and decide next steps.

ABSOLUTE RULE — READ THIS FIRST:
You have ALREADY been given the claim's full intelligence below. Before you write ANYTHING, scan the data sections (DOCUMENT INTELLIGENCE, CARRIER ARGUMENTS, REBUTTALS, TIMELINE, ESTIMATES, EMAILS, NOTES) for relevant facts. Your response MUST reference specific data points — dates, dollar amounts, document names, denial reasons, carrier positions — from the intelligence provided. If you write a generic framework response without citing specific claim data, you have failed.

DATA YOU HAVE RIGHT NOW:
${dataAvailability}

${turnBehaviorBrief}

WHAT THIS MEANS:
- If document intelligence exists → you KNOW what the denial says, what exclusions were cited, what the carrier's position is. Quote it.
- If rebuttals exist → you ALREADY HAVE drafted rebuttal language. Reference and adapt it.
- If carrier arguments are mapped → you KNOW their specific arguments. Address each one.
- If timeline events exist → you KNOW the chronology. Cite specific dates.
- If emails exist → you KNOW what was communicated. Reference specific correspondence.
- NEVER say "I need to review the denial letter" or "the denial letter needs to be analyzed" when document intelligence already contains the denial reasons and exclusions.
- NEVER give a generic "framework" or "template" response. Every answer must be grounded in THIS claim's specific data.

You have access to everything: every document that has been processed, every email sent or received, every note the adjuster has written, the full timeline, estimates, carrier arguments, rebuttals, knowledge base materials, cross-claim learning from similar disputes, and live web research capabilities. Your knowledge does not stop at the internal database — you actively search for manufacturer specs, building codes, state regulations, case law, and industry standards to support the claim.

MODE: ${copilotMode.toUpperCase()}
${modeInstructions[copilotMode]}

${orchestratorBrief}
${docIntelBrief}
${notesBrief}
${outcomeLearningBrief}
${argPatternsBrief}
${feedbackBrief}
${timelineBrief}
${estimateBrief}
${regulatoryViolationBrief}

CLAIM INTELLIGENCE:
${JSON.stringify(claimIntel, null, 2).slice(0, 8000)}

COMMUNICATION HISTORY (use when drafting client updates, emails, or summarizing recent activity):
${claimUpdates.length > 0 ? `RECENT CLAIM UPDATES (${claimUpdates.length}):\n${claimUpdates.map((u: any) => `[${u.type}] ${u.date}: ${u.content}`).join('\n')}` : 'No claim updates recorded yet.'}
${emailHistory.length > 0 ? `\nRECENT EMAILS SENT (${emailHistory.length}):\n${emailHistory.map((e: any) => `${e.date} → ${e.recipient} (${e.recipient_type}): "${e.subject}" — ${e.body_preview}`).join('\n')}` : '\nNo emails sent yet.'}
${timelineEvents.length > 0 ? `\nTIMELINE ACTIVITY (${timelineEvents.length} events): Use these as the basis for client status updates even if no formal claim_updates exist.` : ''}

When asked to draft a client update email, use ALL available context: claim status, timeline events, recent emails, claim updates, deadlines, and any recent activity. Do NOT say there is "no update" unless the claim truly has zero data. Synthesize the claim's current position into a clear, reassuring update for the policyholder.

CRITICAL — ACTION EXECUTION PROHIBITION:
You are a reasoning and drafting assistant ONLY. You do NOT have the ability to create, save, add, queue, schedule, or send notes, tasks, reminders, emails, SMS, or any other records or communications. You MUST NEVER tell the user that a note "was added," a task "was created," or an email "was sent" unless the user is explicitly shown draft text and you clearly state it is ONLY a draft.
1. For notes, tasks, reminders, letters, or emails: present draft content in chat for review.
2. Clearly state that the content is a draft for review when the user explicitly asked for that deliverable.
3. NEVER imply that asking you to write something results in it being saved, created, logged, or delivered.
4. If the user asks an analysis question, answer it directly first instead of proposing or pretending to create records.
This is a strict compliance requirement — no exceptions.

KNOWLEDGE BASE (contextually retrieved — prioritized by relevance to this claim):
${trainingKb}

CONTINUOUS LEARNING RULES:
1. OUTCOME PATTERN MATCHING: When cross-claim outcomes show a high win rate for a specific argument type against this carrier, recommend that approach with explicit confidence citing the historical data.
2. ARGUMENT REUSE: When a proven argument pattern matches the current dispute type, adapt its language and cite it as a "proven approach from similar disputes."
3. FEEDBACK LOOP: If user feedback shows certain output types were rejected, adjust your approach. If outputs were used as-is, replicate that style.
4. KNOWLEDGE PRIORITY: When knowledge base contains manufacturer documents, standards, or statutes relevant to this claim, cite them as authoritative sources before falling back to general reasoning.
5. EVIDENCE HIERARCHY: Always prioritize (in order): (a) internal claim evidence, (b) cross-claim outcome patterns, (c) knowledge base documents, (d) external research findings.

${copilotMode === 'strategy' ? `In STRATEGY mode, you are conversational. Do NOT force the 5-question framework on every reply. Instead, answer the user's specific question directly. Cite internal evidence (documents, photos, timeline events, estimate lines) with specifics. Reference external standards when relevant. Propose concrete next steps only when appropriate. If drafting language, write it in a professional, carrier-ready tone. Ask follow-up questions to deepen the strategy discussion.

ARGUMENT PROVENANCE (required for all substantive strategy responses):
After presenting your recommended argument or strategy, close with a brief "Why this approach" paragraph (2-4 sentences) that names the primary driver from the retrieval hierarchy — claim file evidence, cross-claim outcomes, knowledge base authority, or external research — along with any supporting drivers. If a proven argument pattern was reused, mention it. If the recommendation relies on lower-priority sources only, note the gap. Write this like a senior strategist briefly explaining their reasoning, not a technical disclosure.` : `EVERY response must address these five areas naturally in prose form — do not use numbered lists or headers for them. Cover: what matters most right now, what evidence or documentation is missing, what should happen next, where the carrier's position is weakest, and what concrete action or deliverable Darwin recommends immediately.`}

EXTERNAL CONTENT WRITING RULES (apply to ALL modes when drafting letters, emails, rebuttals, explanations, or any content intended for external recipients):
1. AUTHORSHIP: ${authorIdentity} Never refer to Darwin, AI, or any automated system as the author or contributor. The reader must believe a human professional wrote this.
2. PLAIN TEXT: Use clean professional prose with paragraph formatting. Do NOT use bullet points (* - = •), emoji, markdown formatting (** # *), or any special symbols. Write in flowing narrative paragraphs.
3. TONE: Use professional claim-handling language appropriate for communication with carriers, contractors, attorneys, and regulators. Be assertive but composed.
4. SIGNATURE: When generating a letter or email, end with a neutral professional closing such as "Sincerely," or "Regards," followed by a blank line for the sender's name.${authorName ? ` Use "${authorName}${authorTitle ? `, ${authorTitle}` : ''}" as the signer.` : ' Never insert "Darwin" or any AI reference as the sender.'}
5. INTERNAL vs EXTERNAL: Structured formatting (headers, bullets, analysis frameworks) may be used for internal Copilot analysis responses. But when the user requests a draft letter, email, rebuttal, or explanation for external use, automatically convert to clean narrative prose with NO markdown, NO bullets, NO emoji.

CROSS-SURFACE LINKAGE RULES:
- When recommending strategy, explain WHICH timeline events support it (by date and type)
- When discussing recovery, explain WHICH estimate line items drive the opportunity (by description and variance)
- When discussing rebuttals, reference both timeline events AND estimate items marked for rebuttal use
- Always connect timeline milestones to estimate disputes when both are relevant

SOURCE PRIORITY WEIGHTING (apply when synthesizing answers from multiple retrieval sources):
When multiple sources are available, weight them in this strict priority order:
  Priority 1 (Highest): CLAIM-SPECIFIC FACTS — Documents, photos, estimates, timeline events, and communications from THIS claim. Ground truth that overrides all other sources.
  Priority 2: OFFICIAL STATUTES & REGULATIONS — State insurance codes, DOI rules, statutory deadlines, case law. Cite specific statute numbers.
  Priority 3: MANUFACTURER BULLETINS, BUILDING CODES & TECHNICAL STANDARDS — IRC/IBC codes, ASTM standards, manufacturer specs. For scope support only, never to deny coverage.
  Priority 4: INTERNAL KB & TRAINING MATERIALS — Organizational knowledge, cross-claim learning patterns.
  Priority 5 (Lowest): GENERAL WEB SOURCES — Industry articles, general guidance. Supplement only when higher-priority sources are insufficient.
When sources conflict, the higher-priority source wins. Lead with the strongest source and note supporting lower-priority sources afterward. If only lower-priority sources are available, explicitly note the absence of stronger authority.

If orchestrator intelligence is available, reference its priority issue and recommended action. Cite specific evidence.
Be direct, strategic, and cite specific evidence from the claim intelligence. Never use generic advice.

REMINDER: The ABSOLUTE RULE at the top of this prompt applies. Never give generic frameworks. Always cite specific claim data.

FORMATTING RULE: NEVER output icon placeholder tokens like [Scales Icon], [Document Icon], [Warning Icon], [Evidence Icon], [Clock Icon], or any bracket-wrapped icon references. These do not render in the UI. Use plain text headings instead (e.g. "Coverage Impact" not "[Scales Icon] COVERAGE IMPACT"). Emoji are acceptable for source labels (📋, 🔁, 🌐, 🎯) but bracketed icon tokens are strictly forbidden.

RESPONSE STYLE (MANDATORY — applies to ALL Copilot responses):
1. NATURAL PROSE: Write in short, clean paragraphs. Do NOT default to bullet points, numbered lists, headers, sections, or rigid formatting. Write like an experienced public adjuster explaining strategy in conversation, not an AI presenting a report.
2. NO SYMBOL FORMATTING: Do not use bullet symbols, asterisks, dashes as list markers, equals signs, markdown formatting (**, ##, *), or emoji in standard responses. All responses must be plain text paragraphs. Only use structured formatting if the user explicitly requests it.
3. CONCISE BY DEFAULT: Answer the question directly. Do not over-explain or repeat information. Expand only when the user asks for more detail or when complexity genuinely requires it.
4. SCANNABILITY: Achieve readability through spacing and sentence structure, not lists. Use 1-3 sentence paragraphs to keep responses easy to scan.
5. CONFIDENCE AND CLARITY: Lead with the most important insight first. Avoid filler language such as "it appears," "it seems," or overly cautious hedging unless genuinely warranted.
6. CONVERSATION COMPACTING: When the conversation thread is long, internally compress prior context into a concise working summary. Do not expose raw summaries to the user. Maintain continuity without overwhelming.
7. EXCEPTION: When the user explicitly asks for a list, outline, checklist, or structured format, you may use it. Otherwise, always default to natural prose.

TASK AND NOTE CREATION:
When the user asks you to create a task, note, or reminder, present it clearly in your response with a recommended title, description, due date, and priority. Tell the user you have outlined it for them and they can add it through the Tasks or Notes section. You cannot directly insert tasks or notes into the system, but you can draft them precisely so the user can add them quickly.

When the user asks you to draft an email, create a task, write a note, or plan next steps, treat it as a collaborative exercise. Present your draft, explain your reasoning, and ask if they want to adjust anything before finalizing.

YOUR ROLE AS A COLLEAGUE:
You are not a help desk. You are a senior colleague who happens to have perfect recall of every document, email, timeline event, and industry standard. When the adjuster asks you something, answer like you have the file open in front of you — because you do. Reference specific documents, dates, dollar amounts, and carrier positions by name. When you are uncertain, say so honestly and explain what additional information would resolve the uncertainty.`;

    // --- External research via Perplexity (available in ALL modes for comprehensive knowledge) ---
    let externalResearch = '';
    {
      const lastUserMsg = conversationHistory?.length
        ? conversationHistory[conversationHistory.length - 1]?.content
        : userQuestion;

      // Determine if external research would benefit this question
      const researchKeywords = ['code', 'standard', 'regulation', 'statute', 'manufacturer', 'spec', 'requirement', 'law', 'legal', 'building code', 'IRC', 'IBC', 'ASTM', 'warranty', 'installation', 'best practice', 'industry', 'rebut', 'deny', 'denial', 'coverage', 'exclusion', 'how to', 'what does', 'is it', 'can they', 'should I', 'precedent', 'case law'];
      const msgLower = (lastUserMsg || '').toLowerCase();
      const needsResearch = copilotMode === 'strategy' || copilotMode === 'rebuttal' || copilotMode === 'war_room' || researchKeywords.some(k => msgLower.includes(k));

      if (lastUserMsg && needsResearch) {
        try {
          const trade = claim?.construction_trade || claim?.trade || '';
          const materialType = claim?.roof_material || claim?.material_type || '';
          const disputeTopic = intelSummary?.most_important_issue || '';

          const queryTerms = [
            lastUserMsg,
            lossType && `${lossType} loss`,
            stateCode && `${stateCode} state`,
            carrier !== 'Unknown' && `carrier: ${carrier}`,
            trade && `trade: ${trade}`,
            materialType && `material: ${materialType}`,
            disputeTopic && `dispute: ${disputeTopic}`,
          ].filter(Boolean).join('. ');

          const researchQuery = `Insurance claim dispute research: ${queryTerms}. Focus on manufacturer installation standards, building codes, state insurance regulations, technical industry standards, and case law that apply.`;

          const research = await callPerplexityResearch({
            system: `You are a research assistant for insurance claim disputes and property restoration.

SOURCE TIER PRIORITIES — organize and weight your findings by these tiers:

TIER 1 (HIGHEST AUTHORITY — always prefer these):
- Manufacturer installation documentation and technical bulletins
- Building codes (IRC, IBC, ASTM, ASCE)
- State insurance regulatory guidance and statutes
- Legal analysis and case law
- Technical industry standards (NRCA, ARMA, SMACNA)

TIER 2 (STRONG SECONDARY):
- Insurance industry publications (NAIC, FC&S, ISO)
- Construction trade references and best practices
- Engineering or adjuster training materials

TIER 3 (SUPPLEMENTARY ONLY — use when Tier 1/2 unavailable):
- Contractor blogs and opinion articles
- Forums and community discussions
- General explanation articles

RULES:
- Always lead with Tier 1 sources when available
- Label each finding with its tier: [T1], [T2], or [T3]
- Cite specific document names, section numbers, or statute references
- If only Tier 3 sources exist, explicitly note "No authoritative (Tier 1/2) sources found"
- Be concise and factual. Always cite sources.`,
            user: researchQuery,
            temperature: 0.1,
            maxTokens: 2000,
          });

          if (research.text) {
            externalResearch = `\n\nEXTERNAL RESEARCH (from verified sources — cite with 🌐 label):
SOURCE TIER KEY: [T1] = Manufacturer docs, building codes, statutes, case law, technical standards (HIGHEST). [T2] = Industry publications, trade references, training materials. [T3] = Blogs, forums, general articles (LOWEST).
AUTHORITY RULES FOR SYNTHESIS:
1. PRESERVE [T1]/[T2]/[T3] tags in your response so the user can see the authority level of each finding.
2. In the 🌐 External Research section, list T1-backed findings FIRST, then T2, then T3.
3. If a T1 source contradicts a T3 source, the T1 source wins — discard the T3 finding.
4. If a recommendation or tactic relies PRIMARILY on T2 or T3 sources (no T1 support), you MUST:
   a. Explicitly state the authority gap, e.g. "⚠️ This finding is supported by [T2] industry publications; no manufacturer or code authority found."
   b. Reduce the associated Tactic Confidence by 10-25% compared to T1-backed tactics.
5. When computing Tactic Confidence percentages and overall strategic confidence, use authority tier as a direct input:
   - T1-backed evidence → full confidence weight
   - T2-only evidence → reduce confidence by ~15%
   - T3-only evidence → reduce confidence by ~25-30%
6. Clearly distinguish external research from internal claim evidence using the 📋/🌐 labels.

${research.text}`;
            if (research.citations.length > 0) {
              externalResearch += `\n\nSOURCES:\n${research.citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join('\n')}`;
            }

            // ── Research Memory: Store high-confidence T1 findings for future reuse ──
            const hasT1Content = research.text.includes('[T1]');
            if (hasT1Content) {
              try {
                const t1Sections = research.text.split('\n').filter((line: string) => line.includes('[T1]')).join('\n');
                if (t1Sections.length > 50) {
                  const researchTitle = `Research: ${carrier} - ${lossType || 'General'} - ${stateCode || 'National'}`;
                  const { data: researchDoc } = await supabase.from('ai_knowledge_documents').insert({
                    file_name: researchTitle,
                    file_path: `research-memory/${claimId}/${Date.now()}`,
                    file_type: 'text/plain',
                    category: 'research_memory',
                    status: 'completed',
                    description: `Auto-stored T1 research findings from strategy session. Carrier: ${carrier}, Loss: ${lossType}, State: ${stateCode}. Sources: ${research.citations.slice(0, 3).join(', ')}`,
                  }).select('id').single();

                  if (researchDoc?.id) {
                    const researchChunks = t1Sections.match(/.{1,600}/gs) || [t1Sections];
                    await supabase.from('ai_knowledge_chunks').insert(
                      researchChunks.map((chunk: string, idx: number) => ({
                        document_id: researchDoc.id,
                        content: `[Research Memory] ${researchTitle}\n${chunk}`,
                        chunk_index: idx,
                        metadata: {
                          category: 'research_memory',
                          carrier,
                          loss_type: lossType,
                          state: stateCode,
                          source_type: 'perplexity_t1',
                          citations: research.citations.slice(0, 5),
                          claim_id: claimId,
                        },
                      }))
                    );
                    console.log(`Stored ${researchChunks.length} T1 research chunks for future reuse`);
                  }
                }
              } catch (memErr) {
                console.warn('Research memory storage error (non-fatal):', memErr);
              }
            }
          }
        } catch (researchErr) {
          console.warn('External research error (non-fatal):', researchErr);
        }
      }
    }

    // Append external research to system prompt if available
    const finalSystemPrompt = externalResearch
      ? systemPrompt + externalResearch
      : systemPrompt;

    // Build messages: system prompt + conversation history OR single question
    const aiMessages: Array<{role: string; content: string}> = [
      { role: 'system', content: finalSystemPrompt },
    ];

    if (conversationHistory && Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      // Use full conversation history for multi-turn strategy conversations
      for (const msg of conversationHistory) {
        if (msg.role === 'assistant' && shouldExcludeAssistantHistory(msg.content || '')) {
          continue;
        }
        aiMessages.push({ role: msg.role, content: msg.content });
      }
    } else {
      aiMessages.push({
        role: 'user',
        content: userQuestion || `Give me the full Darwin Copilot briefing for this claim in ${copilotMode} mode.`,
      });
    }

    // Build the combined user prompt from conversation history
    const historyText = aiMessages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');

    const taskType = copilotMode === 'strategy' || copilotMode === 'war_room' || copilotMode === 'rebuttal'
      ? 'copilot_reasoning'
      : 'copilot_drafting';

    let ai = await runDarwinTask(
      taskType as any,
      finalSystemPrompt,
      historyText,
    );

    if (directAnswerOnlyTurn && (startsWithActionConfirmation(ai.text || '') || looksLikeToolStyleFailure(ai.text || ''))) {
      ai = await runDarwinTask(
        taskType as any,
        `${finalSystemPrompt}\n\nCORRECTION FOR THIS TURN: The user asked for analysis, not a system action or a search-status update. Rewrite the response as a direct, natural answer grounded in the claim evidence. Do NOT mention adding notes, creating tasks, drafting emails, logging activity, searching communications, or reporting that nothing was found. Use the claim intelligence already provided and answer the question.`,
        historyText,
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        response: ai.text,
        model: ai.model,
        strategyMode: copilotMode === 'strategy',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    );
  } catch (err: any) {
    console.error('darwin-copilot error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
