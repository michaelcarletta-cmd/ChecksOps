const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { minLng, minLat, maxLng, maxLat, width, height } = body ?? {};

    if (
      typeof minLng !== "number" ||
      typeof minLat !== "number" ||
      typeof maxLng !== "number" ||
      typeof maxLat !== "number"
    ) {
      throw new Error("Invalid bounds");
    }

    const imgW = Math.min(Math.max(Number(width) || 800, 300), 1200);
    const imgH = Math.min(Math.max(Number(height) || 600, 200), 900);

    const bbox = `${minLng},${minLat},${maxLng},${maxLat}`;
    const size = `${imgW},${imgH}`;

    const esriUrl =
      `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export` +
      `?bbox=${encodeURIComponent(bbox)}` +
      `&bboxSR=4326` +
      `&imageSR=4326` +
      `&size=${encodeURIComponent(size)}` +
      `&format=jpg` +
      `&transparent=false` +
      `&f=image`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let res: Response;
    try {
      res = await fetch(esriUrl, {
        method: "GET",
        headers: {
          "User-Agent": "DarwinRoofEditor/1.0",
          "Accept": "image/*",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`Esri fetch failed: ${res.status}`);
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const bytes = new Uint8Array(await res.arrayBuffer());

    if (bytes.length === 0) {
      throw new Error("Esri returned empty image");
    }

    if (bytes.length > 8_000_000) {
      throw new Error(`Image too large: ${bytes.length} bytes`);
    }

    const dataUrl = `data:${contentType};base64,${toBase64(bytes)}`;

    return new Response(
      JSON.stringify({
        success: true,
        data_url: dataUrl,
        source_url: esriUrl,
        byte_length: bytes.length,
        content_type: contentType,
        width: imgW,
        height: imgH,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown aerial image error";

    return new Response(
      JSON.stringify({
        success: false,
        error: message,
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
