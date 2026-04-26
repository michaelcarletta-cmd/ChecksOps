import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { callOpenAIText } from "../_shared/ai-router.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// State-specific insurance regulations for strategic analysis
const stateRegulations: Record<string, any> = {
  'PA': {
    stateName: 'Pennsylvania',
    promptPayDays: 15,
    acknowledgmentDays: 10,
    decisionDays: 30,
    badFaithStatute: '42 Pa.C.S. § 8371',
    adminCode: '31 Pa. Code Chapter 146'
  },
  'NJ': {
    stateName: 'New Jersey',
    promptPayDays: 30,
    acknowledgmentDays: 10,
    decisionDays: 30,
    badFaithStatute: 'N.J.S.A. 17:29B-4',
    adminCode: 'N.J.A.C. 11:2-17'
  },
  'TX': {
    stateName: 'Texas',
    promptPayDays: 5,
    acknowledgmentDays: 15,
    decisionDays: 15,
    badFaithStatute: 'Texas Insurance Code Chapter 541',
    adminCode: '28 TAC § 21.203'
  },
  'FL': {
    stateName: 'Florida',
    promptPayDays: 20,
    acknowledgmentDays: 14,
    decisionDays: 90,
    badFaithStatute: 'F.S. § 624.155',
    adminCode: 'Fla. Admin. Code 69O-166'
  }
};

function getStateInfo(stateCode: string) {
  const info = stateRegulations[stateCode?.toUpperCase()];
  if (!info) {
    console.warn(`[Darwin] WARNING: No regulations found for state "${stateCode}". Falling back to PA — outputs may cite wrong jurisdiction.`);
    return { ...stateRegulations['PA'], _fallback: true, _requestedState: stateCode };
  }
  return info;
}

type DiscreteConfidence = 0 | 0.25 | 0.5 | 0.75 | 1;
type CoverageConfidence = 0 | 0.5 | 1;

type CoverageTriggerResult = {
  coverageTrigger: {
    decision: "triggered" | "not_triggered" | "unknown";
    confidence: DiscreteConfidence;
    rationale: string;
    missingDocs: string[];
  };
  extractedPolicy: {
    policyType: "auto" | "home" | "commercial" | "unknown";
    state: string | null;
    policyNumber: string | null;
    namedInsured: string | null;
    effectiveDate: string | null;
    expirationDate: string | null;
    coverages: Array<{
      name: string;
      limit: string | null;
      deductible: string | null;
      evidence: Array<{
        docId?: string;
        docName: string;
        page?: number;
        sectionHint?: string;
        quote?: string;
      }>;
      confidence: CoverageConfidence;
    }>;
    exclusionsOrConditions: Array<{
      label: string;
      appliesTo?: string | null;
      evidence: Array<{
        docName: string;
        page?: number;
        sectionHint?: string;
        quote?: string;
      }>;
    }>;
  };
  notesForUser: string[];
};

function toDiscreteConfidence(raw: number): DiscreteConfidence {
  if (raw >= 0.875) return 1;
  if (raw >= 0.625) return 0.75;
  if (raw >= 0.375) return 0.5;
  if (raw >= 0.125) return 0.25;
  return 0;
}

function clampQuoteWords(text: string, maxWords = 25): string {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

function normalizeDateToISO(dateStr: string): string | null {
  const s = (dateStr || "").trim();
  if (!s) return null;

  // MM/DD/YYYY or MM-DD-YYYY
  const mdy = s.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (mdy) {
    const mm = Number(mdy[1]);
    const dd = Number(mdy[2]);
    let yy = Number(mdy[3]);
    if (yy < 100) yy = 2000 + yy;
    const iso = new Date(Date.UTC(yy, mm - 1, dd)).toISOString();
    return iso;
  }

  // Try native parse (fallback)
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

function extractPolicyFromClaimFiles(files: any[], stateCode: string): { extractedPolicy: CoverageTriggerResult["extractedPolicy"]; missingDocs: string[] } {
  const missingDocs: string[] = [];

  const policyDocs = (files || []).filter((f) => {
    const name = (f.file_name || "").toLowerCase();
    const cls = (f.document_classification || "").toLowerCase();
    return cls === "policy" || name.includes("policy") || name.includes("declaration") || name.includes("dec");
  });

  const hasPolicyText = policyDocs.some((d) => typeof d.extracted_text === "string" && d.extracted_text.trim().length > 200);
  const hasDecHint = policyDocs.some((d) => {
    const n = (d.file_name || "").toLowerCase();
    return n.includes("dec") || n.includes("declaration");
  });

  if (!policyDocs.length || !hasPolicyText) {
    missingDocs.push("Declarations page");
  } else if (!hasDecHint) {
    missingDocs.push("Declarations page");
  }

  // Deterministic extraction from extracted_text only (no assumptions)
  let policyNumber: string | null = null;
  let namedInsured: string | null = null;
  let effectiveDate: string | null = null;
  let expirationDate: string | null = null;

  const coverages: CoverageTriggerResult["extractedPolicy"]["coverages"] = [];
  const exclusionsOrConditions: CoverageTriggerResult["extractedPolicy"]["exclusionsOrConditions"] = [];

  const autoCoverageLabels = [
    "Collision",
    "Comprehensive",
    "PIP",
    "Personal Injury Protection",
    "Rental",
    "Rental Reimbursement",
    "Towing",
    "Roadside",
    "UM",
    "UIM",
    "Uninsured Motorist",
    "Underinsured Motorist",
    "MedPay",
    "Medical Payments",
    "Liability",
  ];
  const homeCoverageLabels = [
    "Coverage A",
    "Dwelling",
    "Coverage B",
    "Other Structures",
    "Coverage C",
    "Personal Property",
    "Coverage D",
    "Loss of Use",
    "Ordinance",
    "Ordinance or Law",
  ];

  function addCoverageFromLine(args: { doc: any; line: string; label: string; sectionHint?: string }) {
    const { doc, line, label, sectionHint } = args;
    const limitMatch = line.match(/\$[\s]*[\d,]+/);
    const dedMatch = line.match(/deductible[^$]*\$[\s]*[\d,]+/i) || line.match(/\$[\s]*[\d,]+\s*(?:deductible)?/i);

    const evidence = [{
      docId: doc.id,
      docName: doc.file_name,
      sectionHint,
      quote: clampQuoteWords(line, 25),
    }];

    coverages.push({
      name: label,
      limit: limitMatch ? limitMatch[0].replace(/\s+/g, " ").trim() : null,
      deductible: dedMatch ? dedMatch[0].replace(/\s+/g, " ").trim() : null,
      evidence,
      confidence: limitMatch || /deductible/i.test(line) ? 1 : 0.5,
    });
  }

  for (const doc of policyDocs) {
    const text = (doc.extracted_text || "").toString();
    if (!text.trim()) continue;

    const sectionHint = ((doc.file_name || "").toLowerCase().includes("dec") || (doc.file_name || "").toLowerCase().includes("declaration"))
      ? "Declarations"
      : "Policy";

    // Policy number
    if (!policyNumber) {
      const m = text.match(/\bpolicy\s*(?:no\.|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-]{4,})\b/i);
      if (m?.[1]) policyNumber = m[1];
    }

    // Named insured
    if (!namedInsured) {
      const m = text.match(/\bnamed\s+insured\s*[:\-]?\s*([^\n\r]{3,80})/i);
      if (m?.[1]) namedInsured = m[1].trim();
    }

    // Effective / expiration
    if (!effectiveDate || !expirationDate) {
      const m = text.match(/\beffective\s*(?:date)?\s*[:\-]?\s*([^\n\r]{4,20})/i);
      const n = text.match(/\bexpiration\s*(?:date)?\s*[:\-]?\s*([^\n\r]{4,20})/i);
      if (!effectiveDate && m?.[1]) effectiveDate = normalizeDateToISO(m[1]);
      if (!expirationDate && n?.[1]) expirationDate = normalizeDateToISO(n[1]);
    }

    const lines = text.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const lower = line.toLowerCase();

      for (const label of autoCoverageLabels) {
        if (lower.includes(label.toLowerCase())) {
          addCoverageFromLine({ doc, line, label, sectionHint });
          break;
        }
      }

      for (const label of homeCoverageLabels) {
        if (lower.includes(label.toLowerCase())) {
          addCoverageFromLine({ doc, line, label, sectionHint });
          break;
        }
      }

      if (lower.includes("wear") && lower.includes("tear")) {
        exclusionsOrConditions.push({
          label: "Wear and tear exclusion/condition (detected)",
          appliesTo: null,
          evidence: [{
            docName: doc.file_name,
            sectionHint,
            quote: clampQuoteWords(line, 25),
          }],
        });
      }
    }
  }

  // Infer policy type from what we actually found (no assumptions)
  const foundAuto = coverages.some((c) => autoCoverageLabels.some((l) => c.name.toLowerCase() === l.toLowerCase()));
  const foundHome = coverages.some((c) => homeCoverageLabels.some((l) => c.name.toLowerCase() === l.toLowerCase()));

  let policyType: CoverageTriggerResult["extractedPolicy"]["policyType"] = "unknown";
  if (foundAuto && !foundHome) policyType = "auto";
  else if (foundHome && !foundAuto) policyType = "home";
  else if (foundAuto && foundHome) policyType = "unknown";

  // De-duplicate coverages by name (keep highest confidence + merge evidence)
  const byName = new Map<string, CoverageTriggerResult["extractedPolicy"]["coverages"][number]>();
  for (const c of coverages) {
    const key = c.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, c);
      continue;
    }
    const merged: typeof c = {
      ...existing,
      limit: existing.limit || c.limit,
      deductible: existing.deductible || c.deductible,
      confidence: (existing.confidence === 1 || c.confidence === 1) ? 1 : 0.5,
      evidence: [...existing.evidence, ...c.evidence].slice(0, 3),
    };
    byName.set(key, merged);
  }

  const extractedPolicy: CoverageTriggerResult["extractedPolicy"] = {
    policyType,
    state: stateCode || null,
    policyNumber,
    namedInsured,
    effectiveDate,
    expirationDate,
    coverages: Array.from(byName.values()),
    exclusionsOrConditions,
  };

  return { extractedPolicy, missingDocs: Array.from(new Set(missingDocs)) };
}

// AI calls now routed through _shared/ai-router.ts

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: any;
    try {
      body = await req.json();
    } catch (_parseErr) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid or empty request body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { claimId, analysisType } = body;

    if (!claimId) {
      throw new Error('Claim ID is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    // AI routing handled by _shared/ai-router.ts (OPENAI_API_KEY required)

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Gather comprehensive claim data for strategic analysis
    const [
      claimResult,
      filesResult,
      photosResult,
      emailsResult,
      tasksResult,
      checksResult,
      settlementResult,
      inspectionsResult,
      deadlinesResult,
      adjustersResult,
      diaryResult,
      notesResult,
      claimEventsResult
    ] = await Promise.all([
      supabase.from('claims').select('*, clients(*)').eq('id', claimId).single(),
      supabase.from('claim_files').select('*').eq('claim_id', claimId),
      supabase.from('claim_photos').select('*').eq('claim_id', claimId),
      supabase.from('emails').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }),
      supabase.from('tasks').select('*').eq('claim_id', claimId),
      supabase.from('claim_checks').select('*').eq('claim_id', claimId),
      supabase.from('claim_settlements').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(1),
      supabase.from('inspections').select('*').eq('claim_id', claimId),
      supabase.from('claim_carrier_deadlines').select('*').eq('claim_id', claimId),
      supabase.from('claim_adjusters').select('*').eq('claim_id', claimId),
      supabase.from('claim_communications_diary').select('*').eq('claim_id', claimId).order('communication_date', { ascending: false }),
      supabase.from('notes').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }),
      supabase.from('claim_events').select('*').eq('claim_id', claimId).order('occurred_at', { ascending: true })
    ]);

    if (claimResult.error || !claimResult.data) {
      throw new Error(`Claim not found: ${claimResult.error?.message}`);
    }

    const claim = claimResult.data;
    const files = filesResult.data || [];
    const photos = photosResult.data || [];
    const emails = emailsResult.data || [];
    const tasks = tasksResult.data || [];
    const checks = checksResult.data || [];
    const settlement = settlementResult.data?.[0];
    const inspections = inspectionsResult.data || [];
    const deadlines = deadlinesResult.data || [];
    const adjusters = adjustersResult.data || [];
    const diary = diaryResult.data || [];
    const notes = notesResult.data || [];
    const claimEvents = claimEventsResult.data || [];

    // State code will be determined after property address parsing - placeholder
    let stateCode = 'PA'; // Default, will be updated after address parsing

    // Calculate key metrics
    const daysSinceLoss = claim.loss_date 
      ? Math.floor((Date.now() - new Date(claim.loss_date).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const daysOpen = claim.created_at
      ? Math.floor((Date.now() - new Date(claim.created_at).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // === ANCHOR EVENT TYPES ONLY ===
    // Filter claim_events to only anchor types (ignore date_mentioned/file_uploaded)
    const ANCHOR_EVENT_TYPES = new Set([
      'denial_issued', 'acknowledgement_issued', 'ror_issued', 'fnol_received',
      'inspection', 'payment', 'estimate_issued', 'engineer_report_issued',
      'loss_event', 'deadline', 'policy_issued', 'invoice_issued',
      'correspondence_issued', 'claim_filed',
    ]);
    
    const anchorEvents = claimEvents.filter((e: any) => ANCHOR_EVENT_TYPES.has(e.event_type));
    const nonAnchorCount = claimEvents.length - anchorEvents.length;
    console.log(`[Strategic] Anchor events: ${anchorEvents.length}/${claimEvents.length} (filtered ${nonAnchorCount} non-anchor like date_mentioned/file_uploaded)`);

    // Calculate earliest documented activity from anchor events only
    const documentSourcedEvents = anchorEvents.filter((e: any) => 
      e.date_source !== 'system_upload' && e.event_type !== 'claim_created'
    );
    const earliestDocEvent = documentSourcedEvents.length > 0 ? documentSourcedEvents[0] : null;
    const firstDocumentDate = earliestDocEvent?.occurred_at ? new Date(earliestDocEvent.occurred_at) : null;
    const daysBetweenLossAndFirstDoc = (claim.loss_date && firstDocumentDate)
      ? Math.floor((firstDocumentDate.getTime() - new Date(claim.loss_date).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Build claim events timeline context for AI — anchor events only, with citations
    const claimEventsContext = anchorEvents.length > 0
      ? anchorEvents.slice(0, 25).map((e: any) => {
          const dateStr = e.occurred_at ? new Date(e.occurred_at).toLocaleDateString() : 'Unknown';
          const source = e.date_source === 'document_extracted' ? '(from document)' : 
                         e.date_source === 'document_text_regex' ? '(regex from doc)' :
                         e.date_source === 'crm_field' ? '(from CRM)' : '(system)';
          const fileName = e.metadata_json?.file_name || '';
          const snippet = (e.date_evidence || '').substring(0, 100);
          const citation = fileName ? ` [Source: ${fileName}${snippet ? ` — "${snippet}"` : ''}]` : '';
          return `  - [${e.event_type}] ${e.summary} | ${dateStr} ${source}${citation}`;
        }).join('\n')
      : '  No anchor claim events recorded (only file_uploaded/date_mentioned events exist — insufficient for strategic analysis)';
    
    const totalChecksReceived = checks.reduce((sum, c) => sum + (c.amount || 0), 0);
    const carrierEstimate = settlement?.estimate_amount || 0;
    const totalSettlement = settlement?.total_settlement || 0;

    // PA/Freedom Estimate: explicit field first, then fallback to file-based extraction
    let paEstimate = Number(settlement?.pa_estimate_amount) || 0;
    
    if (!paEstimate) {
      // Fetch folders to identify PA vs carrier folders
      const { data: folders } = await supabase
        .from('claim_folders')
        .select('id, name')
        .eq('claim_id', claimId);
      
      const paFolderIds = new Set(
        (folders || [])
          .filter(f => {
            const name = (f.name || '').toLowerCase();
            return name.includes('freedom') || name.includes('supporting evidence') || name.includes('estimates');
          })
          .map(f => f.id)
      );
      
      // Find estimate files in PA/Freedom folders
      const paEstimateFiles = files.filter(f => {
        const cls = (f.document_classification || '').toLowerCase();
        const fileName = (f.file_name || '').toLowerCase();
        const isEstimate = cls === 'estimate' || fileName.includes('estimate') || 
                          fileName.includes('xactimate') || fileName.includes('scope') ||
                          cls === 'contractor';
        const isInPaFolder = f.folder_id && paFolderIds.has(f.folder_id);
        return isEstimate && isInPaFolder;
      });
      
      // If no folder-filtered results, try all estimate files not in carrier folders
      const carrierFolderIds = new Set(
        (folders || [])
          .filter(f => (f.name || '').toLowerCase().includes('carrier'))
          .map(f => f.id)
      );
      
      const fallbackEstimateFiles = paEstimateFiles.length > 0 ? paEstimateFiles : files.filter(f => {
        const cls = (f.document_classification || '').toLowerCase();
        const fileName = (f.file_name || '').toLowerCase();
        const isEstimate = cls === 'estimate' || fileName.includes('estimate') || fileName.includes('xactimate');
        const isNotCarrier = !f.folder_id || !carrierFolderIds.has(f.folder_id);
        return isEstimate && isNotCarrier;
      });
      
      // Extract highest amount from classification_metadata
      for (const file of fallbackEstimateFiles) {
        const meta = file.classification_metadata;
        if (meta && typeof meta === 'object') {
          const amounts = (meta as any).amounts;
          if (Array.isArray(amounts)) {
            for (const a of amounts) {
              const val = Number(a.amount || a.value || 0);
              if (val > paEstimate) paEstimate = val;
            }
          }
          // Also check for total_rcv or gross_total in metadata
          const totalRcv = Number((meta as any).total_rcv || (meta as any).gross_total || 0);
          if (totalRcv > paEstimate) paEstimate = totalRcv;
        }
      }
    }
    
    // Use PA estimate as the primary "estimate" if available, otherwise fall back to carrier or claim amount
    const estimateAmount = paEstimate || carrierEstimate || claim.claim_amount || 0;
    const estimateDifference = paEstimate && carrierEstimate ? paEstimate - carrierEstimate : 0;

    // Helper function to get actual document date with validation
    // Prefers extracted date from document content, falls back to upload date
    const getDocumentDate = (file: any): { date: string | null; source: 'document' | 'upload'; confidence: number } => {
      const metadata = file.classification_metadata;
      if (metadata && typeof metadata === 'object') {
        // Prefer new document_date field over deprecated date_mentioned
        const documentDate = (metadata as any).document_date;
        const dateMentioned = (metadata as any).date_mentioned;
        const dateConfidence = (metadata as any).date_confidence ?? 0.5;
        
        const dateStr = documentDate || dateMentioned;
        
        if (dateStr && typeof dateStr === 'string' && dateStr !== 'null') {
          // Validate the date is within reasonable range
          const dateObj = new Date(dateStr);
          if (!isNaN(dateObj.getTime())) {
            const now = new Date();
            const fiveYearsAgo = new Date();
            fiveYearsAgo.setFullYear(now.getFullYear() - 5);
            
            // Only use document date if:
            // 1. It's within reasonable range (last 5 years, not future)
            // 2. Has decent confidence (>= 0.6) OR confidence wasn't provided (legacy docs)
            const isReasonableDate = dateObj >= fiveYearsAgo && dateObj <= now;
            const hasGoodConfidence = dateConfidence >= 0.6 || (metadata as any).date_confidence === undefined;
            
            if (isReasonableDate && hasGoodConfidence) {
              return { date: dateStr, source: 'document', confidence: dateConfidence };
            }
          }
        }
      }
      // Fallback to upload date with high confidence (it's always accurate)
      return { date: file.uploaded_at, source: 'upload', confidence: 1.0 };
    };

    // Build property address from available sources
    // Priority: policyholder_address > client address > individual fields
    const propertyAddress = claim.policyholder_address || 
      (claim.clients?.street ? `${claim.clients.street}, ${claim.clients.city || ''}, ${claim.clients.state || ''} ${claim.clients.zip_code || ''}` : '') ||
      'Address not specified';
    
    // Parse state from address for regulations lookup
    // Multiple regex patterns to handle different address formats:
    // "123 Main St, City, NJ 08050" or "123 Main St, City NJ, 08050" or "City NJ 08050"
    const parseStateFromAddress = (address: string): string | null => {
      if (!address) return null;
      const upperAddr = address.toUpperCase();
      
      // Pattern 1: ", NJ 08050" or ", NJ, 08050" (state before zip)
      const pattern1 = upperAddr.match(/[,\s]([A-Z]{2})[,\s]+\d{5}/);
      if (pattern1) return pattern1[1];
      
      // Pattern 2: "City NJ," (state after city, before comma)
      const pattern2 = upperAddr.match(/\s([A-Z]{2}),/);
      if (pattern2) return pattern2[1];
      
      // Pattern 3: Check for common state codes anywhere in address
      const stateMatch = upperAddr.match(/\b(NJ|PA|TX|FL|NY|CA|GA|NC|SC|VA|MD|DE|CT|MA|OH|IL|MI|WI|MN|CO|AZ|NV|WA|OR)\b/);
      if (stateMatch) return stateMatch[1];
      
      return null;
    };
    
    // Also check city field for embedded state (e.g., "Manahawkin NJ")
    const stateFromCity = claim.clients?.city ? parseStateFromAddress(claim.clients.city) : null;
    
    // Priority: state_code column > client state > city parse > address parse > WARN + PA fallback
    stateCode = (claim as any).state_code ||
      claim.clients?.state || 
      stateFromCity ||
      parseStateFromAddress(claim.policyholder_address || '') || 
      'PA';
    
    if (!(claim as any).state_code && !claim.clients?.state && !stateFromCity && !parseStateFromAddress(claim.policyholder_address || '')) {
      console.warn(`[Darwin] CRITICAL: Could not detect state for claim ${claimId}. Defaulting to PA — this may produce INCORRECT state-specific outputs.`);
    }
    console.log(`State detection: state_code="${(claim as any).state_code}", client_state="${claim.clients?.state}", stateFromCity="${stateFromCity}", parsed from address="${parseStateFromAddress(claim.policyholder_address || '')}", final="${stateCode}"`);
    
    const stateInfo = getStateInfo(stateCode);

    // Analyze evidence inventory with document dates
    // Improve estimate detection - check for common estimate filename patterns
    const hasEstimate = files.some(f => {
      const fileName = f.file_name?.toLowerCase() || '';
      const classification = f.document_classification?.toLowerCase() || '';
      return classification === 'estimate' || 
             fileName.includes('estimate') ||
             fileName.includes('xactimate') ||
             fileName.includes('symbility') ||
             fileName.includes('rcv') ||
             fileName.includes('acv') ||
             fileName.includes('scope') ||
             // Check for common contractor estimate patterns
             (classification === 'invoice' && (fileName.includes('contractor') || fileName.includes('repair')));
    });
    const hasDenialLetter = files.some(f => f.document_classification === 'denial' || f.file_name?.toLowerCase().includes('denial'));
    // Multi-signal expert/engineer report detection
    const expertMarkers = ["p.e.", "professional engineer", "engineer", "engineering report", "cause of loss", "findings", "opinion", "seal", "license"];
    const expertByClassification = files.filter(f => f.document_classification === 'engineering_report');
    const expertByName = files.filter(f => {
      const name = f.file_name?.toLowerCase() || '';
      return expertMarkers.some(m => name.includes(m));
    });
    const expertByText = files.filter(f => {
      const text = (f.extracted_text || '').toLowerCase().substring(0, 2000);
      return expertMarkers.filter(m => text.includes(m)).length >= 2;
    });
    const expertByEvents = claimEvents.filter((e: any) => e.event_type === 'engineer_report_issued' || e.doc_type === 'engineering_report');
    const allExpertFileNames = [...new Set([
      ...expertByClassification.map(f => f.file_name),
      ...expertByName.map(f => f.file_name),
      ...expertByText.map(f => f.file_name),
    ])];
    const hasEngineerReport = allExpertFileNames.length > 0 || expertByEvents.length > 0;
    const expertReportDebug = {
      files_by_classification: expertByClassification.map(f => f.file_name),
      files_by_name: expertByName.map(f => f.file_name),
      files_by_text_markers: expertByText.map(f => f.file_name),
      events_matched: expertByEvents.length,
      rule_result: hasEngineerReport,
    };
    console.log(`[Strategic] Expert report multi-signal detection:`, JSON.stringify(expertReportDebug));
    const hasPolicy = files.some(f => f.document_classification === 'policy' || f.file_name?.toLowerCase().includes('policy') || f.file_name?.toLowerCase().includes('declaration'));
    const hasProofOfLoss = files.some(f => f.file_name?.toLowerCase().includes('proof of loss') || f.file_name?.toLowerCase().includes('pol'));
    const hasContractorInvoice = files.some(f => f.document_classification === 'invoice' || f.file_name?.toLowerCase().includes('invoice'));
    
    const photoCount = photos.length;
    const categorizedPhotos = photos.filter(p => p.category && p.category !== 'uncategorized');
    const annotatedPhotos = photos.filter(p => p.annotations);
    
    // Analyze AI-processed photos for strategic intelligence
    const aiAnalyzedPhotos = photos.filter(p => p.ai_analyzed_at);
    const poorConditionPhotos = photos.filter(p => 
      p.ai_condition_rating === 'Poor' || p.ai_condition_rating === 'Failed'
    );
    const photosWithDamages = photos.filter(p => {
      if (!p.ai_detected_damages) return false;
      try {
        const damages = typeof p.ai_detected_damages === 'string' 
          ? JSON.parse(p.ai_detected_damages) 
          : p.ai_detected_damages;
        return Array.isArray(damages) && damages.length > 0;
      } catch { return false; }
    });
    
    // Aggregate all detected damages across photos
    const allDetectedDamages: Array<{type: string, description: string, severity: string, material: string}> = [];
    const allMaterialTypes: string[] = [];
    photos.forEach(p => {
      if (p.ai_material_type) {
        allMaterialTypes.push(p.ai_material_type);
      }
      if (p.ai_detected_damages) {
        try {
          const damages = typeof p.ai_detected_damages === 'string' 
            ? JSON.parse(p.ai_detected_damages) 
            : p.ai_detected_damages;
          if (Array.isArray(damages)) {
            damages.forEach((d: any) => {
              allDetectedDamages.push({
                type: d.type || d.damage_type || 'Unknown',
                description: d.description || d.notes || '',
                severity: d.severity || 'Unknown',
                material: p.ai_material_type || 'Unknown'
              });
            });
          }
        } catch {}
      }
    });
    
    // Count damage types for strategic summary
    const damageTypeCounts: Record<string, number> = {};
    allDetectedDamages.forEach(d => {
      const key = d.type;
      damageTypeCounts[key] = (damageTypeCounts[key] || 0) + 1;
    });
    const topDamageTypes = Object.entries(damageTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => `${type} (${count})`);
    
    // Unique materials detected
    const uniqueMaterials = [...new Set(allMaterialTypes)];

    // Check for coverage-related files
    const hasOrdinanceInfo = files.some(f => 
      f.file_name?.toLowerCase().includes('ordinance') || 
      f.file_name?.toLowerCase().includes('code') ||
      f.file_name?.toLowerCase().includes('permit')
    );

    // Build document timeline with ACTUAL document dates (not upload dates)
    // This is critical for accurate timeline analysis when documents were uploaded late
    
    // Validate document date - reject obviously wrong dates
    const validateDocumentDateForTimeline = (dateStr: string | null, lossDate: string | null, uploadDate: string | null): { isValid: boolean; reason?: string } => {
      if (!dateStr || dateStr === 'null') return { isValid: false, reason: 'no date' };
      
      const docDate = new Date(dateStr);
      const now = new Date();
      
      // Reject dates more than 2 years in the past (likely misread/hallucination)
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(now.getFullYear() - 2);
      if (docDate < twoYearsAgo) {
        return { isValid: false, reason: `date ${dateStr} is suspiciously old` };
      }
      
      // Reject dates in the future
      if (docDate > now) {
        return { isValid: false, reason: `date ${dateStr} is in the future` };
      }
      
      // For denial letters, estimates, etc - they must be AFTER loss date
      // If a document date is before loss date, use upload date instead
      if (lossDate) {
        const loss = new Date(lossDate);
        if (docDate < loss) {
          return { isValid: false, reason: `document date ${dateStr} is before loss date ${lossDate}` };
        }
      }
      
      return { isValid: true };
    };
    
    const keyDocuments = files
      .filter(f => f.document_classification && f.document_classification !== 'photo' && f.document_classification !== 'other')
      .map(f => {
        const dateInfo = getDocumentDate(f);
        const metadata = f.classification_metadata || {};
        
        // Validate the document date
        const dateValidation = validateDocumentDateForTimeline(
          dateInfo.source === 'document' ? dateInfo.date : null,
          claim.loss_date,
          f.uploaded_at
        );
        
        // If document date is invalid, fall back to upload date
        const effectiveDate = dateValidation.isValid ? dateInfo.date : f.uploaded_at;
        const effectiveSource = dateValidation.isValid ? dateInfo.source : 'upload';
        
        if (!dateValidation.isValid && dateInfo.source === 'document') {
          console.log(`Document date validation failed for ${f.file_name}: ${dateValidation.reason}. Using upload date instead.`);
        }
        
        return {
          type: f.document_classification,
          fileName: f.file_name,
          documentDate: effectiveDate,
          dateSource: effectiveSource,
          dateWarning: dateValidation.isValid ? null : dateValidation.reason,
          uploadedAt: f.uploaded_at,
          summary: (metadata as any).summary || null,
          amounts: (metadata as any).amounts || [],
          deadline: (metadata as any).deadline_mentioned || null,
          sender: (metadata as any).sender || null,
        };
      })
      .sort((a, b) => {
        // Sort by document date (actual date from document content)
        const dateA = a.documentDate ? new Date(a.documentDate).getTime() : 0;
        const dateB = b.documentDate ? new Date(b.documentDate).getTime() : 0;
        return dateA - dateB;
      });

    // Build document timeline summary for AI context
    const documentTimelineContext = keyDocuments.length > 0 
      ? keyDocuments.map(d => {
          const dateLabel = d.documentDate 
            ? `${new Date(d.documentDate).toLocaleDateString()} (${d.dateSource === 'document' ? 'from document' : 'upload date'})`
            : 'Date unknown';
          const amountStr = d.amounts?.length > 0 
            ? ` | Amounts: ${d.amounts.map((a: any) => `$${a.amount?.toLocaleString()}`).join(', ')}`
            : '';
          const deadlineStr = d.deadline ? ` | DEADLINE: ${d.deadline}` : '';
          return `  - [${d.type?.toUpperCase()}] ${d.fileName} | ${dateLabel}${amountStr}${deadlineStr}${d.summary ? ` | ${d.summary}` : ''}`;
        }).join('\n')
      : '  No classified documents yet';

    // Build comprehensive context for AI
    const claimContext = `
=== CLAIM STRATEGIC ANALYSIS CONTEXT ===

CLAIM OVERVIEW:
- Claim #: ${claim.claim_number}
- Policyholder: ${claim.policyholder_name || claim.clients?.name || 'Unknown'}
- Property Address: ${propertyAddress}
- State: ${stateCode}
- Status: ${claim.status}
- Loss Type: ${claim.loss_type || 'Not specified'}
- Loss Date: ${claim.loss_date || 'Not specified'}
- Days Since Loss: ${daysSinceLoss ?? 'Unknown'}
- CRM Record Opened: ${claim.created_at ? new Date(claim.created_at).toLocaleDateString() : 'Unknown'}
- Days Open (CRM): ${daysOpen ?? 'Unknown'}
- First Documented Activity: ${firstDocumentDate ? firstDocumentDate.toLocaleDateString() : 'Same as CRM open date'}
- Days Between Loss and First Document: ${daysBetweenLossAndFirstDoc ?? 'Unknown'}
- Insurance Company: ${claim.insurance_company || 'Not specified'}
- Policy Number: ${claim.policy_number || 'Not specified'}
IMPORTANT REPORTING DELAY NOTE: "Days Since Loss" counts from the loss_date to TODAY, NOT from loss_date to claim open. To assess reporting delay, compare loss_date to the earliest document or claim creation date. If documents show earlier activity than the CRM record, use document dates as the true claim start.

FINANCIAL SNAPSHOT:
- Carrier Estimate (what carrier offered): $${carrierEstimate?.toLocaleString() || '0'}
- PA/Freedom Estimate (our demand): $${paEstimate ? paEstimate.toLocaleString() : 'Not set'}
- Estimate Difference (Gap): $${estimateDifference > 0 ? estimateDifference.toLocaleString() : 'N/A'}
- Total Settlement: $${totalSettlement?.toLocaleString() || '0'}
- Checks Received: $${totalChecksReceived?.toLocaleString() || '0'} (${checks.length} checks)
- Deductible: $${settlement?.deductible?.toLocaleString() || claim.deductible?.toLocaleString() || 'Unknown'}
- Recoverable Depreciation: $${settlement?.recoverable_depreciation?.toLocaleString() || '0'}
- Coverage Limits: Dwelling $${claim.dwelling_limit?.toLocaleString() || 'Unknown'}, ALE $${claim.ale_limit?.toLocaleString() || 'Unknown'}
NOTE: The "PA/Freedom Estimate" is the policyholder's actual demand. Use THIS as the claim value for all strategic calculations, NOT the carrier estimate.

EVIDENCE INVENTORY:
- Total Files: ${files.length}
- Photos: ${photoCount} (${categorizedPhotos.length} categorized, ${annotatedPhotos.length} annotated)
- Has Estimate: ${hasEstimate ? 'Yes' : 'NO - MISSING'}
- Has Denial Letter: ${hasDenialLetter ? 'Yes' : 'No'}
- Has Engineer Report: ${hasEngineerReport ? 'Yes — detected in: ' + allExpertFileNames.join(', ') : 'No'}
- Has Policy: ${hasPolicy ? 'Yes' : 'NO - RECOMMEND OBTAINING'}
- Has Proof of Loss: ${hasProofOfLoss ? 'Yes' : 'No'}
- Has Contractor Invoice: ${hasContractorInvoice ? 'Yes' : 'No'}
- Has Ordinance/Code Info: ${hasOrdinanceInfo ? 'Yes' : 'No'}
EXPERT REPORT DETECTION DEBUG: ${JSON.stringify(expertReportDebug)}
NOTE: If "Has Engineer Report" is Yes, do NOT generate a "No Expert Report" warning. Instead generate: "Expert report present — summarize findings + how it rebuts denial" with the file name(s).


DOCUMENT TIMELINE (based on ACTUAL document dates, not upload dates):
NOTE: These dates are extracted from the documents themselves. Use these for timeline analysis, deadline calculations, and carrier response tracking - NOT the upload dates.
${documentTimelineContext}

CLAIM EVENTS TIMELINE (chronological events with source attribution):
NOTE: Use this timeline to understand the TRUE sequence of events. Document-extracted dates are more reliable than system dates. For reporting delay analysis, look at the gap between loss_date and the EARLIEST documented event here, not just the CRM creation date.
${claimEventsContext}

DARWIN AI PHOTO ANALYSIS (CRITICAL EVIDENCE):
- AI-Analyzed Photos: ${aiAnalyzedPhotos.length} of ${photoCount}
- Photos with Poor/Failed Condition: ${poorConditionPhotos.length} (SUPPORTS DAMAGE CLAIM)
- Photos with Detected Damages: ${photosWithDamages.length}
- Materials Identified: ${uniqueMaterials.join(', ') || 'None analyzed yet'}
- Damage Types Detected: ${topDamageTypes.join(', ') || 'None detected yet'}
${allDetectedDamages.length > 0 ? `
DETAILED DAMAGE FINDINGS FROM PHOTOS:
${allDetectedDamages.slice(0, 15).map((d, i) => `  ${i + 1}. [${d.severity}] ${d.type} on ${d.material}: ${d.description}`).join('\n')}
${allDetectedDamages.length > 15 ? `  ... and ${allDetectedDamages.length - 15} more damages detected` : ''}
` : '- No AI damage analysis available yet - recommend running photo analysis'}
${poorConditionPhotos.length > 0 ? `
POOR CONDITION EVIDENCE (Use in rebuttals):
${poorConditionPhotos.slice(0, 5).map(p => `  - ${p.file_name}: ${p.ai_condition_rating} - ${p.ai_analysis_summary || p.ai_condition_notes || 'See full analysis'}`).join('\n')}
` : ''}

TIMELINE & ACTIVITY:
- Inspections: ${inspections.length} (${inspections.filter(i => i.status === 'completed').length} completed)
- Active Deadlines: ${deadlines.filter(d => d.status !== 'resolved').length}
- Overdue Deadlines: ${deadlines.filter(d => d.days_overdue && d.days_overdue > 0).length}
- Communications Logged: ${diary.length}
- Emails: ${emails.length}
- Open Tasks: ${tasks.filter(t => t.status !== 'completed').length}
- Adjuster(s): ${adjusters.map(a => `${a.adjuster_name} (${a.company || 'Unknown company'})`).join(', ') || 'None assigned'}

RECENT ACTIVITY (Last 5 items):
${emails.slice(0, 3).map(e => `- Email (${e.direction}): ${e.subject?.substring(0, 50)}... [${new Date(e.created_at).toLocaleDateString()}]`).join('\n')}
${diary.slice(0, 2).map(d => `- ${d.communication_type}: ${d.summary?.substring(0, 50)}... [${new Date(d.communication_date).toLocaleDateString()}]`).join('\n')}

STATE REGULATIONS (${stateInfo.stateName}):
- Prompt Pay: ${stateInfo.promptPayDays} days
- Acknowledgment Required: ${stateInfo.acknowledgmentDays} days
- Decision Required: ${stateInfo.decisionDays} days
- Bad Faith Statute: ${stateInfo.badFaithStatute}
- Admin Code: ${stateInfo.adminCode}

NOTES CONTEXT (Recent):
${notes.slice(0, 3).map(n => `- ${n.content?.substring(0, 100)}...`).join('\n') || 'No notes'}
`;

    // System prompt for strategic intelligence
    const systemPrompt = `You are Darwin, a strategic claims intelligence system for property insurance public adjusters. You think like a senior PA with decades of experience, but you also have comprehensive knowledge of:

- Insurance policy interpretation and coverage analysis
- ${stateInfo.stateName} insurance regulations (statutes and administrative codes only - NEVER cite case law)
- Building codes (IRC, IBC) and manufacturer specifications
- ASTM standards and industry best practices
- Carrier behavior patterns and negotiation tactics
- Evidence requirements and documentation standards

YOUR ROLE: Analyze claims strategically and form OPINIONS. You're not just reporting facts - you're identifying:
1. LEVERAGE POINTS - What gives the policyholder power in negotiations
2. COVERAGE TRIGGERS - If/then coverage opportunities (e.g., "wind damage + code upgrade needs = ordinance coverage demand")
3. EVIDENCE GAPS - What's missing that could hurt the claim
4. CARRIER WEAKNESSES - Delays, procedural violations, contradictions
5. TIMELINE RISKS - Deadlines, statute issues, bad faith indicators
6. NEXT STRATEGIC MOVES - What a senior PA would do right now

You must provide specific, actionable insights - not generic advice. Reference specific documents, dates, and regulations when relevant.

CRITICAL RULES:
- NEVER cite case law or legal precedents
- Focus on facts, regulations, building codes, and industry standards
- Be direct and opinionated - tell them what you think, not just what you see
- Prioritize by impact - what matters most right now
- Think like you're protecting a real family's financial recovery
- TIMELINE & BAD FAITH ANALYSIS: Use ONLY anchor event types (denial_issued, acknowledgement_issued, ror_issued, fnol_received, inspection, payment, estimate_issued, engineer_report_issued) for deadline calculations and carrier delay analysis. IGNORE date_mentioned and file_uploaded events — they are not evidence-based.
- CITATION REQUIREMENT: Every warning about carrier delays, bad faith, or statutory violations MUST cite the specific source file name and evidence snippet. If you cannot cite a specific document, downgrade the warning severity to "low" and append "(Needs Review — no source citation available)" to the title.
- When generating warnings, include a "citation" field with {"file_name": "...", "snippet": "..."} for each warning that references a document. Warnings without citations must have severity "low" and title suffixed with "(Needs Review)".`;

    let userPrompt = '';
    let responseFormat = '';
    let carrierIntelContext = '';

    if (analysisType === 'full_strategic_analysis') {
      userPrompt = `Analyze this claim and provide a comprehensive strategic assessment:

${claimContext}

Generate a COMPLETE strategic analysis. You MUST return ONLY valid JSON matching this EXACT structure (no markdown, no code blocks, just raw JSON):

{
  "health_score": {
    "coverage_strength": 75,
    "evidence_quality": 60,
    "leverage_score": 80,
    "timeline_risk": 50,
    "overall": 66
  },
  "warnings": [
    {
      "type": "deadline_risk|evidence_gap|coverage_opportunity|carrier_violation|documentation_issue|strategy_alert",
      "severity": "critical|high|medium|low (MUST be 'low' if no citation available)",
      "title": "Brief warning title (append '(Needs Review)' if no citation)",
      "message": "Detailed explanation",
      "suggested_action": "What to do",
      "citation": {"file_name": "source document name or null", "snippet": "evidence text or null"},
      "why": {"files_matched": ["filenames that triggered this"], "events_matched": ["event IDs/types"], "text_triggers": ["keywords found"], "rule_result": "explain how rule fired"}
    }
  ],
  "leverage_opportunities": [
    {
      "title": "Leverage point name",
      "description": "Why this creates pressure",
      "how_to_use": "Specific action to take"
    }
  ],
  "coverage_trigger_analysis": [
    {
      "trigger": "What condition exists",
      "coverage_opportunity": "What coverage this unlocks",
      "reasoning": "Why this applies",
      "confidence": "high|medium|low",
      "action_required": "What to do"
    }
  ],
  "evidence_assessment": {
    "strong_evidence": ["List of strong evidence"],
    "weak_missing_evidence": ["List of gaps or weak evidence"],
    "recommendations": ["Specific recommendations"]
  },
  "recommended_next_moves": [
    {
      "priority": 1,
      "action": "What to do",
      "timeline": "immediately|this_week|can_wait",
      "rationale": "Why this matters"
    }
  ],
  "senior_pa_opinion": "A 2-3 sentence opinion of what a senior PA would focus on and what could change the outcome."
}

CRITICAL: Return ONLY the JSON object. No explanation, no markdown formatting, no code blocks.`;

      responseFormat = 'strategic_analysis';
    } else if (analysisType === 'war_room_2') {
      // --- WAR ROOM 2.0: Expanded strategic intelligence ---
      // Fetch carrier behavior analytics for global intelligence context
      carrierIntelContext = '';
      if (claim.insurance_company) {
        const { data: carrierAnalytics } = await supabase
          .from('carrier_behavior_analytics')
          .select('*')
          .ilike('carrier_name', `%${claim.insurance_company.split(' ')[0]}%`)
          .limit(1)
          .maybeSingle();

        if (carrierAnalytics) {
          carrierIntelContext = `
GLOBAL CARRIER INTELLIGENCE (${carrierAnalytics.carrier_name}):
- Total Claims Analyzed: ${carrierAnalytics.total_claims_analyzed || 0}
- Avg Days to Deny: ${carrierAnalytics.avg_days_to_deny ?? 'N/A'}
- Avg Days to Pay: ${carrierAnalytics.avg_days_to_pay ?? 'N/A'}
- Initial Denial Rate: ${carrierAnalytics.initial_denial_rate ? (carrierAnalytics.initial_denial_rate * 100).toFixed(0) + '%' : 'N/A'}
- Reversal Rate After Engineer Report: ${carrierAnalytics.reversal_rate_after_engineer ? (carrierAnalytics.reversal_rate_after_engineer * 100).toFixed(0) + '%' : 'N/A'}
- Reversal Rate After Supplement: ${carrierAnalytics.reversal_rate_after_supplement ? (carrierAnalytics.reversal_rate_after_supplement * 100).toFixed(0) + '%' : 'N/A'}
- Litigation Frequency: ${carrierAnalytics.litigation_frequency ? (carrierAnalytics.litigation_frequency * 100).toFixed(0) + '%' : 'N/A'}
- Avg First Offer vs Final: ${carrierAnalytics.avg_first_offer_vs_final ? (carrierAnalytics.avg_first_offer_vs_final * 100).toFixed(0) + '%' : 'N/A'}
`;
        }
      }

      userPrompt = `Perform a WAR ROOM 2.0 comprehensive strategic analysis of this claim:

${claimContext}
${carrierIntelContext}

You MUST return ONLY valid JSON matching this EXACT structure (no markdown, no code blocks, just raw JSON):

{
  "wsi": {
    "total": 72,
    "components": {
      "coverage_strength": { "score": 75, "weight": 25, "explanation": "Why this score" },
      "evidence_quality": { "score": 60, "weight": 25, "explanation": "Why this score" },
      "negotiation_leverage": { "score": 80, "weight": 20, "explanation": "Why this score" },
      "procedural_compliance": { "score": 70, "weight": 15, "explanation": "Why this score" },
      "carrier_conduct_risk": { "score": 65, "weight": 15, "explanation": "Why this score" }
    }
  },
  "litigation_readiness": {
    "score": 55,
    "factors": {
      "expert_reports_present": { "met": false, "detail": "No engineer report on file" },
      "damages_quantified": { "met": true, "detail": "Estimate of $X on file" },
      "causation_documented": { "met": true, "detail": "Photos and timeline support causation" },
      "statutory_violations_logged": { "met": false, "detail": "No violations tracked yet" },
      "pre_suit_demand_drafted": { "met": false, "detail": "No demand letter sent" },
      "evidence_gaps_remaining": { "met": false, "detail": "Missing engineer report and code analysis" }
    }
  },
  "pressure_index": {
    "score": 65,
    "level": "moderate",
    "factors": {
      "statutory_violations": { "present": true, "detail": "Carrier exceeded 15-day response" },
      "missed_deadlines": { "present": false, "detail": "No missed deadlines" },
      "bad_faith_indicators": { "present": true, "detail": "Unreasonable delay pattern" },
      "complaint_exposure": { "present": false, "detail": "No DOI complaint filed" },
      "litigation_cost_risk": { "present": false, "detail": "Low complexity case" }
    }
  },
  "predicted_carrier_move": {
    "prediction": "Carrier will likely issue partial denial citing wear and tear within 14 days",
    "confidence": 72,
    "timeline": "within 14 days",
    "basis": ["Carrier pattern shows 62% initial denial for roof claims", "No engineer report yet"]
  },
  "strategic_memo": {
    "executive_summary": "Brief strategic overview of claim posture",
    "strongest_leverage": "What gives us the most negotiation power",
    "greatest_vulnerability": "Biggest weakness in the claim",
    "immediate_action": "What to do RIGHT NOW",
    "thirty_day_plan": "Step-by-step tactical plan for next 30 days",
    "escalation_trigger": "What condition would trigger escalation (NOI, complaint, litigation)",
    "settlement_range": "Estimated settlement range with reasoning",
    "bad_faith_viability": "Assessment of bad faith claim viability"
  },
  "scenario_simulations": [
    {
      "action": "obtain_engineer_report",
      "label": "What if we obtain an engineer report?",
      "result_wsi_delta": 12,
      "result_litigation_delta": 20,
      "result_pressure_delta": 5,
      "win_probability_range": "65-80%",
      "explanation": "Engineer report would strengthen evidence and causation documentation"
    },
    {
      "action": "send_noi",
      "label": "What if we send Notice of Intent?",
      "result_wsi_delta": 5,
      "result_litigation_delta": 15,
      "result_pressure_delta": 25,
      "win_probability_range": "60-75%",
      "explanation": "NOI creates statutory pressure and formal escalation path"
    },
    {
      "action": "escalate_supervisor",
      "label": "What if we escalate to supervisor?",
      "result_wsi_delta": 3,
      "result_litigation_delta": 0,
      "result_pressure_delta": 10,
      "win_probability_range": "55-70%",
      "explanation": "Supervisor escalation may expedite decision"
    },
    {
      "action": "file_doi_complaint",
      "label": "What if we file DOI complaint?",
      "result_wsi_delta": 2,
      "result_litigation_delta": 10,
      "result_pressure_delta": 30,
      "win_probability_range": "60-80%",
      "explanation": "DOI complaint creates regulatory pressure"
    }
  ],
  "warnings": [
    {
      "type": "deadline_risk|evidence_gap|coverage_opportunity|carrier_violation|documentation_issue|strategy_alert",
      "severity": "critical|high|medium|low (MUST be 'low' if no citation available)",
      "title": "Brief warning title (append '(Needs Review)' if no citation)",
      "message": "Detailed explanation",
      "suggested_action": "What to do",
      "citation": {"file_name": "source document name or null", "snippet": "evidence text or null"}
    }
  ],
  "leverage_opportunities": [
    {
      "title": "Leverage point name",
      "description": "Why this creates pressure",
      "how_to_use": "Specific action to take"
    }
  ],
  "coverage_trigger_analysis": [
    {
      "trigger": "What condition exists",
      "coverage_opportunity": "What coverage this unlocks",
      "reasoning": "Why this applies",
      "confidence": "high|medium|low",
      "action_required": "What to do"
    }
  ],
  "evidence_assessment": {
    "strong_evidence": ["List of strong evidence items"],
    "weak_missing_evidence": ["List of gaps or weak evidence"],
    "recommendations": ["Specific recommendations"],
    "required_by_loss_type": ["Evidence items required for this specific loss type"],
    "missing_evidence_risk_score": 35,
    "per_denial_defensive_evidence": [
      {
        "denial_reason": "Wear and tear",
        "required_evidence": ["Engineer report", "Material age documentation"],
        "have": ["Photos showing hail damage"],
        "missing": ["Engineer report"]
      }
    ]
  },
  "recommended_next_moves": [
    {
      "priority": 1,
      "action": "What to do",
      "timeline": "immediately|this_week|can_wait",
      "rationale": "Why this matters"
    }
  ],
  "counter_tactics": [
    {
      "trigger_condition": "IF carrier delays beyond 15 days",
      "recommended_action": "Send 10-day demand letter citing statute",
      "escalation_if_no_response": "File DOI complaint",
      "letter_type": "10_day_demand",
      "success_rate_estimate": 72
    }
  ],
  "senior_pa_opinion": "A 2-3 sentence opinion of what a senior PA would focus on."
}

CRITICAL RULES:
- Return ONLY the JSON object. No explanation, no markdown formatting, no code blocks.
- All scores are 0-100.
- scenario_simulations deltas are how much each score INCREASES if that action is taken. Deltas must be proportionate: small actions (escalate to supervisor) should yield small deltas (2-8), large actions (file complaint, obtain engineer report) yield larger deltas (10-25). No single action should delta more than 30.
- Pressure index level thresholds: "low" = score 0-39 (no strong carrier violations, compliance is acceptable), "moderate" = score 40-69 (some missed deadlines or procedural concerns), "high" = score 70-100 (multiple statutory violations, clear bad faith indicators, missed deadlines). Do NOT assign "high" unless at least 2 strong triggering factors exist.
- Do NOT cite case law. Reference statutes and admin codes only.
- Frame everything as strategic suggestions, not legal advice.
- TONE CALIBRATION: In the strategic_memo, NEVER use absolute language like "will win", "carrier is acting in bad faith", "guaranteed". Use hedged strategic language: "strategic exposure suggests...", "risk indicators show...", "likely carrier posture may include...", "evidence supports a strong position for...". You are a strategic advisor, not litigation counsel.
- Each WSI component explanation must reference specific evidence or facts from the claim context (e.g., "Policy on file shows Coverage A limits" not just "Coverage appears adequate").`;

      responseFormat = 'war_room_2';
    } else if (analysisType === 'quick_warnings') {
      userPrompt = `Quickly scan this claim for any critical warnings or issues that need immediate attention:

${claimContext}

Return ONLY warnings/alerts in JSON format:
{
  "warnings": [
    {
      "type": "deadline_risk|evidence_gap|coverage_opportunity|carrier_violation|documentation_issue|strategy_alert",
      "severity": "critical|high|medium|low",
      "title": "Brief warning title",
      "message": "Detailed explanation of the issue",
      "suggested_action": "What to do about it",
      "context": "Any relevant references (dates, documents, regulations)"
    }
  ]
}

Focus on actionable items. Don't generate warnings for things that are fine.`;

      responseFormat = 'warnings';
    } else if (analysisType === 'coverage_triggers') {
      // Two-stage pipeline:
      // 1) Deterministic extraction from existing claim_files.extracted_text (no assumptions)
      // 2) LLM decision constrained to extracted clauses with strict schema + discrete confidence buckets

      const { extractedPolicy, missingDocs: extractionMissingDocs } = extractPolicyFromClaimFiles(files, stateCode);

      // If no declarations/coverage evidence is found, enforce unknown with missing docs (no LLM guessing)
      const hasCoverageEvidence = extractedPolicy.coverages.length > 0;
      if (!hasCoverageEvidence) {
        const enforced: CoverageTriggerResult = {
          coverageTrigger: {
            decision: "unknown",
            confidence: 0,
            rationale: "No declarations/coverage evidence was found in the provided claim documents. Unable to determine coverage trigger without policy/declarations text.",
            missingDocs: extractionMissingDocs.length > 0 ? extractionMissingDocs : ["Declarations page"],
          },
          extractedPolicy,
          notesForUser: [
            "Upload a Declarations page (and/or full policy) so Darwin can extract coverages, limits, and deductibles.",
            "If this is an auto claim, include the declarations for the applicable vehicle and coverage selections.",
            "If this is a property claim, include declarations and relevant coverage sections (Dwelling/Other Structures/Personal Property/Loss of Use).",
          ],
        };

        return new Response(JSON.stringify({
          success: true,
          analysisType,
          result: enforced,
          claimNumber: claim.claim_number,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const claimSnapshot = {
        claim_number: claim.claim_number,
        loss_type: claim.loss_type || null,
        loss_date: claim.loss_date || null,
        status: claim.status || null,
        insurance_company: claim.insurance_company || null,
        deductible: settlement?.deductible ?? claim.deductible ?? null,
        has_denial_letter: files.some((f: any) => (f.document_classification || '').toLowerCase() === 'denial' || (f.file_name || '').toLowerCase().includes('denial')),
        has_estimate: files.some((f: any) => (f.document_classification || '').toLowerCase() === 'estimate' || (f.file_name || '').toLowerCase().includes('estimate')),
        photo_count: photos.length,
      };

      const system = `
You are Darwin, evaluating whether a coverage trigger is supported by the provided policy evidence and claim facts.

Hard rules:
- NO assumed coverage. If the extracted policy evidence is incomplete, use decision "unknown" and list missingDocs needed to become confident.
- You must use discrete confidence buckets ONLY: 0, 0.25, 0.5, 0.75, 1.
- Evidence quotes (if referenced) must be short (<= 25 words) and never fabricate page numbers.
- You are not a lawyer and do not provide legal advice.
`.trim();

      const task = `
You will be given:
1) Deterministically extracted policy evidence (authoritative; do not add new coverages not present).
2) A claim snapshot.

ExtractedPolicy (do NOT modify; treat as fixed evidence):
${JSON.stringify(extractedPolicy, null, 2)}

Claim snapshot:
${JSON.stringify(claimSnapshot, null, 2)}

Task:
Return ONLY valid JSON (no markdown) matching exactly:
{
  "coverageTrigger": {
    "decision": "triggered" | "not_triggered" | "unknown",
    "confidence": 0 | 0.25 | 0.5 | 0.75 | 1,
    "rationale": "short plain English",
    "missingDocs": ["..."]
  },
  "notesForUser": ["..."]
}

Rules:
- If extractedPolicy lacks a deductible OR limit for the most relevant coverage, confidence should not exceed 0.75.
- If extractedPolicy shows coverage exists but the claim facts are insufficient to decide trigger applicability, use "unknown" and explain what fact/doc is missing.
- missingDocs must include specific items that would move "unknown" → confident (e.g., "Declarations page", "Denial letter", "Carrier estimate", "Photos of damage", "Engineer report").
`.trim();

      const coverageResult = await callOpenAIText({
        system,
        user: task,
        reasoningEffort: 'high',
        temperature: 0.2,
        maxOutputTokens: 1500,
      });
      const content = coverageResult.text;

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        // Fail safe: unknown with extraction missing docs
        parsed = {
          coverageTrigger: {
            decision: "unknown",
            confidence: 0.25,
            rationale: "Unable to parse a strict coverage trigger decision. Additional documentation is required to make a defensible determination.",
            missingDocs: extractionMissingDocs.length ? extractionMissingDocs : ["Declarations page"],
          },
          notesForUser: [
            "Provide the declarations page and relevant policy sections to enable a strict, evidence-based coverage trigger determination.",
          ],
        };
      }

      const mergedMissingDocs = Array.from(new Set([
        ...(extractionMissingDocs || []),
        ...((parsed?.coverageTrigger?.missingDocs as string[]) || []),
      ]));

      const finalResult: CoverageTriggerResult = {
        coverageTrigger: {
          decision: parsed?.coverageTrigger?.decision || "unknown",
          confidence: parsed?.coverageTrigger?.confidence ?? 0.25,
          rationale: parsed?.coverageTrigger?.rationale || "Coverage trigger analysis completed.",
          missingDocs: mergedMissingDocs,
        },
        extractedPolicy,
        notesForUser: Array.isArray(parsed?.notesForUser) ? parsed.notesForUser : [],
      };

      return new Response(JSON.stringify({
        success: true,
        analysisType,
        result: finalResult,
        claimNumber: claim.claim_number
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } else {
      userPrompt = `Provide a brief strategic overview of this claim:

${claimContext}

Give me:
1. One-sentence claim health assessment
2. Top 3 priorities right now
3. Biggest risk or opportunity
4. What a senior PA would focus on`;

      responseFormat = 'overview';
    }

    console.log(`Strategic analysis type: ${analysisType} for claim ${claimId}`);

    const aiResult = await callOpenAIText({
      system: systemPrompt,
      user: userPrompt,
      reasoningEffort: 'high',
      temperature: 0.3,
      maxOutputTokens: 8000,
    });

    const result = aiResult.text;

    if (!result) {
      throw new Error('No response from AI');
    }

    // Try to parse as JSON if applicable
    let parsedResult: any = result;
    if (responseFormat !== 'overview') {
      try {
        // Clean up markdown code blocks if present
        let cleanedResult = result;
        if (result.includes('```json')) {
          cleanedResult = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        } else if (result.includes('```')) {
          cleanedResult = result.replace(/```\n?/g, '').trim();
        }
        parsedResult = JSON.parse(cleanedResult);
      } catch (e) {
        console.log('Result is not JSON, returning as text');
        parsedResult = { text: result };
      }
    }

    // Store the insights in the database
    if (analysisType === 'full_strategic_analysis' && typeof parsedResult === 'object') {
      const healthScore = parsedResult.health_score || parsedResult.healthScore || {};
      const warnings = parsedResult.warnings || parsedResult.critical_warnings || [];
      const leveragePoints = parsedResult.leverage_opportunities || parsedResult.leveragePoints || [];
      const coverageTriggers = parsedResult.coverage_trigger_analysis || parsedResult.coverageTriggers || [];
      const evidenceGaps = parsedResult.evidence_assessment?.weak_missing_evidence || [];
      const nextMoves = parsedResult.recommended_next_moves || parsedResult.nextMoves || [];
      const seniorPaOpinion = parsedResult.senior_pa_opinion || parsedResult.seniorPaOpinion || '';

      // Fetch matching carrier playbooks based on claim conditions
      let matchedPlaybooks: any[] = [];
      if (claim.insurance_company) {
        const { data: playbooks } = await supabase
          .from('carrier_playbooks')
          .select('*')
          .eq('is_active', true)
          .ilike('carrier_name', `%${claim.insurance_company.split(' ')[0]}%`)
          .order('priority', { ascending: true })
          .limit(10);
        
        if (playbooks && playbooks.length > 0) {
          // Match playbooks to current claim conditions
          const claimAge = daysOpen || 0;
          const hasSupplementPending = claim.status?.toLowerCase().includes('supplement');
          const checksCount = checks.length;
          
          matchedPlaybooks = playbooks.filter((pb: any) => {
            const trigger = pb.trigger_condition;
            if (!trigger || typeof trigger !== 'object') return true; // General tactics
            
            // Check delay conditions
            if (trigger.delay_days?.gte && claimAge >= trigger.delay_days.gte) return true;
            if (trigger.days_waiting?.gte && claimAge >= trigger.days_waiting.gte) return true;
            
            // Check supplement conditions
            if (trigger.supplement_pending && hasSupplementPending) return true;
            
            // Check denial conditions
            if (trigger.first_denial && hasDenialLetter) return true;
            
            // Check engineer report conditions
            if (trigger.engineer_report_received && hasEngineerReport) return true;
            
            // Check communication gaps
            if (trigger.communication_gap_days?.gte) {
              const lastComm = diary[0]?.communication_date;
              if (lastComm) {
                const daysSinceComm = Math.floor((Date.now() - new Date(lastComm).getTime()) / (1000 * 60 * 60 * 24));
                if (daysSinceComm >= trigger.communication_gap_days.gte) return true;
              }
            }
            
            return false;
          }).slice(0, 5);
        }
      }

      console.log(`Matched ${matchedPlaybooks.length} carrier playbooks for ${claim.insurance_company}`);

      // Upsert strategic insights
      const { error: upsertError } = await supabase
        .from('claim_strategic_insights')
        .upsert({
          claim_id: claimId,
          coverage_strength_score: healthScore.coverage_strength ?? healthScore.coverageStrength ?? null,
          evidence_quality_score: healthScore.evidence_quality ?? healthScore.evidenceQuality ?? null,
          leverage_score: healthScore.leverage_score ?? healthScore.leverageScore ?? null,
          timeline_risk_score: healthScore.timeline_risk ?? healthScore.timelineRisk ?? null,
          overall_health_score: healthScore.overall ?? healthScore.overallHealthScore ?? null,
          warnings: warnings,
          leverage_points: leveragePoints,
          coverage_triggers_detected: coverageTriggers,
          evidence_gaps: evidenceGaps,
          recommended_next_moves: nextMoves,
          matched_playbooks: matchedPlaybooks,
          senior_pa_opinion: typeof seniorPaOpinion === 'string' ? seniorPaOpinion : JSON.stringify(seniorPaOpinion),
          last_analyzed_at: new Date().toISOString(),
          analysis_version: '1.0'
        }, {
          onConflict: 'claim_id'
        });

      if (upsertError) {
        console.error('Error saving insights:', upsertError);
      } else {
        console.log('Strategic insights saved successfully for claim', claimId);
      }

      // Log warnings for tracking
      if (Array.isArray(warnings) && warnings.length > 0) {
        const warningsToInsert = warnings.map((w: any) => ({
          claim_id: claimId,
          warning_type: w.type || 'strategy_alert',
          severity: w.severity || 'medium',
          title: w.title || 'Warning',
          message: w.message || w.description || '',
          suggested_action: w.suggested_action || w.action || '',
          context: w.context ? JSON.stringify(w.context) : null,
          shown_in_context: 'insights_panel'
        }));

        await supabase.from('claim_warnings_log').insert(warningsToInsert);
      }
    }

    // Store WAR ROOM 2.0 insights
    if (analysisType === 'war_room_2' && typeof parsedResult === 'object' && parsedResult.wsi) {
      const wsi = parsedResult.wsi || {};
      const litReadiness = parsedResult.litigation_readiness || {};
      const pressure = parsedResult.pressure_index || {};
      const warnings = parsedResult.warnings || [];
      const leveragePoints = parsedResult.leverage_opportunities || [];
      const coverageTriggers = parsedResult.coverage_trigger_analysis || [];
      const evidenceGaps = parsedResult.evidence_assessment?.weak_missing_evidence || [];
      const nextMoves = parsedResult.recommended_next_moves || [];
      const seniorPaOpinion = parsedResult.senior_pa_opinion || '';

      // Fetch current weight version
      const { data: weightVersion } = await supabase
        .from('strategic_weight_versions')
        .select('version_name')
        .order('effective_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      const currentWeightVersion = weightVersion?.version_name || 'v1';

      // Build confidence scores from rule-based assessment
      const carrierDataCount = carrierIntelContext ? 1 : 0;
      const evidenceCount = files.length + photos.length;
      const dataPoints = evidenceCount + emails.length + diary.length + deadlines.length + checks.length;
      const confidenceLevel = dataPoints >= 20 ? 'high' : dataPoints >= 8 ? 'medium' : 'low';
      const confidenceScores = {
        overall: confidenceLevel,
        data_basis_count: dataPoints,
        carrier_pattern_match: carrierDataCount > 0,
        evidence_volume: evidenceCount,
        wsi: { level: confidenceLevel, basis: `${evidenceCount} evidence items, ${emails.length} emails` },
        predicted_move: { level: carrierDataCount > 0 && dataPoints >= 10 ? 'medium' : 'low', basis: carrierDataCount > 0 ? 'Carrier pattern data available' : 'No carrier history' },
        pressure_index: { level: deadlines.length > 0 ? 'high' : 'medium', basis: `${deadlines.length} deadlines tracked` },
        scenarios: { level: dataPoints >= 15 ? 'medium' : 'low', basis: `${dataPoints} total data points` },
      };

      // Build raw inputs snapshot for reconstructability
      const rawInputs = {
        files_count: files.length,
        photos_count: photos.length,
        emails_count: emails.length,
        checks_count: checks.length,
        deadlines_count: deadlines.length,
        diary_count: diary.length,
        inspections_count: inspections.length,
        has_estimate: hasEstimate,
        has_denial: hasDenialLetter,
        has_engineer: hasEngineerReport,
        has_policy: hasPolicy,
        days_open: daysOpen,
        days_since_loss: daysSinceLoss,
        estimate_amount: estimateAmount,
        total_settlement: totalSettlement,
        state_code: stateCode,
        carrier: claim.insurance_company,
        loss_type: claim.loss_type,
      };

      // Fetch matching carrier playbooks
      let matchedPlaybooks: any[] = [];
      if (claim.insurance_company) {
        const { data: playbooks } = await supabase
          .from('carrier_playbooks')
          .select('*')
          .eq('is_active', true)
          .ilike('carrier_name', `%${claim.insurance_company.split(' ')[0]}%`)
          .order('priority', { ascending: true })
          .limit(10);
        
        if (playbooks && playbooks.length > 0) {
          const claimAge = daysOpen || 0;
          matchedPlaybooks = playbooks.filter((pb: any) => {
            const trigger = pb.trigger_condition;
            if (!trigger || typeof trigger !== 'object') return true;
            if (trigger.delay_days?.gte && claimAge >= trigger.delay_days.gte) return true;
            if (trigger.first_denial && hasDenialLetter) return true;
            if (trigger.engineer_report_received && hasEngineerReport) return true;
            return false;
          }).slice(0, 5);
        }
      }

      // Upsert strategic insights with War Room 2.0 fields + confidence & raw inputs
      const { error: upsertError } = await supabase
        .from('claim_strategic_insights')
        .upsert({
          claim_id: claimId,
          // Legacy fields (backward compat)
          coverage_strength_score: wsi.components?.coverage_strength?.score ?? null,
          evidence_quality_score: wsi.components?.evidence_quality?.score ?? null,
          leverage_score: wsi.components?.negotiation_leverage?.score ?? null,
          timeline_risk_score: null,
          overall_health_score: wsi.total ?? null,
          // War Room 2.0 fields
          wsi_score: wsi.total ?? null,
          wsi_components: wsi.components ?? null,
          procedural_compliance_score: wsi.components?.procedural_compliance?.score ?? null,
          carrier_conduct_risk_score: wsi.components?.carrier_conduct_risk?.score ?? null,
          litigation_readiness_score: litReadiness.score ?? null,
          litigation_readiness_factors: litReadiness.factors ?? null,
          pressure_index_score: pressure.score ?? null,
          pressure_index_level: pressure.level ?? null,
          pressure_index_factors: pressure.factors ?? null,
          strategic_memo: parsedResult.strategic_memo ?? null,
          predicted_carrier_move: parsedResult.predicted_carrier_move ?? null,
          scenario_simulations: parsedResult.scenario_simulations ?? null,
          // War Room 2.0 hardening fields
          confidence_scores: confidenceScores,
          raw_inputs: rawInputs,
          weight_version: currentWeightVersion,
          model_type: 'hybrid',
          // Shared fields
          warnings: warnings,
          leverage_points: leveragePoints,
          coverage_triggers_detected: coverageTriggers,
          evidence_gaps: evidenceGaps,
          recommended_next_moves: nextMoves,
          counter_strategies: parsedResult.counter_tactics ?? null,
          matched_playbooks: matchedPlaybooks,
          senior_pa_opinion: typeof seniorPaOpinion === 'string' ? seniorPaOpinion : JSON.stringify(seniorPaOpinion),
          last_analyzed_at: new Date().toISOString(),
          analysis_version: '2.0'
        }, {
          onConflict: 'claim_id'
        });

      if (upsertError) {
        console.error('Error saving War Room 2.0 insights:', upsertError);
      } else {
        console.log('War Room 2.0 insights saved for claim', claimId);
      }

      // === STRATEGIC SNAPSHOT (every run) ===
      // Detect strategic drift by comparing to previous snapshot
      let driftFlag = false;
      let driftReason: string | null = null;
      const { data: prevSnapshots } = await supabase
        .from('claim_strategic_snapshots')
        .select('wsi, pressure_index, litigation_readiness, created_at')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .limit(2);

      if (prevSnapshots && prevSnapshots.length >= 2) {
        const [prev1, prev2] = prevSnapshots;
        const currentWsi = wsi.total ?? 0;
        // WSI declined 2 runs in a row
        if (prev1.wsi !== null && prev2.wsi !== null && currentWsi < prev1.wsi && prev1.wsi < prev2.wsi) {
          driftFlag = true;
          driftReason = `WSI declined 3 consecutive runs: ${prev2.wsi} → ${prev1.wsi} → ${currentWsi}`;
        }
        // Pressure Index decreased after it was previously higher (potential escalation failure)
        if (prev1.pressure_index !== null && (pressure.score ?? 0) < prev1.pressure_index) {
          // Only flag if we had high pressure before
          if (prev1.pressure_index >= 65) {
            driftFlag = true;
            driftReason = (driftReason ? driftReason + '. ' : '') + `Pressure Index dropped from ${prev1.pressure_index} to ${pressure.score ?? 0} — review escalation effectiveness`;
          }
        }
      } else if (prevSnapshots && prevSnapshots.length === 1) {
        const prev = prevSnapshots[0];
        const currentWsi = wsi.total ?? 0;
        if (prev.wsi !== null && currentWsi < prev.wsi) {
          // Single decline — note but don't flag yet
          console.log(`WSI declined: ${prev.wsi} → ${currentWsi} (1 run, not flagging yet)`);
        }
      }

      await supabase.from('claim_strategic_snapshots').insert({
        claim_id: claimId,
        wsi: wsi.total ?? null,
        pressure_index: pressure.score ?? null,
        pressure_level: pressure.level ?? null,
        litigation_readiness: litReadiness.score ?? null,
        predicted_move: parsedResult.predicted_carrier_move ?? null,
        confidence_scores: confidenceScores,
        raw_inputs: rawInputs,
        weight_version: currentWeightVersion,
        strategic_drift_flag: driftFlag,
        drift_reason: driftReason,
      });

      console.log(`Strategic snapshot saved for claim ${claimId}${driftFlag ? ' [DRIFT DETECTED]' : ''}`);

      // Store predictive analysis
      if (parsedResult.predicted_carrier_move) {
        const pred = parsedResult.predicted_carrier_move;
        await supabase.from('claim_predictive_analysis').insert({
          claim_id: claimId,
          prediction_type: 'carrier_next_move',
          prediction: pred.prediction,
          confidence: pred.confidence,
          basis: pred.basis,
          predicted_timeline: pred.timeline,
          data_basis_count: dataPoints,
          model_type: 'hybrid',
        });
      }

      // Store scenario simulations
      if (Array.isArray(parsedResult.scenario_simulations)) {
        // Clear old simulations for this claim
        await supabase.from('claim_scenario_simulations').delete().eq('claim_id', claimId);
        
        const simRows = parsedResult.scenario_simulations.map((s: any) => ({
          claim_id: claimId,
          scenario_action: s.action,
          scenario_label: s.label,
          result_wsi: (wsi.total ?? 0) + (s.result_wsi_delta ?? 0),
          result_litigation_readiness: (litReadiness.score ?? 0) + (s.result_litigation_delta ?? 0),
          result_pressure_index: (pressure.score ?? 0) + (s.result_pressure_delta ?? 0),
          result_win_probability_range: s.win_probability_range,
          result_explanation: s.explanation,
          projected_wsi_delta: s.result_wsi_delta ?? 0,
          projected_litigation_delta: s.result_litigation_delta ?? 0,
          projected_pressure_delta: s.result_pressure_delta ?? 0,
          confidence_score: confidenceScores.scenarios?.level === 'high' ? 80 : confidenceScores.scenarios?.level === 'medium' ? 55 : 30,
          data_basis_count: dataPoints,
          model_type: 'hybrid',
        }));
        
        if (simRows.length > 0) {
          await supabase.from('claim_scenario_simulations').insert(simRows);
        }
      }

      // Log warnings
      if (Array.isArray(warnings) && warnings.length > 0) {
        const warningsToInsert = warnings.map((w: any) => ({
          claim_id: claimId,
          warning_type: w.type || 'strategy_alert',
          severity: w.severity || 'medium',
          title: w.title || 'Warning',
          message: w.message || w.description || '',
          suggested_action: w.suggested_action || w.action || '',
          context: w.context ? JSON.stringify(w.context) : null,
          shown_in_context: 'war_room_2'
        }));
        await supabase.from('claim_warnings_log').insert(warningsToInsert);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      analysisType,
      result: parsedResult,
      claimNumber: claim.claim_number
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Strategic intelligence error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
