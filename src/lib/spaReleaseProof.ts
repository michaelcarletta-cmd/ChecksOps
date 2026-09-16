/**
 * Unique compiled-artifact proof that Vite inlines from the actual build env.
 * Inspect this object in the bundle — do not treat source string literals
 * "cognito" or "/prep" as evidence that those values were configured.
 */
export const CHECKSOPS_SPA_RELEASE_PROOF = Object.freeze({
  "checksops.spa.proof": 1,
  auth: String(import.meta.env.VITE_AUTH_PROVIDER || "").toLowerCase(),
  api: String(import.meta.env.VITE_CHECKSOPS_API_URL || ""),
  pool: String(import.meta.env.VITE_COGNITO_USER_POOL_ID || ""),
  client: String(import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID || ""),
});
