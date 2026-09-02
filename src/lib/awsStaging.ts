/**
 * Staging-only switch. Production Vite builds use `.env.production` and never
 * set VITE_AUTH_PROVIDER=cognito, so this stays false for ChecksOps.com.
 */
export function isAwsStaging(): boolean {
  return String(import.meta.env.VITE_AUTH_PROVIDER || "").toLowerCase() === "cognito";
}

export function awsApiBaseUrl(): string {
  return String(import.meta.env.VITE_CHECKSOPS_API_URL || "").replace(/\/$/, "");
}

export const AWS_STAGING_PUBLIC_CONFIG = {
  region: "us-east-1",
  userPoolId: String(import.meta.env.VITE_COGNITO_USER_POOL_ID || ""),
  userPoolClientId: String(import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID || ""),
} as const;
