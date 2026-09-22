// Production path remains the generated Supabase browser client.
// AWS staging (--mode aws, VITE_AUTH_PROVIDER=cognito) swaps in the Cognito + AWS API adapter.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';
import { isAwsStaging } from '@/lib/awsStaging';
import { createAwsStagingClient } from '@/integrations/aws/client';
import { CHECKSOPS_SPA_RELEASE_PROOF } from '@/lib/spaReleaseProof';

// Keep the inlined proof in the compiled bundle. Artifact validation inspects
// this object, not source string literals such as "cognito" or "/prep".
export { CHECKSOPS_SPA_RELEASE_PROOF };

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function createBrowserSupabase() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      'CHECKSOPS_SPA_AUTH_UNCONFIGURED: blank Supabase URL/key is forbidden. '
      + `proof=${JSON.stringify(CHECKSOPS_SPA_RELEASE_PROOF)}`,
    );
  }
  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: brokeredPreviewStorage(),
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = isAwsStaging()
  ? (createAwsStagingClient() as unknown as ReturnType<typeof createClient<Database>>)
  : createBrowserSupabase();
