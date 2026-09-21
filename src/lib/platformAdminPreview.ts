import { isPlatformOwner } from "@/lib/masterMerchant";

type PreviewUser = {
  email?: string | null;
  id?: string | null;
  app_metadata?: {
    isMasterOwner?: boolean;
    [key: string]: unknown;
  } | null;
} | null | undefined;

/**
 * Platform-admin tenant preview (Lovable parity).
 *
 * Authorized by the explicit platform-owner mailbox or the server-resolved
 * isMasterOwner flag from /identity/me. Does not require tenant_users
 * membership and does not create memberships.
 */
export function canPlatformPreviewTenant(user?: PreviewUser): boolean {
  if (!user) return false;
  if (user.app_metadata?.isMasterOwner === true) return true;
  return isPlatformOwner(user.email, user.id);
}
