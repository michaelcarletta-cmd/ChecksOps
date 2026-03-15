import type { DocumentClassification, ClassificationCandidate, SmartClassificationResult } from './classification-v2.ts';
import { analyzePacketText } from './packet-intelligence.ts';

export interface VirtualSegment {
  segment_index: number;
  segment_label: string;
  start_page: number;
  end_page: number;
  text_excerpt: string;
  extracted_text: string;
  clean_text: string;
}

export interface SegmentClassificationResult {
  segment_index: number;
  segment_label: string;
  start_page: number;
  end_page: number;
  text_excerpt: string;
  extracted_text: string;
  clean_text: string;
  segment_classification: DocumentClassification;
  classification_confidence: number;
  classification_candidates: ClassificationCandidate[];
  classification_reasoning: Record<string, unknown>;
  review_required: boolean;
  automation_safe: boolean;
  document_family: string;
}

export interface SegmentationResult {
  has_segments: boolean;
  segment_count: number;
  summary: Record<string, unknown>;
  segments: SegmentClassificationResult[];
}

function splitPseudoPages(text: string): string[] {
  const normalized = text.replace(/\r/g, '\n');

  const explicit = normalized
    .split(/\n\s*(?:page\s+\d+\s*(?:of\s+\d+)?|---+\s*page break\s*---+)\s*\n/i)
    .map(s => s.trim())
    .filter(Boolean);

  if (explicit.length >= 2) {
    return explicit;
  }

  const chunkSize = 3500;
  const chunks: string[] = [];
  for (let i = 0; i < normalized.length; i += chunkSize) {
    const chunk = normalized.slice(i, i + chunkSize).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function buildVirtualSegments(text: string): VirtualSegment[] {
  const pages = splitPseudoPages(text).slice(0, 25);
  if (pages.length < 2) return [];

  const pageSignals = pages.map((pageText, index) => {
    const analysis = analyzePacketText(pageText);
    return {
      page_number: index + 1,
      classification: analysis.dominant_classification,
      confidence: analysis.dominant_confidence,
      text: pageText,
    };
  });

  const segments: VirtualSegment[] = [];
  let currentStart = 1;
  let currentTexts: string[] = [pageSignals[0].text];
  let currentClass = pageSignals[0].classification;

  for (let i = 1; i < pageSignals.length; i++) {
    const page = pageSignals[i];
    const shouldSplit =
      page.classification !== currentClass &&
      page.confidence >= 0.55;

    if (shouldSplit) {
      const segmentText = currentTexts.join('\n\n');
      segments.push({
        segment_index: segments.length,
        segment_label: `Segment ${segments.length + 1} - ${currentClass}`,
        start_page: currentStart,
        end_page: currentStart + currentTexts.length - 1,
        text_excerpt: segmentText.slice(0, 240),
        extracted_text: segmentText,
        clean_text: segmentText,
      });

      currentStart = page.page_number;
      currentTexts = [page.text];
      currentClass = page.classification;
    } else {
      currentTexts.push(page.text);
    }
  }

  const lastText = currentTexts.join('\n\n');
  segments.push({
    segment_index: segments.length,
    segment_label: `Segment ${segments.length + 1} - ${currentClass}`,
    start_page: currentStart,
    end_page: currentStart + currentTexts.length - 1,
    text_excerpt: lastText.slice(0, 240),
    extracted_text: lastText,
    clean_text: lastText,
  });

  return segments.filter(segment => segment.clean_text.length >= 200);
}

export function classifyVirtualSegments(args: {
  cleanText: string;
  smartClassification: SmartClassificationResult;
}): SegmentationResult {
  const virtualSegments = buildVirtualSegments(args.cleanText);

  if (virtualSegments.length < 2) {
    return {
      has_segments: false,
      segment_count: 0,
      summary: {
        reason: 'No meaningful multi-segment packet detected',
      },
      segments: [],
    };
  }

  const classifiedSegments: SegmentClassificationResult[] = virtualSegments.map(segment => {
    const packet = analyzePacketText(segment.clean_text);

    const classificationCandidates: ClassificationCandidate[] = [
      {
        classification: packet.dominant_classification,
        confidence: packet.dominant_confidence,
        source: 'page_signal',
        reasons: [`Dominant over pages ${segment.start_page}-${segment.end_page}`],
      },
      ...args.smartClassification.candidates.slice(0, 2),
    ];

    const top = classificationCandidates.sort((a, b) => b.confidence - a.confidence)[0];

    const documentFamily =
      top.classification === 'engineering_report' ? 'expert' :
      top.classification === 'estimate' ? 'financial_scope' :
      top.classification === 'invoice' ? 'financial_proof' :
      top.classification === 'policy' ? 'coverage_contract' :
      ['denial', 'approval', 'rfi', 'correspondence'].includes(top.classification) ? 'carrier' :
      top.classification === 'photo' ? 'evidence' :
      'other';

    const reviewRequired =
      packet.review_required ||
      top.confidence < 0.72;

    const automationSafe =
      !reviewRequired &&
      top.confidence >= 0.82 &&
      !packet.mixed_document;

    return {
      segment_index: segment.segment_index,
      segment_label: segment.segment_label,
      start_page: segment.start_page,
      end_page: segment.end_page,
      text_excerpt: segment.text_excerpt,
      extracted_text: segment.extracted_text,
      clean_text: segment.clean_text,
      segment_classification: top.classification,
      classification_confidence: top.confidence,
      classification_candidates: classificationCandidates.slice(0, 4),
      classification_reasoning: {
        packet_analysis: packet,
        inherited_parent_candidates: args.smartClassification.candidates.slice(0, 2),
      },
      review_required: reviewRequired,
      automation_safe: automationSafe,
      document_family: documentFamily,
    };
  });

  return {
    has_segments: true,
    segment_count: classifiedSegments.length,
    summary: {
      method: 'virtual_segmentation_v1',
      segments_detected: classifiedSegments.length,
      parent_primary_classification: args.smartClassification.primary,
    },
    segments: classifiedSegments,
  };
}
