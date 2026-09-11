// Production path remains the generated Supabase browser client.
// AWS staging (--mode aws, VITE_AUTH_PROVIDER=cognito) swaps in the Cognito + AWS API adapter.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';
import { isAwsAuth } from '@/lib/awsStaging';
import { createAwsStagingClient } from '@/integrations/aws/client';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = isAwsAuth()
  ? (createAwsStagingClient() as unknown as ReturnType<typeof createClient<Database>>)
  : createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        storage: brokeredPreviewStorage(),
        persistSession: true,
        autoRefreshToken: true,
      }
    });
