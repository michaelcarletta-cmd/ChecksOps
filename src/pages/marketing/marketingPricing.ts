/**
 * Public pricing is retired (owner, 2026-11-09: "Hide pricing everywhere"). No public page,
 * structured data, llms.txt or sitemap entry states a ChecksOps price; pricing is quoted on a
 * demo. Billing reads the tenant row and public.check_billing_config, never this file.
 */

/**
 * A risk-reversal term shown next to the demo CTA. It is a commercial promise, so it stays
 * null until the owner decides the exact term and publishes it in the Terms of Service.
 *
 * TODO(owner): decide whether to offer one (the website audit suggests a 30-day rollout
 * guarantee), add it to /terms, then set it here, e.g.
 * { text: "30-day rollout guarantee: ...", termsPath: "/terms" }. It must not state a price.
 */
export const ROLLOUT_GUARANTEE: { text: string; termsPath: string } | null = null;
