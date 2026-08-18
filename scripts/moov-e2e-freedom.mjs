import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const session = JSON.parse(readFileSync('/root/.cache/lovable-auth/session.json', 'utf8'));
const accessToken = session.session.access_token;

const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing credentials.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }
});

async function runTest() {
  console.log(`--- Starting Moov E2E Sandbox Test for Freedom Adjustment ---`);
  
  console.log("1. Checking Readiness...");
  const { data: readiness, error: readinessErr } = await supabase.functions.invoke('moov-readiness', {
    body: { tenant_id: TENANT_ID }
  });
  
  if (readinessErr) {
    console.error("Readiness error:", readinessErr);
  } else {
    console.log("Readiness status:", readiness.readiness?.overall);
    readiness.readiness?.checks?.forEach(c => {
      console.log(` - ${c.label}: ${c.state} ${c.detail ? `(${c.detail})` : ''}`);
    });
  }

  console.log("2. Checking Database Record...");
  const { data: account } = await supabase
    .from('payment_provider_accounts')
    .select('*')
    .eq('tenant_id', TENANT_ID)
    .single();
  
  console.log(" - Bank connection status:", account?.bank_connection_status);
  console.log(" - Moov environment:", account?.environment);

  console.log("3. Syncing Wallet...");
  const { data: wallet, error: walletErr } = await supabase.functions.invoke('moov-wallet-sync', {
    body: { tenant_id: TENANT_ID }
  });
  if (walletErr) {
    console.error("Wallet error:", walletErr);
  } else {
    console.log("Wallet sync:", wallet?.success ? "OK" : "Failed", JSON.stringify(wallet?.balance));
  }

  console.log(`--- Test Finished ---`);
}

runTest().catch(console.error);
