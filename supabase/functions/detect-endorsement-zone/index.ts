// Detects the printed endorsement box on the back of a check using vision AI
// and returns normalized coordinates the EndorsementAdjuster can consume.
//
// Response shape (all values 0..1 unless noted):
// {
//   detected: boolean,
//   zone: { top, bottom, left, right } | null,   // normalized to full image
//   suggested: { xPct, yPct, scale } | null,     // yPct is relative to the
//                                                //  15%..92% safe-zone band
//   raw?: string                                  // model text (debug)
// }

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SAFE_ZONE_TOP_PCT = 0.15;
const SAFE_ZONE_BOTTOM_PCT = 0.92;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { imageUrl } = await req.json();
    if (!imageUrl || typeof imageUrl !== "string") {
      return json({ error: "imageUrl is required" }, 400);
    }

    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) {
      return json({ error: "AI gateway not configured" }, 500);
    }

    const prompt = `You are looking at the BACK of a paper check. Find the printed ENDORSEMENT BOX — the rectangular area (usually near the top, bordered by printed lines and often labeled "ENDORSE HERE" / "DO NOT WRITE, STAMP OR SIGN BELOW THIS LINE") where the payee is supposed to sign.

Return ONLY JSON with this exact shape:
{
  "detected": true|false,
  "top": number,     // 0..1 top edge of the endorsement box (fraction of image height)
  "bottom": number,  // 0..1 bottom edge
  "left": number,    // 0..1 left edge
  "right": number    // 0..1 right edge
}

If you cannot confidently see the endorsement box, return {"detected": false}. Do not include any prose or code fences.`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 429) return json({ error: "Rate limited, try again shortly." }, 429);
      if (resp.status === 402) return json({ error: "AI credits exhausted." }, 402);
      return json({ error: `AI gateway ${resp.status}: ${text.slice(0, 300)}` }, 502);
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";

    let parsed: any = null;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      const match = String(raw).match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* ignore */ }
      }
    }

    if (!parsed || parsed.detected === false) {
      return json({ detected: false, zone: null, suggested: null, raw });
    }

    const clamp01 = (n: unknown) => {
      const v = typeof n === "number" ? n : Number(n);
      if (!Number.isFinite(v)) return null;
      return Math.min(1, Math.max(0, v));
    };

    const top = clamp01(parsed.top);
    const bottom = clamp01(parsed.bottom);
    const left = clamp01(parsed.left);
    const right = clamp01(parsed.right);

    if (top == null || bottom == null || left == null || right == null || bottom <= top || right <= left) {
      return json({ detected: false, zone: null, suggested: null, raw });
    }

    // Center of the detected box, in FULL-image coordinates
    const xPct = (left + right) / 2;
    const yPctImage = (top + bottom) / 2;

    // Convert to safe-zone-relative Y (the adjuster's coordinate system)
    const zoneHeight = SAFE_ZONE_BOTTOM_PCT - SAFE_ZONE_TOP_PCT;
    let yPct = (yPctImage - SAFE_ZONE_TOP_PCT) / zoneHeight;
    yPct = Math.min(0.95, Math.max(0.05, yPct));

    // Suggest a scale so the endorsement block width roughly matches the
    // detected box width. The adjuster uses ENDORSEMENT_WIDTH_PCT = 0.22 at
    // scale 1, so scale ≈ detectedWidth / 0.22.
    const detectedWidth = right - left;
    let scale = detectedWidth / 0.22;
    scale = Math.min(2.5, Math.max(0.6, scale));

    return json({
      detected: true,
      zone: { top, bottom, left, right },
      suggested: {
        xPct: Math.min(0.95, Math.max(0.05, xPct)),
        yPct,
        scale: Number(scale.toFixed(2)),
      },
    });
  } catch (err) {
    console.error("[detect-endorsement-zone]", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
