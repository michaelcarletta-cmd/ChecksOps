// Separate client for the Mortgage Ops portal.
// Uses a distinct localStorage key so that signing in/out of the Mortgage Desk
// is fully independent from the ChecksOps session (and vice versa).
// A super admin can be signed into both portals simultaneously without either
// affecting the other.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import {
  AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY,
  isAwsDataPlane,
  isCognitoAuth,
} from "@/lib/awsStaging";
import { createAwsStagingClient } from "@/integrations/aws/client";
import {
  composeCognitoAuthWithSupabaseData,
  supabaseDataClientAuthOptions,
} from "@/lib/providers";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const mortgageSupabase = (() => {
  const cognito = isCognitoAuth();
  const awsData = isAwsDataPlane();
  if (cognito && awsData) {
    return createAwsStagingClient({
      sessionKey: AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY,
    }) as unknown as ReturnType<typeof createClient<Database>>;
  }
  if (cognito) {
    return composeCognitoAuthWithSupabaseData(
      createAwsStagingClient({
        sessionKey: AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY,
      }),
      createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: supabaseDataClientAuthOptions(),
      }),
    ) as unknown as ReturnType<typeof createClient<Database>>;
  }
  return createClient<Database>(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        storage: localStorage,
        storageKey: "sb-mortgage-ops-auth",
        persistSession: true,
        autoRefreshToken: true,
      },
    },
  );
})();
