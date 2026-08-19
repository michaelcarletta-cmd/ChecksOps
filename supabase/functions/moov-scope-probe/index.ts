import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovToken } from "../_shared/moovClient.ts";
import { corsHeaders, json } from "../_shared/moovGuard.ts";

/** TEMPORARY diagnostic: finds which terms-of-service scope the provider accepts. */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const candidates = [
    ["/terms-of-service.write"],
    ["/terms-of-service.read"],
    ["/ping.read"],
  ];
  const results: Record<string, string> = {};
  for (const scope of candidates) {
    try {
      await moovToken(scope);
      results[scope.join(" ")] = "ok";
    } catch (e) {
      results[scope.join(" ")] = (e as Error).message;
    }
  }
  return json({ results });
});
