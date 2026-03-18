const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function latToTileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const minLng = Number(body?.minLng);
    const minLat = Number(body?.minLat);
    const maxLng = Number(body?.maxLng);
    const maxLat = Number(body?.maxLat);

    if (
      !Number.isFinite(minLng) ||
      !Number.isFinite(minLat) ||
      !Number.isFinite(maxLng) ||
      !Number.isFinite(maxLat)
    ) {
      throw new Error("Invalid bounds");
    }

    const zoom = 19;

    const xMin = lonToTileX(minLng, zoom);
    const xMax = lonToTileX(maxLng, zoom);
    const yMin = latToTileY(maxLat, zoom);
    const yMax = latToTileY(minLat, zoom);

    const xs = [];
    for (let x = xMin; x <= xMax; x++) xs.push(x);

    const ys = [];
    for (let y = yMin; y <= yMax; y++) ys.push(y);

    if (xs.length === 0 || ys.length === 0) {
      throw new Error("No tiles computed");
    }

    const tiles: Array<{ x: number; y: number; dataUrl: string }> = [];

    for (const y of ys) {
      for (const x of xs) {
        const url = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
        const res = await fetch(url, {
          headers: { "User-Agent": "DarwinRoofEditor/1.0" },
        });
        if (!res.ok) {
          throw new Error(`Tile fetch failed: ${res.status} for ${x}/${y}`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const base64 = uint8ToBase64(bytes);
        tiles.push({
          x,
          y,
          dataUrl: `data:image/png;base64,${base64}`,
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        zoom,
        xMin,
        xMax,
        yMin,
        yMax,
        tiles,
        tileSize: 256,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : "Unknown function error",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
