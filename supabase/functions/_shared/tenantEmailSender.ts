// Shared helper: resolve a tenant's effective email sender identity.
//
// Phase 1: all mail leaves from the platform's verified domain
// (notify.checksops.com). Per-tenant branding is applied via display name
// and Reply-To.
//
// Phase 2 (future): if the tenant has verified a custom sending domain,
// switch the actual From address / provider accordingly.

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const PLATFORM_SENDER_DOMAIN = 'notify.checksops.com'
export const PLATFORM_FROM_DOMAIN = 'checksops.com'
export const PLATFORM_FROM_LOCAL = 'noreply'
export const PLATFORM_DEFAULT_NAME = 'ChecksOps'

export interface ResolvedSender {
  /** RFC 5322 From header, e.g. `Acme Restoration <noreply@checksops.com>` */
  from: string
  /** Verified sending subdomain used by the email API for DKIM/return path */
  senderDomain: string
  /** Optional Reply-To header value */
  replyTo?: string
  /** 'lovable' (platform) or a future provider like 'resend'/'mailgun' */
  provider: 'lovable' | 'resend' | 'mailgun'
  /** True when the tenant has verified their own domain */
  usingCustomDomain: boolean
}

function escapeDisplayName(name: string): string {
  // Quote and escape display names that contain RFC 5322 specials.
  const trimmed = name.trim()
  if (!trimmed) return ''
  if (/[",<>@;:\\()\[\]]/.test(trimmed)) {
    return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return trimmed
}

function buildFrom(name: string, address: string): string {
  const display = escapeDisplayName(name)
  return display ? `${display} <${address}>` : address
}

/**
 * Resolve the effective sender for a given tenant. Safe to call with a
 * missing tenantId — falls back to the raw platform sender.
 */
export async function resolveTenantSender(
  client: SupabaseClient,
  tenantId: string | null | undefined,
): Promise<ResolvedSender> {
  const platform: ResolvedSender = {
    from: buildFrom(PLATFORM_DEFAULT_NAME, `${PLATFORM_FROM_LOCAL}@${PLATFORM_FROM_DOMAIN}`),
    senderDomain: PLATFORM_SENDER_DOMAIN,
    provider: 'lovable',
    usingCustomDomain: false,
  }

  if (!tenantId) return platform

  // Load tenant display name + email settings in parallel
  const [{ data: tenant }, { data: settings }] = await Promise.all([
    client
      .from('tenants')
      .select('name, email_from_name, email_from_address, email_reply_to')
      .eq('id', tenantId)
      .maybeSingle(),
    client
      .from('tenant_email_settings')
      .select(
        'from_name, reply_to, sending_mode, provider, sending_domain, from_address, domain_status',
      )
      .eq('tenant_id', tenantId)
      .maybeSingle(),
  ])

  const displayName =
    (settings?.from_name && settings.from_name.trim()) ||
    (tenant?.email_from_name && tenant.email_from_name.trim()) ||
    (tenant?.name && tenant.name.trim()) ||
    PLATFORM_DEFAULT_NAME

  const replyTo =
    settings?.reply_to?.trim() || tenant?.email_reply_to?.trim() || undefined

  // Phase 2: verified custom domain (DNS/DKIM verified through the in-app
  // domain-verification flow, sent via Resend directly)
  if (
    settings?.sending_mode === 'custom' &&
    settings?.domain_status === 'verified' &&
    settings?.sending_domain &&
    settings?.from_address
  ) {
    return {
      from: buildFrom(displayName, settings.from_address),
      senderDomain: settings.sending_domain,
      replyTo,
      provider: (settings.provider as ResolvedSender['provider']) || 'lovable',
      usingCustomDomain: true,
    }
  }

  // Phase 1.5: a tenant may set a custom From address (e.g.
  // noreply@theirbrand.com) in Admin Tenants > Email. We can only actually
  // send from that domain if it's registered as a verified sender in the
  // Lovable email platform — otherwise the send API returns 403
  // "no_matching_sender" and every email dead-letters.
  //
  // Since Phase 1.5 has no in-app DNS verification (that's Phase 2), we
  // treat the tenant-configured From address as a *Reply-To hint only* and
  // keep the outgoing envelope on the verified platform domain. If the
  // tenant later verifies their domain through the Phase 2 flow, the block
  // above takes over and their real From address is used.
  const tenantFromAddress = tenant?.email_from_address?.trim()
  const effectiveReplyTo =
    replyTo || (tenantFromAddress && tenantFromAddress.includes('@') ? tenantFromAddress : undefined)


  // Phase 1: platform sender with tenant display name + reply-to
  return {
    from: buildFrom(displayName, `${PLATFORM_FROM_LOCAL}@${PLATFORM_FROM_DOMAIN}`),
    senderDomain: PLATFORM_SENDER_DOMAIN,
    replyTo: effectiveReplyTo,
    provider: 'lovable',
    usingCustomDomain: false,
  }

}

/**
 * Convenience: build a service-role client and resolve in one call.
 * Prefer passing an existing client when possible.
 */
export async function resolveTenantSenderWithServiceClient(
  tenantId: string | null | undefined,
): Promise<ResolvedSender> {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const client = createClient(url, key)
  return resolveTenantSender(client, tenantId)
}
