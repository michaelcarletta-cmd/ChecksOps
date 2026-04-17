import { callVision, generate } from "../_shared/ai/generate.ts";
import { MODEL_VISION } from "../_shared/ai/modelRouter.ts";
import { extractPdfNative, isNativeExtractionUsable, base64ToBytes } from "../_shared/pdfNativeExtract.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BASE_PROMPT = `You are a personal property / contents inventory extraction expert for insurance claims. 
You are given a document (PDF or image) that contains a list of personal property items, such as a contents claim list, 
personal property inventory, or carrier's contents settlement sheet.

CRITICAL INSTRUCTIONS:
1. Extract EVERY SINGLE LINE ITEM. Do NOT skip, merge, or combine items. Each numbered row in the document = one JSON object.
2. The document has numbered items (e.g. #1, #2, ... #175). Include the item number in your output as "item_number".
3. Go page by page, top to bottom. Process EVERY page including the last one. Do not stop early.
4. Some pages have inconsistent table formatting (columns may shift, merge, or wrap). Still extract every row.
5. Pay special attention to pages where the table header row changes format — items on those pages are often missed.
6. Pay special attention to page transitions — the last item on a page and first item on the next page are commonly skipped.

For each item, extract as much of the following as possible:

- item_number: The row number from the document (e.g. 1, 2, 3...)
- item_name: The name/description of the item (required)
- room_name: The room it belongs to (if listed), otherwise "Unassigned". Room headers appear as section headings in the document.
- quantity: Number of items (default 1)
- manufacturer: Brand or manufacturer name (if listed)
- model_number: Model number (if listed)
- original_purchase_price: The listed price as a number
- replacement_cost: Same as the price if only one price column exists
- actual_cash_value: ACV (if listed), as a number
- condition_before_loss: Condition (new, good, fair, poor) if listed
- category: One of: Electronics, Furniture, Appliances, Clothing, Kitchenware, Decor, Bedding, Tools, Sports, Toys, Other
- age_years: Age in years if listed
- depreciation_rate: Depreciation rate as a decimal (e.g. 0.10 for 10%) if listed
- notes: Any comments column text about the item

IMPORTANT RULES:
- Extract ALL items, even if there are hundreds
- If the document has columns like "Description", "Qty", "RCV", "ACV", "Age", etc., map them to the fields above
- Convert all monetary values to plain numbers (no $ signs, no commas)
- If a room/location section heading exists, use it for room_name for all items under that heading
- If there is only one price column (e.g. "Price" or "Cost"), put the value in BOTH replacement_cost and original_purchase_price
- Do NOT merge multiple items into one entry
- Include the "Comments" column content in the notes field

Return ONLY a JSON array of objects. No markdown fences, no extra text, no commentary.`;

function parseItemsFromContent(content: string): any[] {
  content = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      if (Array.isArray(items)) return items;
    }
    const items = JSON.parse(content);
    if (Array.isArray(items)) return items;
  } catch {
    const lastBrace = content.lastIndexOf("}");
    const arrayStart = content.indexOf("[");
    if (lastBrace > 0 && arrayStart >= 0) {
      try {
        const repaired = content.substring(arrayStart, lastBrace + 1) + "]";
        const items = JSON.parse(repaired);
        if (Array.isArray(items)) {
          console.log(`Recovered ${items.length} items from truncated response`);
          return items;
        }
      } catch { /* fall through */ }
    }
  }
  return [];
}

async function callAI(contentParts: any[], maxTokens = 65536): Promise<{ error: boolean; content?: string; status?: number; text?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const result = await callVision({
      model: MODEL_VISION,
      messages: [{ role: 'user', content: contentParts }],
      temperature: 0.1,
      maxTokens,
    });

    clearTimeout(timeoutId);
    return { error: false, content: result.text };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.message === "RATE_LIMIT") {
      return { error: true, status: 429, text: "Rate limited" };
    }
    return { error: true, status: 500, text: err.message };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const { fileBase64, mimeType, fileName } = await req.json();

    if (!fileBase64) {
      return new Response(JSON.stringify({ error: 'No file data provided' }), { status: 400, headers: corsHeaders });
    }

    // Build content parts
    const effectiveMime = mimeType || 'application/pdf';

    // ── NATIVE-FIRST EXTRACTION (pdf.js) ─────────────────────────────────────
    // Inventory PDFs from carriers/contractors are typically text-based tables.
    // Try pdf.js first ($0). Vision only kicks in when the PDF is scanned.
    if (effectiveMime === 'application/pdf') {
      try {
        const bytes = base64ToBytes(fileBase64);
        const native = await extractPdfNative(bytes, { fileName: fileName || 'inventory.pdf' });
        if (isNativeExtractionUsable(native)) {
          console.log(`[extract-inventory-pdf] Using native pdf.js (${native.charCount} chars, ${native.pageCount} pages) — skipping AI vision`);
          const textResult = await generate({
            task: "extraction",
            system: BASE_PROMPT,
            user: `Extract every inventory line item from the following text. Preserve item numbers and room headers.\n\nFILENAME: ${fileName || 'inventory.pdf'}\n\n=== INVENTORY TEXT ===\n${native.text.slice(0, 180000)}`,
            searchMode: "off",
          });
          const items = parseItemsFromContent(textResult.text);
          if (items.length > 0) {
            items.sort((a: any, b: any) => (Number(a.item_number) || 999) - (Number(b.item_number) || 999));
            console.log(`[extract-inventory-pdf] Native+text extraction: ${items.length} items, model=${textResult.model}`);
            return new Response(JSON.stringify({ success: true, items, extraction_mode: 'native_pdfjs' }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          console.log('[extract-inventory-pdf] Native text yielded zero items — falling back to vision pipeline');
        } else {
          console.log(`[extract-inventory-pdf] Native extraction insufficient (status=${native.status}, chars=${native.charCount}) — using vision`);
        }
      } catch (nativeErr) {
        console.warn('[extract-inventory-pdf] Native extraction failed, falling back to vision:', nativeErr);
      }
    }

    const imageUrl = `data:${effectiveMime.startsWith('image/') ? effectiveMime : 'application/pdf'};base64,${fileBase64}`;
    const contentParts: any[] = [
      { type: 'text', text: BASE_PROMPT },
      { type: 'image_url', image_url: { url: imageUrl } },
    ];

    console.log(`[extract-inventory-pdf] Processing: ${fileName}, size: ${Math.round(fileBase64.length / 1024)}KB base64, model: ${MODEL_VISION}`);

    // === PASS 1: Initial extraction ===
    const result1 = await callAI(contentParts);
    if (result1.error) {
      console.error('AI API error:', result1.status, result1.text);
      if (result1.status === 429) return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again in a moment.' }), { status: 429, headers: corsHeaders });
      return new Response(JSON.stringify({ error: 'AI analysis failed', details: result1.text }), { status: 500, headers: corsHeaders });
    }

    let items = parseItemsFromContent(result1.content!);
    console.log(`Pass 1: Extracted ${items.length} items`);

    if (items.length === 0) {
      return new Response(JSON.stringify({ error: 'No items could be extracted from this document' }), { status: 500, headers: corsHeaders });
    }

    // === PASS 2: Find missing items by number gaps ===
    const extractedNumbers = new Set(items.map((i: any) => Number(i.item_number)).filter((n: number) => !isNaN(n) && n > 0));
    const maxNumber = Math.max(...extractedNumbers, 0);
    const expectedTotal = maxNumber > items.length ? maxNumber : items.length;
    
    if (extractedNumbers.size > 0 && expectedTotal > 0) {
      const missingNumbers: number[] = [];
      for (let i = 1; i <= expectedTotal; i++) {
        if (!extractedNumbers.has(i)) missingNumbers.push(i);
      }

      if (missingNumbers.length > 0 && missingNumbers.length <= 30) {
        console.log(`Found ${missingNumbers.length} missing item numbers: ${missingNumbers.join(', ')}`);

        const pass2Prompt = `You are looking at the SAME document again. In my first extraction pass, I MISSED the following item numbers: ${missingNumbers.join(', ')}.

Please find ONLY these specific numbered items in the document and extract them. Each item has a row number (like #${missingNumbers[0]}, #${missingNumbers[1] || '...'}, etc.) in the leftmost column or Image column.

For each found item, return the same JSON format:
- item_number, item_name, room_name, quantity, manufacturer, model_number, original_purchase_price, replacement_cost, actual_cash_value, condition_before_loss, category, age_years, depreciation_rate, notes

Return ONLY a JSON array. No markdown, no extra text. If you cannot find an item, still include it with item_name "Unknown Item #[number]" and the room it would be in based on surrounding items.`;

        const pass2Parts: any[] = [
          { type: 'text', text: pass2Prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ];

        const result2 = await callAI(pass2Parts, 16384);
        if (!result2.error) {
          const pass2Items = parseItemsFromContent(result2.content!);
          console.log(`Pass 2: Recovered ${pass2Items.length} additional items`);

          if (pass2Items.length > 0) {
            for (const newItem of pass2Items) {
              const num = Number(newItem.item_number);
              if (!isNaN(num) && !extractedNumbers.has(num)) {
                items.push(newItem);
                extractedNumbers.add(num);
              }
            }
          }
        } else {
          console.log('Pass 2 failed, continuing with pass 1 results:', result2.text);
        }
      }
    }

    // Sort by item_number for consistent ordering
    items.sort((a: any, b: any) => (Number(a.item_number) || 999) - (Number(b.item_number) || 999));

    console.log(`[extract-inventory-pdf] Final total: ${items.length} items extracted`);

    return new Response(JSON.stringify({ success: true, items }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});
