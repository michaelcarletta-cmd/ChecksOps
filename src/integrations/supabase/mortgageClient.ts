// Separate Supabase client for the Mortgage Ops portal.
// Uses a distinct localStorage key so that signing in/out of the Mortgage Desk
// is fully independent from the ChecksOps session (and vice versa).
// A super admin can be signed into both portals simultaneously without either
// affecting the other.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const mortgageSupabase = createClient<Database>(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      storage: localStorage,
      storageKey: "sb-mortgage-ops-auth",
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);
