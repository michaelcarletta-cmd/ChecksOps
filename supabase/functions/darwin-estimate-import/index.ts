import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
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

    const { claimId, extractedText, fileName, source } = await req.json();
    if (!claimId || !extractedText) throw new Error('claimId and extractedText required');

    // Use AI to extract structured estimate line items from raw text
    const systemPrompt = `You are an estimate extraction engine. Given raw text from an insurance estimate document (Xactimate, Symbility, contractor bid, or similar), extract every line item into a structured JSON array.

For EACH line item, extract:
- description (string): the line item description
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

Return ONLY valid JSON with this shape:
{
  "document_type": "...",
  "total_rcv": null,
  "total_acv": null,
  "line_items": [...]
}`;

    const aiResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Extract estimate line items from this document (${fileName || 'estimate'}):\n\n${extractedText.slice(0, 30000)}` },
        ],
        tools: [{
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
        }],
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
