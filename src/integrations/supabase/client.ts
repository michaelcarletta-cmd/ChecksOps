// Production path remains the generated Supabase browser client.
// Combined AWS staging (Cognito auth + AWS data) swaps in the adapter.
// Cognito auth + explicit Supabase data keeps Cognito as the only auth
// surface and does not restore or mint a Supabase Auth session.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';
import { isAwsDataPlane, isCognitoAuth } from '@/lib/awsStaging';
import { createAwsStagingClient } from '@/integrations/aws/client';
import {
  composeCognitoAuthWithSupabaseData,
  supabaseDataClientAuthOptions,
} from '@/lib/providers';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function createSupabaseAuthAndDataClient() {
  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: brokeredPreviewStorage(),
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

function createSupabaseDataOnlyClient() {
  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: supabaseDataClientAuthOptions(),
  });
}

function createIntegrationClient() {
  const cognito = isCognitoAuth();
  const awsData = isAwsDataPlane();
  if (cognito && awsData) {
    return createAwsStagingClient() as unknown as ReturnType<typeof createClient<Database>>;
  }
  if (cognito) {
    return composeCognitoAuthWithSupabaseData(
      createAwsStagingClient(),
      createSupabaseDataOnlyClient(),
    ) as unknown as ReturnType<typeof createClient<Database>>;
  }
  return createSupabaseAuthAndDataClient();
}

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createIntegrationClient();
