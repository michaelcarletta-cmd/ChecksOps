import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const EXTRACTION_SYSTEM_PROMPT = `You are an estimate extraction engine. Given raw text from an insurance estimate document (Xactimate, Symbility, contractor bid, or similar), extract every line item into a structured JSON array.

For EACH line item, extract:
- description (string): the line item description exactly as written
- quantity (number): the quantity
- unit (string): unit of measure — one of EA, SF, LF, SQ, HR, LS, CY, GAL
- unit_price (number): price per unit
- trade (string): the trade category — one of Roofing, Siding, Gutters, Interior, Drywall, Painting, Flooring, Electrical, Plumbing, HVAC, Windows, Doors, Framing, Insulation, General, Other
- depreciation_pct (number): depreciation percentage if listed, else 0
- code_reference (string|null): any Xactimate code or line code if present
- notes (string|null): any notes or remarks on the line

Also extract these document-level fields:
- document_type (string): "carrier_estimate", "contractor_estimate", "pa_estimate", or "unknown"
- total_rcv (number|null): the document total RCV if found
- total_acv (number|null): the document total ACV if found

CRITICAL RULES:
- Extract ONLY line items that actually appear in the document text
- Do NOT invent, assume, or hallucinate line items that are not explicitly listed
- If the document is a roofing estimate, only extract roofing items
- If you cannot clearly read a line item, skip it rather than guess
- Match descriptions as closely as possible to the original text

Return ONLY valid JSON with this shape:
{
  "document_type": "...",
  "total_rcv": null,
  "total_acv": null,
  "line_items": [...]
}`;

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
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    const { claimId, extractedText, fileName, source, fileId, base64Data, mimeType } = await req.json();
    if (!claimId) throw new Error('claimId required');

    let textForExtraction = '';

    // Priority 1: If fileId provided, try to get already-extracted text from claim_files
    if (fileId) {
      console.log(`Attempting to read extracted text from claim_files for fileId: ${fileId}`);
      const { data: fileRow } = await supabase
        .from('claim_files')
        .select('extracted_text, clean_text, file_name')
        .eq('id', fileId)
        .maybeSingle();

      if (fileRow?.clean_text) {
        textForExtraction = fileRow.clean_text;
        console.log(`Using clean_text from claim_files (${textForExtraction.length} chars)`);
      } else if (fileRow?.extracted_text) {
        textForExtraction = fileRow.extracted_text;
        console.log(`Using extracted_text from claim_files (${textForExtraction.length} chars)`);
      }
    }

    // Priority 2: If base64 PDF data provided, use Gemini vision to extract text
    if (!textForExtraction && base64Data && mimeType) {
      console.log(`Using multimodal vision extraction for ${mimeType} (${base64Data.length} base64 chars)`);

      const visionResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Extract ALL text from this estimate document. Preserve the structure: line item descriptions, quantities, units, unit prices, and totals. Include section headers (like "Roof", "Interior", "Summary"). Output the full text exactly as it appears in the document. Do NOT summarize or skip any line items.',
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64Data}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 16000,
        }),
      });

      if (!visionResp.ok) {
        const errBody = await visionResp.text();
        console.error(`Vision extraction failed (${visionResp.status}):`, errBody);
        throw new Error(`Vision extraction failed: ${visionResp.status}`);
      }

      const visionData = await visionResp.json();
      textForExtraction = visionData.choices?.[0]?.message?.content || '';
      console.log(`Vision extracted ${textForExtraction.length} chars of text`);
    }

    // Priority 3: Use provided extractedText (for CSV, XLSX, plain text)
    if (!textForExtraction && extractedText) {
      // Skip if it's the old broken base64 format
      if (extractedText.startsWith('[BASE64_DOCUMENT:')) {
        console.warn('Received legacy BASE64_DOCUMENT format — cannot extract text from raw base64 string');
        throw new Error('PDF text extraction failed. Please re-upload the file.');
      }
      textForExtraction = extractedText;
    }

    if (!textForExtraction?.trim()) {
      throw new Error('No text could be extracted from this document. Please ensure the file contains readable text.');
    }

    console.log(`Sending ${textForExtraction.length} chars to AI for structured extraction from ${fileName || 'estimate'}`);

    // Use AI to extract structured line items from the clean text
    const aiResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: `Extract estimate line items from this document (${fileName || 'estimate'}):\n\n${textForExtraction.slice(0, 30000)}` },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: { type: 'function', function: { name: 'extract_estimate' } },
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

    const aiData = await aiResp.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error('No structured extraction returned');

    const extracted = JSON.parse(toolCall.function.arguments);
    const lineItems = extracted.line_items || [];

    if (lineItems.length === 0) {
      return new Response(JSON.stringify({ success: true, imported: 0, message: 'No line items detected in document.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Determine if this is a carrier estimate (populate carrier columns) or PA/contractor estimate (populate main columns)
    const isCarrier = extracted.document_type === 'carrier_estimate';
    const importSource = source || (isCarrier ? 'carrier_import' : 'estimate_import');

    // Get current max sort_order
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
      rationale: `Imported from ${fileName || 'estimate document'}`,
      reason_tag: null,
      carrier_quantity: isCarrier ? item.quantity : null,
      carrier_unit_price: isCarrier ? item.unit_price : null,
      sort_order: sortStart + i,
      used_in_rebuttal: false,
    }));

    const { error: insertError } = await supabase.from('darwin_estimate_lines').insert(rows);
    if (insertError) throw insertError;

    console.log(`Successfully imported ${rows.length} line items (${importSource}) for claim ${claimId}`);

    return new Response(JSON.stringify({
      success: true,
      imported: rows.length,
      document_type: extracted.document_type,
      total_rcv: extracted.total_rcv,
      total_acv: extracted.total_acv,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('darwin-estimate-import error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
