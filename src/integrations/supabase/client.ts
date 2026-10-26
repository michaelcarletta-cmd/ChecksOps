// Production path remains the generated Supabase browser client.
// AWS staging (--mode aws, VITE_AUTH_PROVIDER=cognito) swaps in the Cognito + AWS API adapter.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';
import { createAwsStagingClient } from '@/integrations/aws/client';
import { runtimeHostname, shouldUseAwsChecksOpsBackendFor } from "@/lib/backendMode";
import { emitDataChange, withDataChangeSignals } from "@/lib/liveUpdates";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

const AWS_BUILD = import.meta.env.MODE === "aws";
const shouldUseAws = AWS_BUILD || shouldUseAwsChecksOpsBackendFor({
  hostname: runtimeHostname(),
  authProvider: String(import.meta.env.VITE_AUTH_PROVIDER || ""),
});

// The AWS adapter has no realtime channel: successful writes signal "data changed" so open
// screens refresh without a reload (src/lib/liveUpdates.ts, useLiveDataRefresh).
export const supabase = shouldUseAws
  ? (withDataChangeSignals(createAwsStagingClient(), emitDataChange) as unknown as ReturnType<typeof createClient<Database>>)
  : createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        storage: brokeredPreviewStorage(),
        persistSession: true,
        autoRefreshToken: true,
      }
    });
