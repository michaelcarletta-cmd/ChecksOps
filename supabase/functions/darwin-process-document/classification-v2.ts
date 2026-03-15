export type DocumentClassification =
  | 'estimate'
  | 'denial'
  | 'approval'
  | 'rfi'
  | 'engineering_report'
  | 'policy'
  | 'correspondence'
  | 'invoice'
  | 'photo'
  | 'other';

export interface ClassificationCandidate {
  classification: DocumentClassification;
  confidence: number;
  source: 'filename' | 'regex' | 'ai_primary' | 'ai_verify' | 'page_signal';
  reasons: string[];
}

export interface SmartClassificationResult {
  primary: DocumentClassification;
  confidence: number;
  candidates: ClassificationCandidate[];
  method: string;
  document_family: string;
  review_required: boolean;
  is_mixed_document: boolean;
  automation_safe: boolean;
  reasoning: Record<string, unknown>;
}

const CLASS_KEYWORDS: Record<DocumentClassification, RegExp[]> = {
  denial: [
    /deny|denied|denial/i,
    /unable to extend coverage/i,
    /not covered/i,
    /reservation of rights/i,
    /coverage is declined/i,
  ],
  estimate: [
    /estimate/i,
    /xactimate/i,
    /replacement cost value/i,
    /\bRCV\b/i,
    /\bACV\b/i,
    /line item/i,
    /scope of repairs/i,
  ],
  approval: [
    /coverage has been afforded/i,
    /we are issuing payment/i,
    /approved/i,
    /payment enclosed/i,
    /actual cash value/i,
  ],
  rfi: [
    /request for information/i,
    /please provide/i,
    /documentation requested/i,
    /proof of loss/i,
    /examination under oath/i,
  ],
  engineering_report: [
    /engineer/i,
    /engineering report/i,
    /cause of loss/i,
    /inspection findings/i,
    /licensed professional engineer/i,
  ],
  policy: [
    /policy number/i,
    /policy period/i,
    /declarations/i,
    /named insured/i,
    /endorsement/i,
    /coverage forms/i,
  ],
  correspondence: [
    /regards/i,
    /sincerely/i,
    /dear/i,
    /re:/i,
  ],
  invoice: [
    /invoice/i,
    /balance due/i,
    /amount due/i,
    /paid on/i,
    /receipt/i,
    /order confirmation/i,
  ],
  photo: [
    /photo report/i,
    /images attached/i,
    /caption/i,
  ],
  other: [],
};

function scoreByFilename(fileName: string): ClassificationCandidate[] {
  const name = fileName.toLowerCase();
  const out: ClassificationCandidate[] = [];

  if (/denial|coverage denial|declin/i.test(name)) {
    out.push({ classification: 'denial', confidence: 0.72, source: 'filename', reasons: ['Filename indicates denial'] });
  }
  if (/estimate|xactimate|scope|repair estimate/i.test(name)) {
    out.push({ classification: 'estimate', confidence: 0.72, source: 'filename', reasons: ['Filename indicates estimate'] });
  }
  if (/engineer|engineering|forensic/i.test(name)) {
    out.push({ classification: 'engineering_report', confidence: 0.72, source: 'filename', reasons: ['Filename indicates engineering report'] });
  }
  if (/policy|declarations|dec page|endorsement/i.test(name)) {
    out.push({ classification: 'policy', confidence: 0.72, source: 'filename', reasons: ['Filename indicates policy document'] });
  }
  if (/invoice|receipt|paid|purchase|confirmation/i.test(name)) {
    out.push({ classification: 'invoice', confidence: 0.68, source: 'filename', reasons: ['Filename indicates invoice/receipt'] });
  }

  return out;
}

function scoreByRegex(text: string): ClassificationCandidate[] {
  const out: ClassificationCandidate[] = [];

  for (const [classification, patterns] of Object.entries(CLASS_KEYWORDS) as Array<[DocumentClassification, RegExp[]]>) {
    let hits = 0;
    const matched: string[] = [];
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        hits += 1;
        matched.push(pattern.source);
      }
    }
    if (hits > 0) {
      const confidence = Math.min(0.35 + hits * 0.12, 0.9);
      out.push({
        classification,
        confidence,
        source: 'regex',
        reasons: [`Matched ${hits} regex signals`, ...matched.slice(0, 4)],
      });
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

function inferDocumentFamily(classification: DocumentClassification): string {
  if (['denial', 'approval', 'rfi', 'correspondence'].includes(classification)) return 'carrier';
  if (classification === 'engineering_report') return 'expert';
  if (classification === 'estimate') return 'financial_scope';
  if (classification === 'invoice') return 'financial_proof';
  if (classification === 'policy') return 'coverage_contract';
  if (classification === 'photo') return 'evidence';
  return 'other';
}

function mergeCandidates(...groups: ClassificationCandidate[][]): ClassificationCandidate[] {
  const map = new Map<string, ClassificationCandidate>();

  for (const group of groups) {
    for (const candidate of group) {
      const existing = map.get(candidate.classification);
      if (!existing || candidate.confidence > existing.confidence) {
        map.set(candidate.classification, candidate);
      } else {
        existing.reasons.push(...candidate.reasons);
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => b.confidence - a.confidence);
}

export async function runSmartClassification(args: {
  fileName: string;
  text: string;
  aiPrimary: { classification: DocumentClassification; confidence: number; metadata?: any };
  aiVerify?: { classification: DocumentClassification; confidence: number; reasons?: string[] } | null;
}): Promise<SmartClassificationResult> {
  const filenameCandidates = scoreByFilename(args.fileName);
  const regexCandidates = scoreByRegex(args.text.slice(0, 12000));

  const aiPrimaryCandidate: ClassificationCandidate = {
    classification: args.aiPrimary.classification,
    confidence: args.aiPrimary.confidence,
    source: 'ai_primary',
    reasons: [args.aiPrimary.metadata?.summary || 'Primary AI classification'],
  };

  const aiVerifyCandidate: ClassificationCandidate[] = args.aiVerify
    ? [{
        classification: args.aiVerify.classification,
        confidence: args.aiVerify.confidence,
        source: 'ai_verify',
        reasons: args.aiVerify.reasons || ['AI verifier result'],
      }]
    : [];

  const candidates = mergeCandidates(
    filenameCandidates,
    regexCandidates,
    [aiPrimaryCandidate],
    aiVerifyCandidate,
  );

  const primary = candidates[0]?.classification || 'other';
  const confidence = candidates[0]?.confidence || 0.4;

  const second = candidates[1];
  const disagreement =
    second &&
    second.classification !== primary &&
    Math.abs((second.confidence || 0) - confidence) < 0.12;

  const reviewRequired = confidence < 0.72 || Boolean(disagreement);
  const automationSafe = confidence >= 0.82 && !disagreement;
  const isMixedDocument = Boolean(disagreement && regexCandidates.length >= 2);

  return {
    primary,
    confidence,
    candidates: candidates.slice(0, 5),
    method: reviewRequired ? 'multi_signal_with_review' : 'multi_signal_auto',
    document_family: inferDocumentFamily(primary),
    review_required: reviewRequired,
    is_mixed_document: isMixedDocument,
    automation_safe: automationSafe,
    reasoning: {
      ai_primary: aiPrimaryCandidate,
      ai_verify: aiVerifyCandidate[0] || null,
      filename_candidates: filenameCandidates,
      regex_candidates: regexCandidates.slice(0, 5),
      disagreement: Boolean(disagreement),
    },
  };
}
