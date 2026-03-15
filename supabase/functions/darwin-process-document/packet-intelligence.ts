import type { DocumentClassification } from './classification-v2.ts';

export interface PacketPageResult {
  page_number: number;
  classification: DocumentClassification;
  confidence: number;
  reasons: string[];
  excerpt: string;
}

export interface PacketAnalysisResult {
  page_count: number;
  dominant_classification: DocumentClassification;
  dominant_confidence: number;
  mixed_document: boolean;
  mixed_confidence: number;
  review_required: boolean;
  pages: PacketPageResult[];
  page_class_counts: Record<string, number>;
  reasoning: Record<string, unknown>;
}

const PAGE_PATTERNS: Record<DocumentClassification, RegExp[]> = {
  denial: [
    /deny|denied|denial/i,
    /unable to extend coverage/i,
    /not covered/i,
    /reservation of rights/i,
  ],
  estimate: [
    /estimate/i,
    /xactimate/i,
    /replacement cost value/i,
    /\bRCV\b/i,
    /\bACV\b/i,
    /scope of repairs/i,
  ],
  approval: [
    /coverage has been afforded/i,
    /we are issuing payment/i,
    /payment enclosed/i,
    /approved/i,
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
    /forensic/i,
  ],
  policy: [
    /policy number/i,
    /policy period/i,
    /declarations/i,
    /named insured/i,
    /endorsement/i,
  ],
  correspondence: [
    /dear /i,
    /regards/i,
    /sincerely/i,
    /re:/i,
  ],
  invoice: [
    /invoice/i,
    /amount due/i,
    /balance due/i,
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

function classifyPage(text: string): Omit<PacketPageResult, 'page_number' | 'excerpt'> {
  const scores: Array<{ classification: DocumentClassification; score: number; reasons: string[] }> = [];

  for (const [classification, patterns] of Object.entries(PAGE_PATTERNS) as Array<[DocumentClassification, RegExp[]]>) {
    let hits = 0;
    const reasons: string[] = [];

    for (const pattern of patterns) {
      if (pattern.test(text)) {
        hits += 1;
        reasons.push(pattern.source);
      }
    }

    if (hits > 0) {
      scores.push({
        classification,
        score: Math.min(0.35 + hits * 0.15, 0.92),
        reasons: [`Matched ${hits} page-level signals`, ...reasons.slice(0, 4)],
      });
    }
  }

  scores.sort((a, b) => b.score - a.score);

  if (scores.length === 0) {
    return {
      classification: 'other',
      confidence: 0.35,
      reasons: ['No page-level pattern match'],
    };
  }

  return {
    classification: scores[0].classification,
    confidence: scores[0].score,
    reasons: scores[0].reasons,
  };
}

function splitIntoPseudoPages(text: string): string[] {
  const normalized = text.replace(/\r/g, '\n');

  const explicitPageBreaks = normalized
    .split(/\n\s*(?:page\s+\d+\s*(?:of\s+\d+)?|---+\s*page break\s*---+)\s*\n/i)
    .map(s => s.trim())
    .filter(Boolean);

  if (explicitPageBreaks.length >= 2) {
    return explicitPageBreaks;
  }

  const chunkSize = 3500;
  const chunks: string[] = [];
  for (let i = 0; i < normalized.length; i += chunkSize) {
    const chunk = normalized.slice(i, i + chunkSize).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

export function analyzePacketText(text: string): PacketAnalysisResult {
  const pages = splitIntoPseudoPages(text).slice(0, 20);

  const pageResults: PacketPageResult[] = pages.map((pageText, index) => {
    const result = classifyPage(pageText);
    return {
      page_number: index + 1,
      classification: result.classification,
      confidence: result.confidence,
      reasons: result.reasons,
      excerpt: pageText.slice(0, 240),
    };
  });

  const counts: Record<string, number> = {};
  for (const page of pageResults) {
    counts[page.classification] = (counts[page.classification] || 0) + 1;
  }

  const sortedCounts = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominantClassification = (sortedCounts[0]?.[0] || 'other') as DocumentClassification;
  const dominantCount = sortedCounts[0]?.[1] || 0;
  const secondCount = sortedCounts[1]?.[1] || 0;
  const totalPages = pageResults.length || 1;

  const dominantConfidence = Number((dominantCount / totalPages).toFixed(3));
  const mixedConfidence = Number((secondCount / totalPages).toFixed(3));
  const mixedDocument =
    sortedCounts.length >= 2 &&
    dominantClassification !== (sortedCounts[1]?.[0] || 'other') &&
    secondCount >= 1 &&
    dominantCount / totalPages < 0.8;

  const reviewRequired =
    mixedDocument ||
    dominantConfidence < 0.6 ||
    pageResults.some(p => p.confidence < 0.45);

  return {
    page_count: totalPages,
    dominant_classification: dominantClassification,
    dominant_confidence: dominantConfidence,
    mixed_document: mixedDocument,
    mixed_confidence: mixedConfidence,
    review_required: reviewRequired,
    pages: pageResults,
    page_class_counts: counts,
    reasoning: {
      dominant_count: dominantCount,
      second_count: secondCount,
      total_pages: totalPages,
      sorted_counts: sortedCounts,
    },
  };
}
