import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

Deno.test("increase-health-check returns accounts from sandbox", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/increase-health-check`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const body = await res.json();
  console.log("Response:", JSON.stringify(body, null, 2));

  assertEquals(res.status, 200);
  assertEquals(body.success, true);
  assertEquals(Array.isArray(body.accounts), true);
  console.log(`✅ Increase sandbox connected — ${body.total} accounts found`);
});
