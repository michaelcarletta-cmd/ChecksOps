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

${copilotMode === 'strategy' ? `In STRATEGY mode, you are conversational. Do NOT force the 5-question framework on every reply. Instead:
- Answer the user's specific question directly
- Cite internal evidence (documents, photos, timeline events, estimate lines) with specifics
- Reference external standards when relevant
- Propose concrete next steps only when appropriate
- If drafting language, write it in a professional, carrier-ready tone
- Ask follow-up questions to deepen the strategy discussion

EXTERNAL CONTENT WRITING RULES (apply when drafting letters, emails, rebuttals, explanations, or any content intended for external recipients):
1. AUTHORSHIP: Never refer to Darwin, AI, or any automated system as the author. Write as if the content is authored by the public adjuster or claims professional handling the claim. Use first person plural ("we") or the firm name when appropriate.
2. PLAIN TEXT: Use clean professional prose with paragraph formatting. Do NOT use bullet points (* - = •), emoji, markdown formatting (** # *), or any special symbols. Write in flowing narrative paragraphs.
3. TONE: Use professional claim-handling language appropriate for communication with carriers, contractors, attorneys, and regulators. Be assertive but composed.
4. SIGNATURE: When generating a letter or email, end with a neutral professional closing such as "Sincerely," or "Regards," followed by a blank line for the sender's name. Never insert "Darwin" or any AI reference as the sender.
5. INTERNAL vs EXTERNAL: Structured formatting (headers, bullets, analysis frameworks) may be used for internal Copilot analysis responses. But when the user requests a draft letter, email, rebuttal, or explanation for external use, automatically convert to clean narrative prose.` : `EVERY response MUST answer these 5 questions:
1. **What matters most right now?** — The single highest-priority item
2. **What is missing?** — Evidence, documents, or analysis gaps
3. **What should happen next?** — Specific actionable next step
4. **What is the carrier's weak point?** — Exploitable weakness in their position
5. **What action or letter does Darwin recommend NOW?** — Concrete deliverable`}

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
Format with clear headers and bullet points.

FORMATTING RULE: NEVER output icon placeholder tokens like [Scales Icon], [Document Icon], [Warning Icon], [Evidence Icon], [Clock Icon], or any bracket-wrapped icon references. These do not render in the UI. Use plain text headings instead (e.g. "Coverage Impact" not "[Scales Icon] COVERAGE IMPACT"). Emoji are acceptable for source labels (📋, 🔁, 🌐, 🎯) but bracketed icon tokens are strictly forbidden.`;

    // --- External research via Perplexity for strategy mode ---
    let externalResearch = '';
    if (copilotMode === 'strategy') {
      const lastUserMsg = conversationHistory?.length
        ? conversationHistory[conversationHistory.length - 1]?.content
        : userQuestion;

      if (lastUserMsg) {
        const PERPLEXITY_KEY = Deno.env.get('PERPLEXITY_API_KEY') || Deno.env.get('PERPLEXITY_API_KEY_1');
        if (PERPLEXITY_KEY) {
          try {
            // Build a rich, context-aware research query
            const lossType = claim?.loss_type || claim?.type_of_loss || '';
            const state = claim?.state || '';
            const trade = claim?.construction_trade || claim?.trade || '';
            const materialType = claim?.roof_material || claim?.material_type || '';
            const disputeTopic = intelSummary?.most_important_issue || '';

            // Compose structured query terms from claim context
            const queryTerms = [
              lastUserMsg,
              lossType && `${lossType} loss`,
              state && `${state} state`,
              carrier !== 'Unknown' && `carrier: ${carrier}`,
              trade && `trade: ${trade}`,
              materialType && `material: ${materialType}`,
              disputeTopic && `dispute: ${disputeTopic}`,
            ].filter(Boolean).join('. ');

            const researchQuery = `Insurance claim dispute research: ${queryTerms}. Focus on manufacturer installation standards, building codes, state insurance regulations, technical industry standards, and case law that apply.`;

            const perplexityResp = await fetch('https://api.perplexity.ai/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${PERPLEXITY_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'sonar',
                messages: [
                  { role: 'system', content: `You are a research assistant for insurance claim disputes and property restoration.

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
- Be concise and factual. Always cite sources.` },
                  { role: 'user', content: researchQuery },
                ],
              }),
            });

            if (perplexityResp.ok) {
              const perplexityData = await perplexityResp.json();
              const researchContent = perplexityData.choices?.[0]?.message?.content;
              const citations = perplexityData.citations || [];
              if (researchContent) {
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

${researchContent}`;
                if (citations.length > 0) {
                  externalResearch += `\n\nSOURCES:\n${citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join('\n')}`;
                }
              }
            } else {
              console.warn('Perplexity research failed:', perplexityResp.status);
            }
          } catch (researchErr) {
            console.warn('External research error (non-fatal):', researchErr);
          }
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
        aiMessages.push({ role: msg.role, content: msg.content });
      }
    } else {
      aiMessages.push({
        role: 'user',
        content: userQuestion || `Give me the full Darwin Copilot briefing for this claim in ${copilotMode} mode.`,
      });
    }

    const aiResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: aiMessages,
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
