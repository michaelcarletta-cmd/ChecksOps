/**
 * The prices the public marketing pages publish (/pricing, /vs/checksops-vs-iink-payments).
 * Display copy only: billing reads the tenant row and public.check_billing_config, not these.
 * index.html's JSON-LD and public/llms.txt repeat these numbers; change all three together.
 */
export const PUBLISHED_PRICING = {
  platformFee: "$7,500",
  platformFeeAmount: 7500,
  perCheck: "$4",
  perCheckAmount: 4,
  supportMonthly: "$100",
  supportAnnual: "$1,000",
} as const;

/**
 * A risk-reversal term shown next to the demo and pricing CTAs. It is a commercial promise,
 * so it stays null until the owner decides the exact term and publishes it in the Terms of
 * Service.
 *
 * TODO(owner): decide whether to offer one (the website audit suggests "30-day rollout
 * guarantee: if your team is not live and filing checks in 30 days, the platform fee is
 * refunded"), add it to /terms, then set it here, e.g.
 * { text: "30-day rollout guarantee: ...", termsPath: "/terms" }.
 */
export const ROLLOUT_GUARANTEE: { text: string; termsPath: string } | null = null;
