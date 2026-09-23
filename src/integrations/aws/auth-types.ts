/**
 * Cognito-mapped session types for the ChecksOps AWS client.
 * These replace @supabase/supabase-js Session/User so the SPA has no SDK dependency.
 * Shape stays compatible with existing auth call sites (id, email, access_token).
 */

export type User = {
  id: string;
  aud: string;
  role: string;
  email?: string;
  email_confirmed_at?: string;
  phone?: string;
  confirmed_at?: string;
  last_sign_in_at?: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  identities: unknown[];
  created_at: string;
  updated_at: string;
  is_anonymous?: boolean;
};

export type Session = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
  user: User;
};
