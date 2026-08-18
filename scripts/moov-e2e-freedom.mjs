import { createClient } from '@supabase/supabase-js';

const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing credentials.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function runTest() {
  console.log(`--- Starting Moov E2E Sandbox Test for Freedom ---`);
  
  const { data: readiness, error: readinessErr } = await supabase.functions.invoke('moov-readiness', {
    body: { tenant_id: TENANT_ID }
  });
  
  if (readinessErr) {
    console.error("Readiness error:", readinessErr);
  } else {
    console.log("Readiness status:", readiness.readiness?.overall);
    console.log("Checks:", readiness.readiness?.checks.map(c => `${c.id}: ${c.state}`));
  }

  const { data: wallet, error: walletErr } = await supabase.functions.invoke('moov-wallet-sync', {
    body: { tenant_id: TENANT_ID }
  });
  console.log("Wallet sync:", wallet?.success ? "OK" : "Failed", wallet?.balance ?? walletErr);

  console.log(`--- Test Finished ---`);
}

runTest().catch(console.error);
