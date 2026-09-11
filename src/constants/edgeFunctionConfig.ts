/**
 * Edge Function Configuration
 *
 * All edge functions in this project MUST use verify_jwt = false.
 * Public token-based flows require unauthenticated function access.
 *
 * Affected routes and their corresponding edge functions:
 * - /sign                   → document signing
 * - /endorse                → check endorsement
 * - /payment-direction/:id  → payment direction
 * - /h/claim/:token         → homeowner claim portal
 * - /h/upload               → homeowner check upload
 * - /invoice/:token         → public invoice
 * - /verify-account/:token  → account verification
 * - /pay-setup/:token       → recipient payment setup
 * - /ledger/:token          → homeowner ledger
 * - /h/ledger/:token        → alias for previously emailed AWS tracking links
 * - /unsubscribe            → email unsubscribe
 *
 * When adding new edge functions, set verify_jwt = false in supabase/config.toml:
 *
 *   [functions."your-function-name"]
 *   verify_jwt = false
 */

export const EDGE_FUNCTION_VERIFY_JWT = false as const;
