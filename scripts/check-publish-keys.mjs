#!/usr/bin/env node
/**
 * Historical Lovable/Supabase publish-key drift check.
 *
 * AWS production/staging builds (`--mode aws`) do not embed VITE_SUPABASE_*.
 * This script is kept so CI `check:publish-keys` stays a green no-op instead of
 * blocking on the retired .env.production Supabase credentials.
 */
console.log("[check-publish-keys] AWS frontend builds do not use VITE_SUPABASE_* — skip.");
process.exit(0);
