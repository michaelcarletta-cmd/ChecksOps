import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { callPerplexityResearch, runDarwinTask } from "../_shared/ai-router.ts";
import { getClaimsContextBundle, formatContextBundle } from "../_shared/ai/claimsKnowledgeEngine.ts";
import { analyzeDocument, formatDismantlerForPrompt, reconstructDismantlerFromRow, type DismantlerResult } from "../_shared/ai/universalDismantler.ts";
import { detectDismantlerAction, executeDismantlerAction } from "../_shared/ai/dismantlerActions.ts";
import {
  COPILOT_ABSOLUTE_RULE,
  COPILOT_DATA_INTERPRETATION,
  COPILOT_ROLE_PREAMBLE,
  COPILOT_ACTION_PROHIBITION,
  COPILOT_LEARNING_RULES,
  COPILOT_CROSS_SURFACE_LINKAGE,
  COPILOT_SOURCE_PRIORITY,
  COPILOT_FORMATTING_RULES,
  COPILOT_TASK_AND_NOTE_CREATION,
  COPILOT_COLLEAGUE_ROLE,
  COPILOT_REMINDER_AND_CITATIONS,
  copilotExternalWritingRules,
  copilotModeTail,
} from "../_shared/ai/copilotPromptBlocks.ts";
import {
  getLatestUserTurn,
  isExplicitDraftOrActionRequest,
  isSmsDraftRequest,
  isEmailDraftRequest,
  humanizeClaimText,
  summarizeStructuredValue,
  isDraftClarificationResponse,
  isAskingForClarification,
  containsForbiddenDraftPhrase,
  buildDeterministicClientDraft,
  isAnalysisQuestion,
  isDismantleRequest,
  startsWithActionConfirmation,
  looksLikeToolStyleFailure,
  shouldExcludeAssistantHistory,
  hasUsableDocumentIntel,
  asksForDocumentReupload,
  givesGenericFrameworkResponse,
  isGarbageTextInline,
  inlineOcrFromStorage,
  getClientFirstName,
  stripLeadingDateTag,
  collapseWhitespace,
  hasMeaningfulValue,
  isLikelyTechnicalPdfSummary,
  type DraftFacts,
} from "../_shared/ai/copilotHelpers.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

type CopilotMode = 'operational' | 'rebuttal' | 'estimate' | 'war_room' | 'training' | 'strategy' | 'draft' | 'search_web' | 'search_argue';

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
    const isSmsDraft = isSmsDraftRequest(latestUserTurn);
    const isEmailDraft = isEmailDraftRequest(latestUserTurn);
    const isDraftGeneration = isSmsDraft || isEmailDraft;

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
      supabase.from('claim_files').select('id, file_name, document_type, file_path, file_type, folder_id, uploaded_at').eq('claim_id', claimId),
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
        .select('claim_file_id, document_type, document_subtype, summary, coverage_position, denial_reasons, exclusions_cited, testing_performed, testing_missing, estimate_totals, scope_positions, contradictions, cause_of_loss, extracted_facts, code_references, manufacturer_references, confidence_score, sender, recipient')
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
    // NOTE: estimateIntel is computed below after violation patterns; use raw estimate data here
    const _estLines = estimateLinesRes.data || [];
    const _darwinRcv = _estLines.reduce((s: number, l: any) => s + (Number(l.quantity) * Number(l.unit_price)), 0);
    const _carrierRcv = _estLines.reduce((s: number, l: any) => s + (l.carrier_quantity != null ? Number(l.carrier_quantity) * Number(l.carrier_unit_price || 0) : 0), 0);
    const _totalVariance = _darwinRcv - _carrierRcv;
    const paymentEvents = timelineEvents.filter((e: any) => ['payment', 'payment_received', 'payment_issued'].includes(e.event_type));
    if (paymentEvents.length > 0 && _darwinRcv > 0 && _carrierRcv > 0) {
      const gapRatio = _carrierRcv / _darwinRcv;
      if (gapRatio < 0.5) {
        const lowballReg = stateRegs.find((r: any) =>
          r.regulation_title?.toLowerCase().includes('settlement') || r.regulation_type === 'fair_settlement'
        );
        detectedViolations.push({
          issue: `Carrier payment represents only ${(gapRatio * 100).toFixed(0)}% of documented damage — potential lowball settlement`,
          regulation: lowballReg?.regulation_title || 'Fair settlement practices',
          citation: lowballReg?.regulation_citation || 'Unfair claims settlement — inadequate payment',
          supporting_events: [`Darwin RCV: $${_darwinRcv.toFixed(0)}`, `Carrier RCV: $${_carrierRcv.toFixed(0)}`, `Gap: $${_totalVariance.toFixed(0)}`],
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

    const claimFiles = filesRes.data || [];
    const claimFileNamesById = new Map(claimFiles.map((f: any) => [f.id, f.file_name]));
    const likelyDenialFiles = claimFiles.filter((f: any) => /coverage decision|reservation of rights|\bdenial\b|\bror\b/i.test(f.file_name || ''));

    // Build document intelligence digest — extracted facts from all processed files
    const rawDocIntelligence = (docIntelRes.data || []).map((d: any) => ({
      file_name: d.claim_file_id ? claimFileNamesById.get(d.claim_file_id) || null : null,
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
    const docIntelligence = rawDocIntelligence.filter((d: any) => hasUsableDocumentIntel(d));
    const unusableDocIntelCount = rawDocIntelligence.length - docIntelligence.length;

    // ── FALLBACK: When document intelligence is empty/unusable, extract text from claim files ──
    // Uses garbage detection + inline OCR via vision AI as last resort
    // Wrapped in a 12-second timeout to prevent the entire function from timing out
    let rawTextFallbackBrief = '';
    if (docIntelligence.length === 0 && claimFiles.length > 0) {
      console.log(`[Copilot Fallback] No usable document intelligence — attempting text extraction for ${claimFiles.length} files`);
      const priorityFileIds = likelyDenialFiles.map((f: any) => f.id);
      const otherFileIds = claimFiles
        .filter((f: any) => !priorityFileIds.includes(f.id))
        .map((f: any) => f.id);
      // Focus on denial files first — limit to 3 to avoid timeout
      const fileIdsToFetch = [...priorityFileIds, ...otherFileIds].slice(0, 3);
      console.log(`[Copilot Fallback] Fetching text for ${fileIdsToFetch.length} files (${priorityFileIds.length} priority)`);

      if (fileIdsToFetch.length > 0) {
        // Hard timeout: abort entire fallback block after 12s so the AI call can still run
        const fallbackStart = Date.now();
        const FALLBACK_TIMEOUT_MS = 12000;

        const { data: rawTextRows, error: rawTextError } = await supabase
          .from('claim_files')
          .select('id, file_name, file_path, file_type, extracted_text, clean_text, text_quality_status')
          .in('id', fileIdsToFetch);

        if (rawTextError) {
          console.error('[Copilot Fallback] Error fetching file text:', rawTextError);
        }

        const textEntries: string[] = [];

        for (const r of (rawTextRows || [])) {
          // Check timeout before each file
          if (Date.now() - fallbackStart > FALLBACK_TIMEOUT_MS) {
            console.warn('[Copilot Fallback] Timeout reached — skipping remaining files');
            break;
          }

          const bestText = (r.clean_text || r.extracted_text || '').trim();
          const isGarbage = !bestText || bestText.length < 50 || isGarbageTextInline(bestText) || r.text_quality_status === 'unusable';
          console.log(`[Copilot Fallback] File "${r.file_name}": textLen=${bestText.length}, quality=${r.text_quality_status}, isGarbage=${isGarbage}`);

          if (!isGarbage && bestText.length >= 50) {
            // Good text available — use it
            const truncated = bestText.slice(0, 5000);
            textEntries.push(`--- FILE: ${r.file_name} ---\n${truncated}${bestText.length > 5000 ? '\n[...truncated]' : ''}`);
          } else if (r.file_path && (r.file_type?.includes('pdf') || r.file_name?.toLowerCase().endsWith('.pdf'))) {
            // Text is garbage or missing — attempt inline OCR via vision AI
            // But only if we have enough time budget left (need >=5s for OCR)
            if (Date.now() - fallbackStart > FALLBACK_TIMEOUT_MS - 5000) {
              console.warn(`[Copilot Fallback] Skipping OCR for "${r.file_name}" — insufficient time budget`);
              continue;
            }
            console.log(`[Copilot Fallback] Attempting inline OCR for "${r.file_name}"`);
            try {
              const ocrText = await inlineOcrFromStorage(supabase, r.file_path, r.file_name);
              if (ocrText && ocrText.length > 100) {
                const truncated = ocrText.slice(0, 5000);
                textEntries.push(`--- FILE: ${r.file_name} (OCR extracted) ---\n${truncated}${ocrText.length > 5000 ? '\n[...truncated]' : ''}`);
                // Persist the good OCR text back to claim_files for future use
                await supabase.from('claim_files').update({
                  clean_text: ocrText.substring(0, 100000),
                  text_quality_status: 'fair',
                  needs_reprocessing: false,
                }).eq('id', r.id);
                console.log(`[Copilot Fallback] OCR success for "${r.file_name}" — ${ocrText.length} chars, persisted`);
              } else {
                console.warn(`[Copilot Fallback] OCR returned insufficient text for "${r.file_name}" (${ocrText?.length || 0} chars)`);
              }
            } catch (ocrErr) {
              console.warn(`[Copilot Fallback] OCR failed for "${r.file_name}":`, ocrErr);
            }
          }
        }

        console.log(`[Copilot Fallback] Final text entries: ${textEntries.length} (elapsed ${Date.now() - fallbackStart}ms)`);

        if (textEntries.length > 0) {
          rawTextFallbackBrief = `
RAW DOCUMENT TEXT (extracted directly from claim files — structured intelligence pipeline has not processed these yet):

${textEntries.join('\n\n')}

CRITICAL: This raw text contains the actual content of denial letters, coverage decisions, and other claim documents. READ IT CAREFULLY to find denial reasons, exclusions cited, coverage positions, and key facts. Answer the user's question directly using this text. Do NOT say you need to review the documents — the text is RIGHT HERE.
`;
        } else {
          // No text could be extracted from any file — be honest about it
          const missingFileNames = (rawTextRows || []).map((r: any) => r.file_name).join(', ');
          rawTextFallbackBrief = `
DOCUMENT TEXT STATUS: UNAVAILABLE
The following claim files exist but their text content could not be extracted or recovered: ${missingFileNames}.
This is likely because the physical files were lost from storage and need to be re-uploaded by the user.

CRITICAL INSTRUCTION: Do NOT pretend you can analyze documents you cannot see. Do NOT give generic frameworks about "what we need to do." Instead:
1. State clearly that the denial letter content is not available for analysis.
2. Tell the user the specific files that need to be re-uploaded: ${likelyDenialFiles.map((f: any) => f.file_name).join(', ')}.
3. Then provide whatever analysis you CAN based on the claim metadata (loss description, carrier name, claim status, timeline, notes) that IS available.
`;
        }
      }
    }

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
      files: claimFiles.length,
      file_list: claimFiles.map((f: any) => ({ name: f.file_name, type: f.document_type, folder: f.folder_id })),
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
      draft: `Focus on drafting content. No live web search unless explicitly forced. Use existing claim context to produce drafts efficiently.`,
      search_web: `Search the web for relevant information. This mode is handled by a dedicated handler.`,
      search_argue: `Search the web and build a claim-focused argument. This mode is handled by a dedicated handler.`,
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

    const claimFileAvailabilityBrief = likelyDenialFiles.length > 0 ? `
ATTACHED CLAIM FILES RELEVANT TO THIS QUESTION:
${likelyDenialFiles.map((f: any) => `- ${f.file_name}`).join('\n')}
These files already exist on the claim. NEVER ask the user to provide, upload, paste, or re-send the contents of files that are already attached here. If extracted intelligence from one of these files is incomplete or unusable, say that briefly and continue answering from the other claim evidence you do have.
` : '';

    // Build document intelligence brief — extracted content from all processed files
    const docIntelBrief = docIntelligence.length > 0 ? `
DOCUMENT INTELLIGENCE (${docIntelligence.length} documents analyzed — extracted facts from denial letters, estimates, engineering reports, correspondence, and more):
${docIntelligence.map((d: any, i: number) => {
  const parts = [`${i + 1}. [${d.file_name || d.type}${d.subtype ? '/' + d.subtype : ''}] ${d.summary}`];
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
      docIntelligence.length > 0 ? `✅ ${docIntelligence.length} processed documents with usable extracted intelligence (denial reasons, coverage positions, contradictions, facts)` : rawTextFallbackBrief ? `⚠️ No structured document intelligence, but RAW TEXT from ${claimFiles.length} files is available below — read it carefully` : '❌ No usable document intelligence extracted yet',
      likelyDenialFiles.length > 0 ? `✅ ${likelyDenialFiles.length} denial-related files are attached to the claim` : null,
      unusableDocIntelCount > 0 ? `⚠️ ${unusableDocIntelCount} extracted document entries appear unusable/technical and should NOT be treated as reviewed claim facts` : null,
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

${COPILOT_ABSOLUTE_RULE}

DATA YOU HAVE RIGHT NOW:
${dataAvailability}

${turnBehaviorBrief}

${COPILOT_DATA_INTERPRETATION}

${COPILOT_ROLE_PREAMBLE}

MODE: ${copilotMode.toUpperCase()}
${modeInstructions[copilotMode]}

${orchestratorBrief}
${claimFileAvailabilityBrief}
${docIntelBrief}
${rawTextFallbackBrief}
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

${COPILOT_ACTION_PROHIBITION}

KNOWLEDGE BASE (contextually retrieved — prioritized by relevance to this claim):
${trainingKb}

${COPILOT_LEARNING_RULES}

${copilotModeTail(copilotMode)}

${copilotExternalWritingRules({ authorIdentity, authorName, authorTitle })}

${COPILOT_CROSS_SURFACE_LINKAGE}

${COPILOT_SOURCE_PRIORITY}

${COPILOT_REMINDER_AND_CITATIONS}

${COPILOT_FORMATTING_RULES}

${COPILOT_TASK_AND_NOTE_CREATION}

${COPILOT_COLLEAGUE_ROLE}`;

    // ── Search + Argue / Search the Web early handler ──────────────
    if (copilotMode === 'search_web' || copilotMode === 'search_argue') {
      const trade = claim?.construction_trade || claim?.trade || '';
      const materialType = claim?.roof_material || claim?.material_type || '';
      const disputeTopic = intelSummary?.most_important_issue || '';

      // Build targeted Tavily query from claim context
      const searchTerms = [
        latestUserTurn,
        lossType && `${lossType} loss`,
        stateCode && `${stateCode} state`,
        carrier !== 'Unknown' && carrier,
        trade && trade,
        materialType && materialType,
      ].filter(Boolean).join('. ');

      const tavilyQuery = `Insurance claim dispute: ${searchTerms}. Focus on manufacturer standards, building codes, state regulations, technical standards.`;

      let allSources: Array<{ title: string; url: string; content: string }> = [];
      let searchAnswer = '';
      let searchCount = 0;

      try {
        const { searchTavily } = await import("../_shared/ai/tavily.ts");

        // Search 1: basic
        const res1 = await searchTavily(tavilyQuery, "basic");
        searchCount++;
        if (res1) {
          searchAnswer = res1.answer || '';
          allSources = [...(res1.sources || [])];
        }

        // If results are weak (<2 sources or no answer), run one refined search
        if (allSources.length < 2 || !searchAnswer) {
          const refinedQuery = `${latestUserTurn} ${carrier !== 'Unknown' ? carrier : ''} ${stateCode} insurance regulation standard`;
          const res2 = await searchTavily(refinedQuery, "basic");
          searchCount++;
          if (res2) {
            if (!searchAnswer && res2.answer) searchAnswer = res2.answer;
            for (const s of (res2.sources || [])) {
              if (!allSources.some(x => x.url === s.url)) allSources.push(s);
            }
          }
        }
      } catch (searchErr) {
        console.warn('[Search+Argue] Tavily search failed:', searchErr);
      }

      // Trim to max 5 sources
      const trimmedSources = allSources.slice(0, 5);
      const sourceRefs = trimmedSources.map((s, i) => ({ title: s.title, url: s.url }));

      // Search the Web mode: return research summary only
      if (copilotMode === 'search_web') {
        let summaryText = searchAnswer || 'No relevant results found.';
        if (trimmedSources.length > 0) {
          summaryText += '\n\nKey findings from sources:\n' + trimmedSources.map((s, i) => `[${i + 1}] ${s.title}: ${s.content.slice(0, 150)}`).join('\n');
        }
        return new Response(JSON.stringify({
          ok: true,
          response: summaryText,
          model: 'tavily-search',
          usedSearch: true,
          cached: false,
          sources: sourceRefs,
          searchCount,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
      }

      // Search + Argue mode: build argument from claim facts + research
      const sourcesContext = trimmedSources.map((s, i) =>
        `[${i + 1}] ${s.title} (${s.url})\n${s.content.slice(0, 120)}`
      ).join('\n\n');

      // Detect argument style from user prompt
      const promptLower = latestUserTurn.toLowerCase();
      let argStyle = 'concise strategic argument';
      if (/\brebuttal\b/.test(promptLower)) argStyle = 'rebuttal';
      else if (/\bemail\b/.test(promptLower)) argStyle = 'professional email';
      else if (/\bdemand\b/.test(promptLower)) argStyle = 'demand paragraph';
      else if (/\btalking point/.test(promptLower)) argStyle = 'talking points';
      else if (/\bstrategy\s*memo\b|\bmemo\b/.test(promptLower)) argStyle = 'strategy memo';

      const isStrongOutput = ['rebuttal', 'demand paragraph', 'strategy memo'].includes(argStyle);

      const argSystemPrompt = `You are Darwin Copilot — a senior claims strategist producing a ${argStyle} for an insurance claim dispute.

PROMPT PRIORITY (STRICT ORDER — never let lower-priority content override higher):
1. CLAIM FACTS (highest priority — ground truth from this claim)
2. DECLARED POSITION (the adjuster's strategic stance)
3. USER REQUEST
4. EXTERNAL RESEARCH (supporting context only)

=== CLAIM FACTS ===
Carrier: ${carrier}
Loss Type: ${lossType || 'Unknown'}
State: ${stateCode || 'Unknown'}
Trade: ${trade || 'Unknown'}
Material: ${materialType || 'Unknown'}
Denial Rationale: ${denialRationale || 'None documented'}
${intelSummary ? `Priority Issue: ${intelSummary.most_important_issue || 'N/A'}
Carrier Weakness: ${JSON.stringify(intelSummary.carrier_weakest_argument || {})}
Recovery Opportunity: ${JSON.stringify(intelSummary.largest_recovery_opportunity || {})}` : ''}
${docIntelBrief ? docIntelBrief.slice(0, 3000) : ''}
${estimateBrief ? estimateBrief.slice(0, 1500) : ''}
=== END CLAIM FACTS ===

${claim?.declared_position ? `=== DECLARED POSITION ===\n${JSON.stringify(claim.declared_position)}\n=== END DECLARED POSITION ===` : ''}

=== EXTERNAL RESEARCH (supporting context only — do not restate unless necessary) ===
Key Findings: ${searchAnswer || 'No findings available'}

Sources:
${sourcesContext || 'No sources available'}
=== END RESEARCH ===

RULES:
- Professional, firm, strategic tone
- NO hallucinated statutes, policy language, or technical claims
- Use external support ONLY if actually backed by sources above
- Tie every argument back to THIS dispute's specific facts
- Do NOT drift into generic educational writing
- If sources are weak, acknowledge it and still produce the best limited argument possible
- ${authorIdentity}

OUTPUT FORMAT: Produce a JSON object with these fields:
{
  "answer": "short explanation of what was found in research (2-3 sentences)",
  "argument": "the full ${argStyle} text"
}
Return ONLY valid JSON, no markdown fences.`;

      const { generate } = await import("../_shared/ai/generate.ts");
      const argResult = await generate({
        task: isStrongOutput ? 'rebuttal' : 'copilot_reasoning',
        system: argSystemPrompt,
        user: latestUserTurn,
        claimId,
        forceStrong: isStrongOutput,
        searchMode: 'off', // search already done above
        jsonMode: true,
        maxTokens: isStrongOutput ? 4000 : 2500,
      });

      // Parse JSON response
      let answer = '';
      let argument = '';
      try {
        const jsonText = argResult.text.replace(/```json\s*|\s*```/g, '').trim();
        const parsed = JSON.parse(jsonText);
        answer = parsed.answer || '';
        argument = parsed.argument || argResult.text;
      } catch {
        // If JSON parse fails, use raw text
        argument = argResult.text;
        answer = searchAnswer;
      }

      const displayText = argument
        ? `${answer ? answer + '\n\n---\n\n' : ''}${argument}`
        : answer || 'Unable to generate argument from available sources.';

      return new Response(JSON.stringify({
        ok: true,
        response: displayText,
        model: argResult.model,
        usedSearch: true,
        cached: argResult.cached,
        sources: sourceRefs,
        searchCount,
        promptHash: argResult.promptHash,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    // --- External research via Perplexity (available in ALL modes for comprehensive knowledge) ---
    let externalResearch = '';
    {
      const lastUserMsg = conversationHistory?.length
        ? conversationHistory[conversationHistory.length - 1]?.content
        : userQuestion;

      // Determine if external research would benefit this question
      const researchKeywords = ['code', 'standard', 'regulation', 'statute', 'manufacturer', 'spec', 'requirement', 'law', 'legal', 'building code', 'IRC', 'IBC', 'ASTM', 'warranty', 'installation', 'best practice', 'industry', 'rebut', 'deny', 'denial', 'coverage', 'exclusion', 'how to', 'what does', 'is it', 'can they', 'should I', 'precedent', 'case law'];
      const msgLower = (lastUserMsg || '').toLowerCase();
      const needsResearch = copilotMode !== 'draft' && (copilotMode === 'strategy' || copilotMode === 'rebuttal' || copilotMode === 'war_room' || researchKeywords.some(k => msgLower.includes(k)));

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
                          source_type: 'tavily_t1',
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

    // ── Claims Knowledge Engine — additive context enrichment ──
    let knowledgeContext = '';
    try {
      const bundle = await getClaimsContextBundle({
        claimId,
        userQuery: latestUserTurn,
        taskType: copilotMode === 'strategy' || copilotMode === 'war_room' || copilotMode === 'rebuttal' ? 'copilot_reasoning' : 'copilot_drafting',
        supabase,
      });
      knowledgeContext = formatContextBundle(bundle);
      if (knowledgeContext) {
        console.log(`[Copilot] Knowledge Engine injected: dispute=${bundle.disputeType}, knowledge=${bundle.retrievalMeta.knowledgeCount}, lessons=${bundle.retrievalMeta.lessonsCount}, search=${bundle.retrievalMeta.usedSearch}`);
      }
    } catch (e) {
      console.error('[Copilot] Knowledge Engine error (non-fatal):', e);
    }

    // ── Universal Dismantler — retrieve existing dismantler intelligence or trigger on demand ──
    let dismantlerContext = '';
    try {
      // Always check for existing dismantler results for this claim
      const { data: dismantlerResults } = await supabase
        .from('claim_document_dismantlers')
        .select('document_type, source_file_name, report_summary, main_position, non_covered_theories, limitations, unsupported_assumptions, contradictions, omissions, repairability_overreach, coverage_weaknesses, strongest_rebuttal_points, evidence_to_gather_next, draft_rebuttal_language, chunk_count, successful_chunks, failed_chunks, model, cached, used_search')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .limit(3);

      if (dismantlerResults && dismantlerResults.length > 0) {
        const dismantlerDigest = dismantlerResults.map((d: any) => formatDismantlerForPrompt(reconstructDismantlerFromRow(d))).join('\n\n');
        dismantlerContext = dismantlerDigest;
        console.log(`[Copilot] Dismantler intelligence injected: ${dismantlerResults.length} document analyses`);
      }

      // If user explicitly asks to dismantle and we have file text, trigger on-demand analysis
      if (isDismantleRequest(latestUserTurn) && !dismantlerResults?.length) {
        // Try to find the most relevant file with extracted text
        const { data: relevantFiles } = await supabase
          .from('claim_files')
          .select('id, file_name, extracted_text, clean_text')
          .eq('claim_id', claimId)
          .order('uploaded_at', { ascending: false })
          .limit(5);

        const targetFile = (relevantFiles || []).find((f: any) => {
          const text = (f.clean_text || f.extracted_text || '').trim();
          return text.length >= 100;
        });

        if (targetFile) {
          const docText = (targetFile.clean_text || targetFile.extracted_text || '').trim();
          console.log(`[Copilot] Triggering on-demand dismantler for "${targetFile.file_name}" (${docText.length} chars)`);
          try {
            const result = await analyzeDocument({
              claimId,
              documentText: docText.slice(0, 50000),
              fileId: targetFile.id,
              fileName: targetFile.file_name,
              supabase,
            });
            dismantlerContext = formatDismantlerForPrompt(result);
            console.log(`[Copilot] On-demand dismantler complete: ${result.strongestRebuttalPoints.length} rebuttal points`);
          } catch (dismantleErr) {
            console.warn('[Copilot] On-demand dismantler failed (non-fatal):', dismantleErr);
          }
        }
      }
    } catch (e) {
      console.error('[Copilot] Dismantler context error (non-fatal):', e);
    }

    // ── Dismantler Action Layer — detect if user wants an actionable output ──
    const detectedAction = detectDismantlerAction(latestUserTurn);
    if (detectedAction && dismantlerContext) {
      try {
        console.log(`[Copilot] Dismantler action detected: ${detectedAction}`);
        const actionResult = await executeDismantlerAction(detectedAction, {
          claimId,
          userInstruction: latestUserTurn,
          supabase,
        });
        console.log(`[Copilot] Dismantler action complete: ${detectedAction}, model=${actionResult.model}`);

        // Return the action output directly as the copilot response
        return new Response(
          JSON.stringify({
            response: actionResult.content,
            model: actionResult.model,
            cached: actionResult.cached,
            dismantlerAction: detectedAction,
            sourceDocumentType: actionResult.sourceDocumentType,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      } catch (actionErr) {
        console.warn(`[Copilot] Dismantler action failed (falling through to normal flow):`, actionErr);
      }
    }

    // Append external research, knowledge context, and dismantler context to system prompt
    const finalSystemPrompt = (knowledgeContext ? knowledgeContext + '\n\n' : '') +
      (dismantlerContext ? dismantlerContext + '\n\n' : '') +
      systemPrompt +
      (externalResearch || '');

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

    // Skip the general AI call entirely for draft requests — go straight to structured draft generation
    let ai: any = { text: '', model: '' };
    if (!isDraftGeneration) {
      ai = await runDarwinTask(
        taskType as any,
        finalSystemPrompt,
        historyText,
      );
    }

    // Check response quality — catch generic frameworks, icon tokens, conditional evasion, etc.
    const responseText = ai.text || '';
    const failsQualityCheck = !isDraftGeneration && (
      startsWithActionConfirmation(responseText) ||
      looksLikeToolStyleFailure(responseText) ||
      asksForDocumentReupload(responseText) ||
      givesGenericFrameworkResponse(responseText) ||
      isAskingForClarification(responseText)
    );

    // Also strip icon tokens from ANY response (even passing ones)
    if (ai.text) {
      ai.text = ai.text.replace(/\[(?:Scales|Arrow|Magnifying Glass|Receipt|Document|Warning|Evidence|Clock|Shield|Flag|Lightbulb|Check)\s*Icon\]/gi, '');
    }

    if (failsQualityCheck) {
      console.log('[Copilot Retry] Response failed quality check — retrying with stronger grounding instruction');
      ai = await runDarwinTask(
        taskType as any,
        `${finalSystemPrompt}\n\nCRITICAL CORRECTION FOR THIS TURN: Your previous response was rejected because it gave a generic framework, used conditional speculation ("if they are citing..."), or deferred to future analysis instead of analyzing the actual claim data NOW.

WHAT YOU MUST DO NOW:
1. Look at the DOCUMENT INTELLIGENCE, RAW DOCUMENT TEXT, CARRIER ARGUMENTS, and REBUTTALS sections in your context above.
2. If denial reasons, exclusions, or coverage positions are listed there — QUOTE THEM and analyze them directly.
3. If raw document text is provided — READ IT and extract the denial reasons, exclusions cited, and carrier position yourself.
4. If no document content is available at all — say so honestly in ONE sentence, then answer using whatever other claim evidence IS available (timeline, emails, notes, estimate data).
5. If you genuinely have NO claim data at all — state this clearly and explain what specific documents need to be uploaded and processed.

BANNED PATTERNS (these will cause rejection):
- "We need to review/analyze/determine..." — you already have the data or you don't
- "If they are citing..." / "If the carrier is denying based on..." — state what IS happening, not hypotheticals
- "Could you please specify..." / "I need more clarification..." / "Which note are you referring to..." — NEVER ask the user to clarify. USE the data provided in the system context.
- Bullet point lists or numbered steps that just describe future work
- [Icon] tokens like [Scales Icon] or [Arrow Icon] — use plain text
- Generic insurance advice not tied to THIS claim's specific facts

START your response with a specific fact from the claim data (a denial reason, an exclusion, a dollar amount, a date). If no such fact exists in your context, say "The denial letter content has not been extracted yet" and proceed with available evidence.`,
        historyText,
      );
      // Strip icon tokens from retry too
      if (ai.text) {
        ai.text = ai.text.replace(/\[(?:Scales|Arrow|Magnifying Glass|Receipt|Document|Warning|Evidence|Clock|Shield|Flag|Lightbulb|Check)\s*Icon\]/gi, '');
      }
      // If retry STILL asks for clarification, replace with a grounded response
      if (isAskingForClarification(ai.text || '')) {
        console.log('[Copilot Retry] Retry still asks for clarification — using claim data summary');
        const updates = claimUpdates.slice(0, 3).map((u: any) => `• [${u.date}] ${u.content}`).join('\n');
        const emails = emailHistory.slice(0, 3).map((e: any) => `• [${e.date}] ${e.subject}`).join('\n');
        const notes = claimNotes.slice(0, 3).map((n: any) => `• [${n.date}] ${n.content}`).join('\n');
        ai.text = `Here's what I found in the claim file:\n\n**Recent Activity:**\n${updates || 'No recent updates logged.'}\n\n**Recent Emails:**\n${emails || 'No emails logged.'}\n\n**Recent Notes:**\n${notes || 'No notes logged.'}\n\nCurrent status: ${humanizeClaimText(claim?.status, 'Unknown')}. Next action: ${summarizeStructuredValue(intelSummary?.recommended_next_action, 'Review claim file and determine next steps.')}.`;
      }
    }

    // ── Structured draft generation for SMS/Email ──────────────
    if (isDraftGeneration) {
      const draftType = isSmsDraft ? 'sms' : 'email';
      
      // Extract facts from claim context
      const lastContactDate = emailHistory.length > 0 ? emailHistory[0].date : null;
      const lastContactRecipient = emailHistory.length > 0 ? emailHistory[0].recipient : null;
      const lastContactSubject = emailHistory.length > 0 ? emailHistory[0].subject : null;
      const latestNote = claimNotes.length > 0 ? claimNotes[0] : null;
      const latestUpdate = claimUpdates.length > 0 ? claimUpdates[0] : null;

      const extractedFacts = {
        claim_number: claim?.claim_number || claim?.carrier_claim_number || 'N/A',
        property_address: [claim?.property_address, claim?.property_city, claim?.property_state].filter(Boolean).join(', ') || 'N/A',
        carrier: carrier,
        claim_status: humanizeClaimText(claim?.status, 'Unknown'),
        loss_type: lossType || 'N/A',
        loss_date: claim?.loss_date ? new Date(claim.loss_date).toLocaleDateString() : 'N/A',
        last_contact_date: lastContactDate || 'No recent contact',
        last_contact_with: lastContactRecipient || 'N/A',
        last_contact_subject: lastContactSubject || 'N/A',
        latest_note: latestNote ? `[${latestNote.date}] ${latestNote.content}` : 'No notes',
        latest_update: latestUpdate ? `[${latestUpdate.date}] ${latestUpdate.content}` : 'No updates',
        next_action: summarizeStructuredValue(intelSummary?.recommended_next_action, 'Review claim and determine next steps'),
        pending_deadlines: deadlines.filter((d: any) => d.status === 'pending' || d.status === 'approaching')
          .map((d: any) => `${d.deadline_type}: ${d.deadline_date}`),
        has_correspondence: emailHistory.length > 0,
        has_notes: claimNotes.length > 0,
      };

      const clientDisplayName = claim?.policyholder_name || claim?.customer_name || 'the client';
      const deterministicDraft = buildDeterministicClientDraft({
        draftType,
        clientName: clientDisplayName,
        facts: extractedFacts,
      });
      const hasDraftSourceData = extractedFacts.has_correspondence || extractedFacts.has_notes || extractedFacts.latest_update !== 'No updates';

      // Build specific draft instruction
      const draftInstruction = draftType === 'sms'
        ? `Generate a professional but concise SMS text message (under 320 characters) to update the client/homeowner about their claim. The message must:
- Reference specific claim activity (dates, carrier name, what happened)
- State the current status based on actual notes and correspondence
- Include the next concrete step (not generic "we'll be in touch")
- Be warm but professional
- NOT include any greeting or signature — just the message body`
        : `Generate a professional email to update the client/homeowner about their claim. The email must:
- Have a clear, specific subject line referencing the claim
- Reference specific claim activity (dates, carrier communications, what happened)
- State the current status based on actual notes and correspondence
- Include the next concrete step with timeline if available
- Be warm, professional, and reassuring
- Include a proper greeting and sign-off`;

      // Build a concrete facts block so the AI has explicit data points to reference
      const recentNotes = claimNotes.slice(0, 5).map((n: any) => `  - [${n.date}] ${n.content}`).join('\n');
      const recentEmails = emailHistory.slice(0, 5).map((e: any) => `  - [${e.date}] ${e.recipient_type === 'inbound' ? 'FROM' : 'TO'} ${e.recipient || 'unknown'}: "${e.subject}"${e.body_preview ? ' — ' + e.body_preview : ''}`).join('\n');
      const recentUpdates = claimUpdates.slice(0, 5).map((u: any) => `  - [${u.date || u.created_at}] ${u.content}`).join('\n');

      const concreteFactsBlock = `
=== CONCRETE CLAIM FACTS (USE THESE EXACTLY) ===
Claim Number: ${extractedFacts.claim_number}
Policyholder: ${clientDisplayName}
Property: ${extractedFacts.property_address}
Carrier: ${extractedFacts.carrier}
Current Status: ${extractedFacts.claim_status}
Loss Type: ${extractedFacts.loss_type}
Loss Date: ${extractedFacts.loss_date}
Last Contact: ${extractedFacts.last_contact_date}${extractedFacts.last_contact_with !== 'N/A' ? ' with ' + extractedFacts.last_contact_with : ''}
Last Email Subject: ${extractedFacts.last_contact_subject}
Next Action: ${extractedFacts.next_action}
${extractedFacts.pending_deadlines.length > 0 ? 'Pending Deadlines: ' + extractedFacts.pending_deadlines.join('; ') : ''}

Recent Notes:
${recentNotes || '  (none)'}

Recent Emails:
${recentEmails || '  (none)'}

Recent Updates:
${recentUpdates || '  (none)'}
=== END FACTS ===`;

      // Use AI to generate the draft using full claim context + explicit facts
      let draftModel: string | undefined;
      let draftText = deterministicDraft;

      if (hasDraftSourceData) {
        const draftAi = await runDarwinTask(
          'copilot_drafting' as any,
          `${finalSystemPrompt}

SPECIAL INSTRUCTION — STRUCTURED DRAFT GENERATION:
You are generating a ${draftType === 'sms' ? 'SMS text message' : 'client email'} draft.

${concreteFactsBlock}

${draftInstruction}

CRITICAL RULES:
1. Use ONLY the concrete facts above. You MUST reference specific dates, the carrier name "${extractedFacts.carrier}", and actual actions from the notes/emails.
2. FORBIDDEN phrases: "reviewing your claim details", "will contact you shortly", "updated your claim file", "we will be in touch shortly", "check the portal for details", "please check the portal". These are vague and unacceptable.
3. INSTEAD use specifics like: "${extractedFacts.carrier} sent [specific document] on [date]", "we submitted [specific action] on [date]", "your next step is [concrete action]".
4. The draft must reflect the ACTUAL current state: "${extractedFacts.claim_status}". Reference what specifically happened most recently from the notes/emails above.
5. Write as if authored by ${authorName || 'the public adjuster'}.
6. Address the client by first name if available from: ${claim?.policyholder_name || claim?.customer_name || 'the client'}.
7. Return ONLY the draft text — no analysis, no preamble, no explanation, no markdown formatting.`,
          `Generate a ${draftType === 'sms' ? 'SMS' : 'email'} draft for the client on claim ${extractedFacts.claim_number}. Use the concrete facts provided. ${latestUserTurn}`,
        );

        draftModel = draftAi.model;
        const candidateDraft = (draftAi.text || '').trim();
        if (candidateDraft && !isDraftClarificationResponse(candidateDraft) && !containsForbiddenDraftPhrase(candidateDraft)) {
          draftText = candidateDraft;
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          response: draftText,
          model: draftModel || ai.model,
          strategyMode: false,
          draftData: {
            type: draftType,
            facts: extractedFacts,
            draft: draftText,
            generated_at: new Date().toISOString(),
          },
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    }

    const meta = ai.meta || {};
    return new Response(
      JSON.stringify({
        ok: true,
        response: ai.text,
        model: meta.model || ai.model,
        usedSearch: meta.usedSearch || false,
        cached: meta.cached || false,
        sources: meta.sources || [],
        promptHash: meta.promptHash || '',
        strategyMode: copilotMode === 'strategy',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    );
  } catch (err: any) {
    console.error('darwin-copilot error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message || 'Unknown copilot error' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
