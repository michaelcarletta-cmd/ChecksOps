/**
 * Helper functions for darwin-copilot — extracted to reduce index.ts size.
 */

import { isGarbageText } from "../document-intelligence-types.ts";

export function getLatestUserTurn(userQuestion?: string, conversationHistory?: Array<{ role?: string; content?: string }>) {
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

export function isExplicitDraftOrActionRequest(message: string) {
  return /\b(?:draft|write|compose|prepare|generate|create|add|make|log)\b[\s\S]{0,40}\b(?:email|letter|message|note|task|todo|reminder|update|timeline entry|activity|sms|text message)\b|\b(?:email|letter|message|note|task|todo|reminder|update|timeline entry|activity|sms|text message)\b[\s\S]{0,20}\b(?:draft|write|compose|prepare|generate|create|add|make|log)\b/i.test(message);
}

export function isSmsDraftRequest(message: string) {
  return /\b(?:draft|write|compose|prepare|generate|create|send)\b[\s\S]{0,60}\b(?:sms|text message|text msg|text update|text the client|text the homeowner|text the insured)\b|\b(?:sms|text message|text msg|text update)\b[\s\S]{0,30}\b(?:draft|write|compose|prepare|generate|create)\b|\bdraft\b[\s\S]{0,30}\bsms\b/i.test(message);
}

export function isEmailDraftRequest(message: string) {
  return /\b(?:draft|write|compose|prepare|generate|create|send)\b[\s\S]{0,60}\b(?:email|e-mail|client update email|update email|client email)\b|\b(?:email|e-mail|client update email)\b[\s\S]{0,30}\b(?:draft|write|compose|prepare|generate|create)\b|\bdraft\b[\s\S]{0,30}\b(?:email|e-mail)\b/i.test(message);
}

export function humanizeClaimText(value: string | null | undefined, fallback = 'Unknown') {
  const text = (value || '').trim();
  if (!text) return fallback;
  return text
    .replace(/[\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

export function summarizeStructuredValue(value: unknown, fallback = 'N/A') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return fallback;
    return value.map(v => {
      if (typeof v === 'string') return v;
      if (typeof v === 'object' && v !== null) {
        const vals = Object.entries(v).map(([k, vv]) => `${k}: ${vv}`);
        return vals.join(', ');
      }
      return String(v);
    }).join('; ');
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return fallback;
    const meaningful = entries.filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (meaningful.length === 0) return fallback;
    return meaningful.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
  }
  return fallback;
}

export function getClientFirstName(name?: string | null) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  return parts[0] || '';
}

export function stripLeadingDateTag(value: string | null | undefined) {
  return (value || '').replace(/^\[\d{1,2}\/\d{1,2}\/\d{2,4}\]\s*/, '').trim();
}

export function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function isDraftClarificationResponse(message: string) {
  const lcm = message.toLowerCase();
  return /\b(?:could you|can you|please|specify|which|would you like|tell me|what kind|what type|i'd be happy to|just let me know|i can help|sure|absolutely|happy to help)\b/.test(lcm) &&
    message.length < 300 &&
    !message.includes('Subject:') &&
    !message.includes('Dear ');
}

export function isAskingForClarification(message: string) {
  const lcm = (message || '').toLowerCase();
  return (/\b(could you|can you|please|specify|which|would you like|tell me|what kind|what type|want me to|do you want|shall i|let me know|what specifically|could you clarify|i'd need|i need you to|please share|please provide|could you share|could you provide|which note are you referring|which document|which file)\b/.test(lcm) &&
    message.length < 400 &&
    !message.includes('Subject:'));
}

export function containsForbiddenDraftPhrase(message: string) {
  return /reviewing your claim details|will contact you shortly|updated your claim file|we will be in touch shortly|check the portal for details|please check the portal/i.test(message);
}

export function isAnalysisQuestion(message: string) {
  return /\b(what|why|how|explain|analyze|tell me|describe|compare|assess|is there|are there|can they|should I|would it|could we)\b/i.test(message);
}

export function isDismantleRequest(message: string) {
  return /\b(dismantl|tear apart|rip apart|break down|critique|counter.?argue|find (the )?(weak|flaw|hole|gap)|attack (their|the|this))\b/i.test(message);
}

export function startsWithActionConfirmation(message: string) {
  const first100 = (message || '').slice(0, 100).toLowerCase();
  return /^(note added|task created|email drafted|reminder set|activity logged|timeline entry|update saved|i've (added|created|saved|logged)|here's the note|done|got it|sure thing)/.test(first100);
}

export function looksLikeToolStyleFailure(message: string) {
  const first60 = (message || '').slice(0, 60);
  return /^\s*\{?\s*"?(action|tool|function)/.test(first60);
}

export function shouldExcludeAssistantHistory(message: string) {
  const lcm = (message || '').toLowerCase();
  return lcm.startsWith('note added') || lcm.startsWith('task created') || lcm.startsWith('email drafted') ||
    lcm.includes('✅ saved') || (lcm.includes('created successfully') && lcm.length < 120);
}

export function hasMeaningfulValue(value: unknown) {
  if (!value) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export function isLikelyTechnicalPdfSummary(summary: string) {
  return /^(PDF|This document|The file|This is a|Document contains|This PDF|The PDF)/i.test(summary);
}

export function hasUsableDocumentIntel(row: Record<string, unknown>) {
  const hasSummary = typeof row.summary === 'string' && row.summary.length > 50 && !isLikelyTechnicalPdfSummary(row.summary);
  const hasDenialReasons = hasMeaningfulValue(row.denial_reasons);
  const hasCoveragePosition = hasMeaningfulValue(row.coverage_position);
  const hasExclusions = hasMeaningfulValue(row.exclusions);
  const hasContradictions = hasMeaningfulValue(row.contradictions);
  const hasExtractedFacts = hasMeaningfulValue(row.extracted_facts);
  const hasCauseOfLoss = typeof row.cause_of_loss === 'string' && row.cause_of_loss.length > 10;
  const hasEstimateTotals = hasMeaningfulValue(row.estimate_totals);
  const hasScopePositions = hasMeaningfulValue(row.scope_positions);
  const hasTestingDone = hasMeaningfulValue(row.testing_done);
  const hasTestingMissing = hasMeaningfulValue(row.testing_missing);
  const hasCodeRefs = hasMeaningfulValue(row.code_refs);
  const hasMfgRefs = hasMeaningfulValue(row.manufacturer_refs);
  const meaningfulFields = [hasSummary, hasDenialReasons, hasCoveragePosition, hasExclusions, hasContradictions, hasExtractedFacts, hasCauseOfLoss, hasEstimateTotals, hasScopePositions, hasTestingDone, hasTestingMissing, hasCodeRefs, hasMfgRefs].filter(Boolean).length;
  return meaningfulFields >= 2;
}

export function asksForDocumentReupload(message: string) {
  const lcm = (message || '').toLowerCase();
  return (
    (/upload|provide|share|send|paste|attach/.test(lcm)) &&
    (/denial|coverage decision|reservation of rights|letter|document|file|report/.test(lcm)) &&
    (/so I can|in order to|for me to|then I can|I'll be able|need to see|need access/.test(lcm))
  );
}

export function givesGenericFrameworkResponse(message: string) {
  if (!message || message.length < 100) return false;
  const lcm = message.toLowerCase();
  const frameworkPatterns = [
    /here(?:'s| is) (?:a |the |an |my )(?:comprehensive |strategic |detailed )?(?:framework|roadmap|approach|plan|methodology|overview)/,
    /let me (?:outline|lay out|walk you through|present) (?:a |the |our |my )?(?:comprehensive |strategic |step-by-step )?(?:framework|roadmap|approach|plan)/,
    /step \d+:.*\n.*step \d+:.*\n.*step \d+:/,
    /phase \d+:.*\n.*phase \d+:/,
    /^\d+\.\s+\*\*[^*]+\*\*\s*\n.*\n\d+\.\s+\*\*[^*]+\*\*\s*\n.*\n\d+\.\s+\*\*[^*]+\*\*/m,
  ];
  const hasFrameworkStructure = frameworkPatterns.some(p => p.test(lcm));
  if (!hasFrameworkStructure) return false;
  const hasSpecificClaimFacts = /\$[\d,]+|claim.{0,5}number|policy.{0,5}number|dated?\s+\d{1,2}[\/\-]\d{1,2}|\b20\d{2}\b/.test(message);
  return !hasSpecificClaimFacts;
}

export function isGarbageTextInline(text: string): boolean {
  if (typeof isGarbageText === 'function') {
    try { return isGarbageText(text); } catch { /* fall through */ }
  }
  const ratio = (text.match(/[^a-zA-Z0-9\s.,;:!?'"()\-]/g) || []).length / text.length;
  return ratio > 0.35;
}

export interface DraftFacts {
  claim_number: string;
  property_address: string;
  carrier: string;
  claim_status: string;
  loss_type: string;
  loss_date: string;
  last_contact_date: string;
  last_contact_with: string;
  last_contact_subject: string;
  latest_note: string;
  latest_update: string;
  next_action: string;
  pending_deadlines: string[];
  has_correspondence: boolean;
  has_notes: boolean;
}

export function buildDeterministicClientDraft(opts: {
  draftType: 'sms' | 'email';
  clientName: string;
  facts: DraftFacts;
}) {
  const { draftType, clientName, facts } = opts;
  const firstName = getClientFirstName(clientName);
  const greeting = firstName || 'there';
  const statusPhrase = facts.claim_status !== 'Unknown' ? ` is currently in "${facts.claim_status}" status` : '';
  const lastContactPhrase = facts.last_contact_date !== 'No recent contact'
    ? ` Our last contact was on ${facts.last_contact_date}${facts.last_contact_with !== 'N/A' ? ` with ${facts.last_contact_with}` : ''}.`
    : '';
  const nextActionPhrase = facts.next_action !== 'Review claim and determine next steps'
    ? ` Next step: ${stripLeadingDateTag(facts.next_action)}.`
    : '';
  const deadlinePhrase = facts.pending_deadlines.length > 0
    ? ` Upcoming deadline: ${facts.pending_deadlines[0]}.`
    : '';

  if (draftType === 'sms') {
    return collapseWhitespace(`Hi ${greeting}, update on your ${facts.carrier} claim (${facts.claim_number}): Your claim${statusPhrase}.${lastContactPhrase}${nextActionPhrase}${deadlinePhrase} Questions? Reply to this message.`);
  }

  return `Subject: Update on Your ${facts.carrier} Claim — ${facts.claim_number}

Dear ${greeting},

I wanted to provide you with an update on your insurance claim with ${facts.carrier} (Claim #${facts.claim_number}) for your property at ${facts.property_address}.

Your claim${statusPhrase}.${lastContactPhrase}

${nextActionPhrase ? `Our next step is: ${stripLeadingDateTag(facts.next_action)}.` : 'We are actively working on your claim and will keep you informed of any developments.'}
${deadlinePhrase ? `\nPlease note: ${deadlinePhrase}` : ''}
If you have any questions or concerns, please don't hesitate to reach out.

Best regards`;
}

/** Download PDF from storage and OCR via vision AI */
export async function inlineOcrFromStorage(supabase: any, filePath: string, fileName: string): Promise<string | null> {
  try {
    const { callVision, MODEL_VISION } = await import("./generate.ts");

    const { data: fileBlob, error: dlError } = await supabase.storage
      .from('claim-files')
      .download(filePath);

    if (dlError || !fileBlob) {
      console.warn(`[Copilot OCR] Download failed for ${fileName}:`, dlError);
      return null;
    }

    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    if (bytes.length > 10 * 1024 * 1024) {
      console.warn(`[Copilot OCR] File too large for inline OCR: ${fileName} (${bytes.length} bytes)`);
      return null;
    }

    const isPdf = fileName.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      try {
        const { extractPdfNative, isNativeExtractionUsable } = await import("../pdfNativeExtract.ts");
        const native = await extractPdfNative(bytes, { fileName });
        if (isNativeExtractionUsable(native)) {
          console.log(`[Copilot OCR] native PDF extract OK: ${fileName} chars=${native.charCount} status=${native.status}`);
          return native.text;
        }
        console.log(`[Copilot OCR] native PDF unusable (status=${native.status}), falling back to vision OCR for ${fileName}`);
      } catch (nativeErr) {
        console.warn(`[Copilot OCR] native PDF extract failed for ${fileName}, falling back to vision:`, nativeErr);
      }
    }

    const chunks: string[] = [];
    const chunkSize = 32768;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      chunks.push(String.fromCharCode(...chunk));
    }
    const base64 = btoa(chunks.join(''));
    const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';

    const result = await callVision({
      model: MODEL_VISION,
      messages: [
        { role: 'system', content: 'Extract ALL text content from this document. Return the raw text exactly as it appears, preserving all dates, numbers, names, addresses, policy numbers, exclusion language, and legal text. Do not summarize or interpret. Preserve paragraph structure.' },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: 'Extract all text from this document. Return only the raw text content, preserving structure and legal language.' }
        ]}
      ],
      temperature: 0.1,
    });

    console.log(`[Copilot OCR] model=${result.model}`);
    return result.text || null;
  } catch (error) {
    console.error(`[Copilot OCR] Error:`, error);
    return null;
  }
}
