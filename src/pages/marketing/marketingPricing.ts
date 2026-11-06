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
