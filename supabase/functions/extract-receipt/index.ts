import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const { imageBase64, mimeType, pageImages } = await req.json();

    if (!imageBase64 && (!pageImages || pageImages.length === 0)) {
      return new Response(JSON.stringify({ error: 'No image data provided' }), { status: 400, headers: corsHeaders });
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: 'AI API key not configured' }), { status: 500, headers: corsHeaders });
    }

    const prompt = `You are a receipt data extraction expert for insurance ALE (Additional Living Expense) claims. You are given one or more images. Each image may be a page from a multi-page document, or a standalone receipt photo. The pages together may contain MULTIPLE separate receipts.

YOUR TASK: Identify EVERY individual receipt across ALL provided images and extract these fields from EACH one:

1. **Vendor Name** — the store or business name on the receipt.
2. **Purchase Date** — the transaction date in YYYY-MM-DD format.
3. **Final Charged Total** — the amount the customer actually paid.

RULES FOR FINDING THE TOTAL (STRICT):
- The total MUST appear next to a label like "TOTAL", "TOTAL TENDER", "AMOUNT CHARGED", "BALANCE DUE", "GRAND TOTAL", or "AMOUNT DUE".
- IGNORE subtotals, tax lines, discount lines, savings lines, and individual item prices.
- If a payment tender line exists (e.g. "Visa", "Amex", "MC", "Mastercard", "Debit", "Credit Card"), the amount on that line MUST exactly match the total you extracted. If it does not match, set needs_review to true.
- If more than one possible total exists and it is unclear which is the final charged amount, set needs_review to true and total to null.
    - If the document is rotated or upside down, mentally rotate it upright before reading.

MULTI-RECEIPT RULES:
- Each distinct vendor/transaction is a SEPARATE receipt — extract each one individually.
- If the same receipt spans two pages/images, combine them into ONE entry.
- If a page has a receipt from Walmart and another from Target, those are TWO entries.

CATEGORY SUGGESTION:
For each receipt, suggest one category based on the vendor name and visible items:
- "meals" — grocery stores, restaurants, fast food, convenience stores selling food
- "lodging" — hotels, motels, Airbnb, short-term rentals
- "storage" — storage unit facilities
- "transportation" — gas stations, parking, tolls, rideshare
- "laundry" — laundromats, dry cleaners
- "pet_boarding" — kennels, pet care facilities
- "other" — anything else

Return ONLY this JSON — always an array, even if there is only one receipt:
{
  "receipts": [
    {
      "vendor_name": "Store Name" or null,
      "date": "YYYY-MM-DD" or null,
      "total": 49.99 or null,
      "suggested_category": "meals",
      "needs_review": false
    }
  ]
}

If you cannot confidently determine the total for a receipt, set needs_review to true and total to null. Accuracy over completion.`;

    // Build content parts: text prompt + one or more images
    const contentParts: any[] = [{ type: 'text', text: prompt }];

    if (pageImages && pageImages.length > 0) {
      // Multiple page images from PDF
      for (const img of pageImages) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${img}` },
        });
      }
    } else {
      // Single image
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` },
      });
    }

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: contentParts }],
        temperature: 0.1,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI API error:', errorText);
      return new Response(JSON.stringify({ error: 'AI analysis failed' }), { status: 500, headers: corsHeaders });
    }

    const aiResult = await response.json();
    const content = aiResult.choices?.[0]?.message?.content || '';

    let extracted;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', content);
      return new Response(JSON.stringify({ error: 'Failed to parse receipt data', raw: content }), { status: 500, headers: corsHeaders });
    }

    // Normalize: support both old single-receipt and new multi-receipt format
    let receipts: any[];
    if (Array.isArray(extracted.receipts)) {
      receipts = extracted.receipts;
    } else if (extracted.vendor_name !== undefined || extracted.total !== undefined) {
      // Legacy single-receipt response
      receipts = [extracted];
    } else {
      receipts = [extracted];
    }

    return new Response(JSON.stringify({ success: true, data: { receipts } }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});
