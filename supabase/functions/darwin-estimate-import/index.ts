import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { callVision, callWithTools, MODEL_VISION } from "../_shared/ai/generate.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function isLikelyCorruptedStoredText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const wordMatches = trimmed.match(/[a-zA-Z]{2,}/g) || [];
  const suspiciousPdfSignals = countPatternMatches(lower, [
    /\bobj\b/,
    /\bendobj\b/,
    /\bstream\b/,
    /\bendstream\b/,
    /\bxref\b/,
    /type\/?xobject/,
    /subtype\/?image/,
    /filter\/?dctdecode/,
    /bitspercomponent/,
    /colorspace/,
    /width\s*\d{3,}/,
    /height\s*\d{3,}/,
  ]);

  const longTokenMatches = trimmed.match(/[A-Za-z0-9%#@+_\/-]{18,}/g) || [];
  const alphaChars = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const digits = (trimmed.match(/\d/g) || []).length;
  const slashDensity = (trimmed.match(/[\\/]/g) || []).length / Math.max(trimmed.length, 1);
  const denseSingleLineBlob = lines.length <= 3 && trimmed.length > 1000;
  const lowNaturalLanguageDensity = wordMatches.length < Math.max(25, Math.floor(trimmed.length / 120));
  const numericHeavy = digits > alphaChars * 0.9;

  return suspiciousPdfSignals >= 3 ||
    (suspiciousPdfSignals >= 2 && denseSingleLineBlob) ||
    (denseSingleLineBlob && lowNaturalLanguageDensity && longTokenMatches.length >= 8) ||
    (slashDensity > 0.035 && lowNaturalLanguageDensity) ||
    (numericHeavy && lowNaturalLanguageDensity);
}

function getUsableStoredText(text: string | null | undefined, label: 'clean_text' | 'extracted_text'): string | null {
  if (!text || text.trim().length <= 50) return null;

  if (isLikelyCorruptedStoredText(text)) {
    console.log(`${label} appears corrupted or PDF-binary-like, skipping`);
    return null;
  }

  const nonPrintable = text.replace(/[\x20-\x7E\n\r\t]/g, '').length;
  if (nonPrintable / Math.max(text.length, 1) >= 0.15) {
    console.log(`${label} has too many non-printable characters, skipping`);
    return null;
  }

  return text;
}

async function extractTextWithVision(base64Data: string, mimeType: string, _apiKey?: string): Promise<string> {
  console.log(`Using multimodal vision for ${mimeType} (${Math.round(base64Data.length / 1024)}KB base64)`);

  const visionResult = await callVision({
    model: MODEL_VISION,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Extract ALL text from this estimate document verbatim. Preserve structure: section headers, line item descriptions, quantities, units, unit prices, totals, depreciation. Output the complete text exactly as it appears. Do NOT summarize, skip, or invent any content.',
        },
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64Data}` },
        },
      ],
    }],
  });

  const visionText = visionResult.text;
  console.log(`Vision extracted ${visionText.length} chars`);
  return visionText;
}

// --- Pre-extraction validation ---
function validateEstimateText(text: string): { valid: boolean; confidence: number; warnings: string[] } {
  const warnings: string[] = [];
  const lower = text.toLowerCase();
  const lines = text.split('\n').filter(l => l.trim().length > 0);

  // Check for estimate keywords
  const estimateKeywords = ['qty', 'unit', 'replace', 'remove', 'shingle', 'flashing', 'drywall', 'paint',
    'total', 'depreciation', 'rcv', 'acv', 'roof', 'siding', 'gutter', 'interior', 'price',
    'cost', 'amount', 'square', 'linear', 'each', 'labor', 'material', 'subtotal', 'overhead', 'profit'];
  const keywordHits = estimateKeywords.filter(kw => lower.includes(kw)).length;

  // Check for numeric/currency patterns
  const numberPattern = /\d+[\.,]?\d*/g;
  const currencyPattern = /\$[\d,]+\.?\d*/g;
  const numberMatches = (text.match(numberPattern) || []).length;
  const currencyMatches = (text.match(currencyPattern) || []).length;

  // Check for line-item-like structures (description + number on same line)
  const lineItemPattern = /[a-zA-Z].{5,}\s+\d/;
  const lineItemMatches = lines.filter(l => lineItemPattern.test(l)).length;

  // Check for garbage/binary text
  const nonPrintable = text.replace(/[\x20-\x7E\n\r\t]/g, '').length;
  const garbageRatio = nonPrintable / Math.max(text.length, 1);
  if (garbageRatio > 0.15) {
    warnings.push('High non-printable character ratio — text may be corrupted');
  }

  // Compute confidence
  let confidence = 0;
  confidence += Math.min(keywordHits * 5, 30); // max 30 from keywords
  confidence += Math.min(currencyMatches * 3, 20); // max 20 from currency
  confidence += Math.min(lineItemMatches * 2, 25); // max 25 from line structures
  confidence += Math.min(numberMatches, 25); // max 25 from numbers
  confidence = Math.max(0, confidence - (garbageRatio > 0.15 ? 30 : 0));
  confidence = Math.min(confidence, 100);

  if (keywordHits < 2) warnings.push('Few estimate-related keywords detected');
  if (lineItemMatches < 3) warnings.push('Few line-item structures detected');
  if (lines.length < 5) warnings.push('Very short document');

  const valid = confidence >= 20 && keywordHits >= 1 && lineItemMatches >= 1;
  return { valid, confidence, warnings };
}

function normalizeForSourceMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSignificantTokens(value: string): string[] {
  const stopWords = new Set([
    'and', 'the', 'with', 'without', 'for', 'per', 'std', 'type', 'item', 'reset', 'remove',
    'replace', 'repair', 'install', 'detach', 'high', 'grade', 'small', 'large', 'approx',
  ]);

  return Array.from(new Set(
    normalizeForSourceMatch(value)
      .split(' ')
      .filter(token => token.length >= 4 && !stopWords.has(token))
  ));
}

function isDescriptionGroundedInSource(description: string, normalizedSourceText: string): boolean {
  const normalizedDescription = normalizeForSourceMatch(description);
  if (!normalizedDescription) return false;
  if (normalizedSourceText.includes(normalizedDescription)) return true;

  const significantTokens = getSignificantTokens(description);
  if (significantTokens.length === 0) return false;

  const leadingPhrase = significantTokens.slice(0, Math.min(3, significantTokens.length)).join(' ');
  if (leadingPhrase.length >= 8 && normalizedSourceText.includes(leadingPhrase)) return true;

  const tokenMatches = significantTokens.filter(token => normalizedSourceText.includes(token)).length;
  if (significantTokens.length <= 2) return tokenMatches === significantTokens.length;

  return tokenMatches >= Math.max(2, Math.ceil(significantTokens.length * 0.6));
}

function buildLineItemKey(item: any): string {
  return [
    normalizeForSourceMatch(item.description || ''),
    normalizeForSourceMatch(item.trade || ''),
    String(Number(item.quantity || 0).toFixed(3)),
    String((item.unit || 'EA').toUpperCase()),
    String(Number(item.unit_price || 0).toFixed(2)),
    String(Number(item.depreciation_pct || 0).toFixed(2)),
    normalizeForSourceMatch(item.code_reference || ''),
  ].join('|');
}

function dedupeLineItems(lineItems: any[]): { items: any[]; removedCount: number } {
  const seen = new Set<string>();
  const items: any[] = [];

  for (const item of lineItems) {
    const key = buildLineItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  return { items, removedCount: Math.max(0, lineItems.length - items.length) };
}

// --- Post-extraction sanity checks ---
function postExtractionSanityCheck(lineItems: any[], textForExtraction: string): { items: any[]; warnings: string[] } {
  const warnings: string[] = [];
  const lower = textForExtraction.toLowerCase();
  const normalizedSourceText = normalizeForSourceMatch(textForExtraction);

  // Detect primary document scope
  const roofingKeywords = ['roof', 'shingle', 'ridge', 'flashing', 'drip edge', 'underlayment', 'vent', 'hip', 'valley', 'eave', 'starter'];
  const interiorKeywords = ['cabinet', 'sink', 'faucet', 'dishwasher', 'toilet', 'vanity', 'countertop', 'appliance', 'kitchen', 'range hood', 'refrigerator', 'oven', 'microwave', 'water heater'];
  const roofingHits = roofingKeywords.filter(k => lower.includes(k)).length;
  const interiorHitsInDoc = interiorKeywords.filter(k => lower.includes(k)).length;

  const isRoofingDoc = roofingHits >= 3 && roofingHits >= Math.max(3, interiorHitsInDoc * 2 + 1);

  const ungroundedItems = lineItems.filter(item => !isDescriptionGroundedInSource(item.description || '', normalizedSourceText));
  if (ungroundedItems.length > 0) {
    warnings.push(`${ungroundedItems.length} items were removed because their descriptions were not grounded in the source text`);
    lineItems = lineItems.filter(item => isDescriptionGroundedInSource(item.description || '', normalizedSourceText));
  }

  // Check extracted items for trades inconsistent with source
  const trades = new Set(lineItems.map(i => (i.trade || '').toLowerCase()));
  const suspiciousTrades = ['Plumbing', 'HVAC', 'Electrical', 'Flooring', 'Interior'];

  if (isRoofingDoc) {
    const suspiciousItems = lineItems.filter(item => {
      const desc = (item.description || '').toLowerCase();
      const trade = (item.trade || '').toLowerCase();
      const hasRoofingKeyword = roofingKeywords.some(k => desc.includes(k));
      const hasInteriorKeyword = interiorKeywords.some(k => desc.includes(k));
      const tradeIsSuspicious = suspiciousTrades.some(t => trade === t.toLowerCase());
      const genericInteriorPattern = desc.includes('clean - kitchen') || desc.includes('clean kitchen');

      return (hasInteriorKeyword || tradeIsSuspicious || genericInteriorPattern) && !hasRoofingKeyword;
    });

    if (suspiciousItems.length > 0) {
      warnings.push('Output contains mixed trades inconsistent with source');
      warnings.push(`${suspiciousItems.length} items appear inconsistent with roofing document scope`);
      warnings.push('Manual review recommended');
      // Remove suspicious items
      const cleanItems = lineItems.filter(item => {
        const desc = (item.description || '').toLowerCase();
        const trade = (item.trade || '').toLowerCase();
        const isSuspicious = interiorKeywords.some(k => desc.includes(k)) || desc.includes('clean - kitchen') || desc.includes('clean kitchen') ||
          (suspiciousTrades.some(t => trade === t.toLowerCase()) && !roofingKeywords.some(k => desc.includes(k)));
        return !isSuspicious;
      });
      return { items: cleanItems, warnings };
    }
  }

  // Check for too many unrelated trades
  if (trades.size > 8) {
    warnings.push('Unusually high number of different trades detected — verify document scope');
  }

  return { items: lineItems, warnings };
}

const EXTRACTION_SYSTEM_PROMPT = `You are a STRICT estimate extraction engine for insurance claim documents (Xactimate, Symbility, contractor bids).

CRITICAL ANTI-HALLUCINATION RULES:
1. Extract ONLY line items that are EXPLICITLY written in the provided text
2. Do NOT infer, invent, assume, or fabricate any line items
3. Do NOT add plumbing, cabinets, appliances, or interior items unless they explicitly appear in the text
4. If a line is unreadable or ambiguous, SKIP it entirely — do NOT guess
5. Use the document's own wording for descriptions — do not rephrase or generalize
6. If the document is clearly a roofing estimate, extract ONLY roofing items
7. Preserve the exact scope shown — do not expand or add related items
8. Every extracted item MUST have a clear source line in the original text

For EACH line item found, extract:
- description (string): exact text from document
- quantity (number): as listed
- unit (string): EA, SF, LF, SQ, HR, LS, CY, GAL
- unit_price (number): per-unit price
- trade (string): Roofing, Siding, Gutters, Interior, Drywall, Painting, Flooring, Electrical, Plumbing, HVAC, Windows, Doors, Framing, Insulation, General, Other
- depreciation_pct (number): if listed, else 0
- code_reference (string|null): Xactimate/line code if present
- notes (string|null): any remarks

Also extract:
- document_type: "carrier_estimate", "contractor_estimate", "pa_estimate", or "unknown"
- total_rcv (number|null)
- total_acv (number|null)

If you cannot find ANY valid line items, return an empty line_items array.`;

const TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'extract_estimate',
    description: 'Return structured estimate data extracted from the document.',
    parameters: {
      type: 'object',
      properties: {
        document_type: { type: 'string', enum: ['carrier_estimate', 'contractor_estimate', 'pa_estimate', 'unknown'] },
        total_rcv: { type: 'number', nullable: true },
        total_acv: { type: 'number', nullable: true },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string', enum: ['EA', 'SF', 'LF', 'SQ', 'HR', 'LS', 'CY', 'GAL'] },
              unit_price: { type: 'number' },
              trade: { type: 'string' },
              depreciation_pct: { type: 'number' },
              code_reference: { type: 'string', nullable: true },
              notes: { type: 'string', nullable: true },
            },
            required: ['description', 'quantity', 'unit', 'unit_price', 'trade'],
            additionalProperties: false,
          },
        },
      },
      required: ['document_type', 'line_items'],
      additionalProperties: false,
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    // AI routing handled by shared layer

    const body = await req.json();
    const {
      claimId,
      extractedText,
      fileName,
      source,
      fileId,
      base64Data,
      mimeType,
      previewOnly,
      lineItemsOverride,
      documentTypeOverride,
      totalRcvOverride,
      totalAcvOverride,
    } = body;
    if (!claimId) throw new Error('claimId required');

    let textForExtraction = '';
    let extractedTextSource = 'none';
    let resolvedFileName = fileName || '';

    // Priority 1: If fileId provided, get stored text from claim_files
    if (fileId) {
      console.log(`Looking up claim_files for fileId: ${fileId}`);
      const { data: fileRow } = await supabase
        .from('claim_files')
        .select('extracted_text, clean_text, file_name')
        .eq('id', fileId)
        .maybeSingle();

      if (fileRow?.file_name && !resolvedFileName) {
        resolvedFileName = fileRow.file_name;
      }

      const cleanText = getUsableStoredText(fileRow?.clean_text, 'clean_text');
      const extractedStoredText = getUsableStoredText(fileRow?.extracted_text, 'extracted_text');

      if (cleanText) {
        textForExtraction = cleanText;
        extractedTextSource = 'clean_text';
        console.log(`Using clean_text (${textForExtraction.length} chars)`);
      } else if (extractedStoredText) {
        textForExtraction = extractedStoredText;
        extractedTextSource = 'extracted_text';
        console.log(`Using extracted_text (${textForExtraction.length} chars)`);
      }
    }

    // Priority 2: Multimodal vision for PDFs/images with base64
    if (!textForExtraction && base64Data && mimeType) {
      extractedTextSource = 'multimodal_vision';
      textForExtraction = await extractTextWithVision(base64Data, mimeType);
    }

    // Priority 3: Plain text for CSV/XLSX/TXT
    if (!textForExtraction && extractedText) {
      if (extractedText.startsWith('[BASE64_DOCUMENT:')) {
        console.warn('Rejected legacy BASE64_DOCUMENT format');
        return new Response(JSON.stringify({
          ok: false,
          error: 'Document could not be read. Please re-upload the file.',
          extraction_confidence: 0,
          extracted_text_source: 'none',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      textForExtraction = extractedText;
      extractedTextSource = 'plain_text';
    }

    if (!textForExtraction?.trim()) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'No text could be extracted from this document.',
        extraction_confidence: 0,
        extracted_text_source: extractedTextSource,
        warning_flags: ['No readable text found'],
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Pre-extraction validation ---
    let validation = validateEstimateText(textForExtraction);
    console.log(`Pre-validation: confidence=${validation.confidence}, valid=${validation.valid}, warnings=${validation.warnings.join('; ')}`);

    if (!validation.valid && base64Data && mimeType && extractedTextSource !== 'multimodal_vision') {
      console.log(`Stored text failed validation from ${extractedTextSource}; retrying with multimodal fallback`);
      textForExtraction = await extractTextWithVision(base64Data, mimeType);
      extractedTextSource = 'multimodal_vision';
      validation = validateEstimateText(textForExtraction);
      console.log(`Fallback validation: confidence=${validation.confidence}, valid=${validation.valid}, warnings=${validation.warnings.join('; ')}`);
    }

    if (!validation.valid) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Document text could not be reliably parsed into estimate line items.',
        extraction_confidence: validation.confidence / 100,
        extracted_text_source: extractedTextSource,
        warning_flags: validation.warnings,
        extracted_text_preview: textForExtraction.slice(0, 2000),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- AI extraction ---
    console.log(`Sending ${textForExtraction.length} chars for extraction (source: ${extractedTextSource})`);

    let extracted: any = {
      document_type: documentTypeOverride || 'unknown',
      total_rcv: totalRcvOverride ?? null,
      total_acv: totalAcvOverride ?? null,
      line_items: Array.isArray(lineItemsOverride) ? lineItemsOverride : [],
    };
    let lineItems = extracted.line_items || [];

    if (Array.isArray(lineItemsOverride)) {
      console.log(`Using ${lineItemsOverride.length} reviewed preview items for import`);
    } else {
      const aiResult = await callWithTools({
        model: MODEL_VISION,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: `Extract estimate line items from this document (${fileName || 'estimate'}):\n\n${textForExtraction.slice(0, 30000)}` },
        ],
        tools: [TOOL_SCHEMA],
        toolChoice: { type: 'function', function: { name: 'extract_estimate' } },
      });

      console.log(`[darwin-estimate-import] model=${aiResult.model}`);

      const toolCall = aiResult.toolCalls?.[0];
      if (!toolCall) throw new Error('No structured extraction returned');

      extracted = JSON.parse(toolCall.function.arguments);
      lineItems = extracted.line_items || [];
    }

    // --- Post-extraction sanity checks ---
    const sanity = postExtractionSanityCheck(lineItems, textForExtraction);
    lineItems = sanity.items;
    const deduped = dedupeLineItems(lineItems);
    lineItems = deduped.items;

    const allWarnings = [...validation.warnings, ...sanity.warnings];
    if (deduped.removedCount > 0) {
      allWarnings.push(`${deduped.removedCount} duplicate line items were removed`);
    }

    const extractionConfidence = Math.min(validation.confidence / 100, 1);

    if (lineItems.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        imported: 0,
        message: 'No valid line items detected in document.',
        extraction_confidence: extractionConfidence,
        extracted_text_source: extractedTextSource,
        warning_flags: allWarnings,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Preview mode: return items without saving ---
    if (previewOnly) {
      return new Response(JSON.stringify({
        success: true,
        preview: true,
        line_items: lineItems,
        document_type: extracted.document_type,
        total_rcv: extracted.total_rcv,
        total_acv: extracted.total_acv,
        extraction_confidence: extractionConfidence,
        extracted_text_source: extractedTextSource,
        extracted_text_preview: textForExtraction.slice(0, 3000),
        warning_flags: allWarnings,
        imported: lineItems.length,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Insert into DB ---
    const isCarrier = extracted.document_type === 'carrier_estimate';
    const importSource = source || (isCarrier ? 'carrier_import' : 'estimate_import');
    const importRationale = `Imported from ${resolvedFileName || 'estimate document'}`;

    const { data: removedExistingRows, error: removeExistingError } = await supabase
      .from('darwin_estimate_lines')
      .delete()
      .eq('claim_id', claimId)
      .eq('rationale', importRationale)
      .in('source', ['carrier_import', 'estimate_import'])
      .select('id');

    if (removeExistingError) throw removeExistingError;
    if ((removedExistingRows || []).length > 0) {
      console.log(`Removed ${(removedExistingRows || []).length} previously imported rows for ${importRationale}`);
    }

    const { data: existingLines } = await supabase
      .from('darwin_estimate_lines')
      .select('sort_order')
      .eq('claim_id', claimId)
      .order('sort_order', { ascending: false })
      .limit(1);

    let sortStart = (existingLines?.[0]?.sort_order ?? -1) + 1;

    const rows = lineItems.map((item: any, i: number) => ({
      claim_id: claimId,
      category: item.trade || 'General',
      trade: item.trade || 'General',
      description: item.description,
      quantity: isCarrier ? 0 : item.quantity,
      unit: item.unit || 'EA',
      unit_price: isCarrier ? 0 : item.unit_price,
      depreciation_pct: item.depreciation_pct || 0,
      include_overhead: false,
      include_profit: false,
      overhead_pct: 10,
      profit_pct: 10,
      source: importSource,
      is_suggested: false,
      is_accepted: true,
      code_reference: item.code_reference || null,
      notes: item.notes || null,
      rationale: importRationale,
      reason_tag: null,
      carrier_quantity: isCarrier ? item.quantity : null,
      carrier_unit_price: isCarrier ? item.unit_price : null,
      sort_order: sortStart + i,
      used_in_rebuttal: false,
    }));

    const { error: insertError } = await supabase.from('darwin_estimate_lines').insert(rows);
    if (insertError) throw insertError;

    console.log(`Imported ${rows.length} items (${importSource}) for claim ${claimId}`);

    return new Response(JSON.stringify({
      ok: true,
      success: true,
      imported: rows.length,
      document_type: extracted.document_type,
      total_rcv: extracted.total_rcv,
      total_acv: extracted.total_acv,
      extraction_confidence: extractionConfidence,
      extracted_text_source: extractedTextSource,
      warning_flags: allWarnings,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('darwin-estimate-import error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
