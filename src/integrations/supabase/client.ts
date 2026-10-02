// Production path remains the generated Supabase browser client.
// AWS staging (--mode aws, VITE_AUTH_PROVIDER=cognito) swaps in the Cognito + AWS API adapter.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';
import { createAwsStagingClient } from '@/integrations/aws/client';
import { runtimeHostname, shouldUseAwsChecksOpsBackendFor } from "@/lib/backendMode";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

const AWS_BUILD = import.meta.env.MODE === "aws";
const shouldUseAws = AWS_BUILD || shouldUseAwsChecksOpsBackendFor({
  hostname: runtimeHostname(),
  authProvider: String(import.meta.env.VITE_AUTH_PROVIDER || ""),
});

export const supabase = shouldUseAws
  ? (createAwsStagingClient() as unknown as ReturnType<typeof createClient<Database>>)
  : createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        storage: brokeredPreviewStorage(),
        persistSession: true,
        autoRefreshToken: true,
      }
    });
