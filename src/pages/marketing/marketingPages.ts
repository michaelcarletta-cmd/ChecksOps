/**
 * Title, description, path and structured data for every public marketing page. The pages
 * read their values from here at runtime (usePageMeta), and the production build
 * (vite.config.ts, marketingStaticHead) writes the same values into each page's served HTML,
 * so link previews and crawlers that do not run JavaScript see the right page.
 *
 * Relative imports only: vite.config.ts imports this file, and the "@/" alias does not
 * resolve there.
 */
import { PUBLISHED_PRICING } from "./marketingPricing.ts";

export interface FaqEntry {
  q: string;
  a: string;
}

export interface MarketingPage {
  /** Path on checksops.com, e.g. "/pricing". */
  path: string;
  title: string;
  description: string;
  /** Structured data for this page only, beside the site-wide graph in index.html. */
  jsonLd?: Record<string, unknown>;
}

export function faqJsonLd(faq: readonly FaqEntry[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

// Home. Plain answers built only from what this site already states (footer disclaimer,
// money-movement note, /pricing). Rendered on the page and as FAQPage JSON-LD.
export const HOME_FAQ: readonly FaqEntry[] = [
  {
    q: "Is ChecksOps a bank or a payment processor?",
    a: "No. ChecksOps is workflow software, not a bank, lender, escrow service, or payment processor. Your company owns the process and controls all communications with carriers, mortgage companies, payees, and banks.",
  },
  {
    q: "Who holds the money in the wallet?",
    a: "Each organization gets its own wallet, separate and owned by your company. Money movement is powered by Moov, a regulated money services provider, and your company remains the merchant of record.",
  },
  {
    q: "What does it cost?",
    a: `A ${PUBLISHED_PRICING.platformFee} one-time platform fee per company, ${PUBLISHED_PRICING.perCheck} per check processed, and support and updates at ${PUBLISHED_PRICING.supportMonthly} a month or ${PUBLISHED_PRICING.supportAnnual} a year. Unlimited users, no minimums, no caps.`,
  },
  {
    q: "How long does setup take?",
    a: "We set up your environment, migrate historical data, and train your team. Most companies are live within two weeks.",
  },
];

export const HOME_PAGE: MarketingPage = {
  path: "/",
  title: "ChecksOps - Claim check workflow for public adjusting firms",
  description:
    "Claim check workflow for public adjusting firms and their restoration partners: every insurance check filed by claim, payee endorsements captured, deposit readiness and loss drafts tracked.",
  jsonLd: faqJsonLd(HOME_FAQ),
};

export const PRICING_PAGE: MarketingPage = {
  path: "/pricing",
  title: `ChecksOps Pricing - ${PUBLISHED_PRICING.platformFee} platform + ${PUBLISHED_PRICING.perCheck} per check`,
  description:
    `ChecksOps pricing for public adjusting firms: ${PUBLISHED_PRICING.platformFee} one-time platform fee per company, ${PUBLISHED_PRICING.perCheck} per claim check, support ${PUBLISHED_PRICING.supportMonthly} a month. Unlimited users, no minimums, no caps, with a worked first-year example.`,
};

/**
 * Worked first-year example for the pricing page: a firm processing 100 checks a month.
 * Every figure is derived from PUBLISHED_PRICING.
 */
export const PRICING_EXAMPLE = (() => {
  const checksPerMonth = 100;
  const supportMonthlyAmount = 100;
  const supportAnnualAmount = 1000;
  const checksMonthly = checksPerMonth * PUBLISHED_PRICING.perCheckAmount;
  const firstYearMonthlySupport = PUBLISHED_PRICING.platformFeeAmount + 12 * checksMonthly + 12 * supportMonthlyAmount;
  const firstYearAnnualSupport = PUBLISHED_PRICING.platformFeeAmount + 12 * checksMonthly + supportAnnualAmount;
  const yearTwoAnnualSupport = 12 * checksMonthly + supportAnnualAmount;
  return {
    checksPerMonth,
    checksMonthly,
    supportMonthlyAmount,
    firstYearMonthlySupport,
    firstYearAnnualSupport,
    yearTwoAnnualSupport,
    checksPerYear: 12 * checksPerMonth,
  };
})();

// /vs/checksops-vs-iink-payments. iink facts come from the website audit of iink's public
// pages; see the TODO in ChecksOpsVsIink.tsx.
export const VS_IINK_FAQ: readonly FaqEntry[] = [
  {
    q: "Is ChecksOps a payment processor like iink?",
    a: "No. ChecksOps is workflow software, not a bank, lender, escrow service, or payment processor. Your company owns the process and controls all communications with carriers, mortgage companies, payees, and banks.",
  },
  {
    q: "How does the cost of a mortgage check compare?",
    a: `iink charges 1% of the check amount on checks with a mortgage company payee, with a $25 minimum and a cap of $299 to $329 depending on tier. ChecksOps charges ${PUBLISHED_PRICING.perCheck} per check whatever the amount or payee.`,
  },
  {
    q: "Which is cheaper for a small firm?",
    a: `For a firm with a handful of checks a month, iink's $45-a-month Basic tier is the lower start. ChecksOps has a ${PUBLISHED_PRICING.platformFee} one-time platform fee and is built for firms that process insurance claim checks at scale.`,
  },
  {
    q: "Who controls the money and the mortgage company relationship?",
    a: "With ChecksOps, your company does. Each organization has its own wallet, your company stays the merchant of record, and your team keeps mortgage-company communication.",
  },
];

export const VS_IINK_PAGE: MarketingPage = {
  path: "/vs/checksops-vs-iink-payments",
  title: "ChecksOps vs iink Payments - Claim check workflow compared",
  description:
    `ChecksOps vs iink Payments for public adjusting firms: a control layer your firm runs at a flat ${PUBLISHED_PRICING.perCheck} per check, versus a payments network with monthly tiers and a 1% fee on mortgage checks.`,
  jsonLd: faqJsonLd(VS_IINK_FAQ),
};

/**
 * The two carrier-side claims platforms the audit research names (Snapsheet, Guidewire
 * ClaimCenter). Their facts are limited to what the website audit quotes from their own
 * public pages; nothing about their pricing or payment features is claimed.
 */
export interface CarrierPlatformComparison {
  page: MarketingPage;
  /** Product name as the vendor writes it. */
  name: string;
  /** Short name for table headers. */
  shortName: string;
  /** What the vendor's own site says, quoted. */
  ownWords: string[];
  /** Who it is built for, in plain words. */
  builtFor: string;
  faq: readonly FaqEntry[];
}

const carrierSideFaq = (name: string): FaqEntry[] => [
  {
    q: `Do I have to choose between ChecksOps and ${name}?`,
    a: `Usually not. ${name} is software for the insurer's side of the claim. ChecksOps is for the public adjusting firm that receives the claim check: filing it by claim, collecting payee endorsements, getting it deposited and tracking loss drafts held by a mortgage company.`,
  },
  {
    q: "Is ChecksOps a claims system for carriers?",
    a: "No. ChecksOps is built for public adjusting firms and their restoration partners. It does not adjust claims or issue carrier payments. It is workflow software, not a bank, lender, escrow service, or payment processor.",
  },
  {
    q: "What does ChecksOps cost?",
    a: `A ${PUBLISHED_PRICING.platformFee} one-time platform fee per company, ${PUBLISHED_PRICING.perCheck} per check processed, and support and updates at ${PUBLISHED_PRICING.supportMonthly} a month or ${PUBLISHED_PRICING.supportAnnual} a year. Unlimited users, no minimums, no caps.`,
  },
];

export const VS_SNAPSHEET: CarrierPlatformComparison = {
  name: "Snapsheet",
  shortName: "Snapsheet",
  ownWords: [
    "Replace patchwork solutions with a complete claims system.",
    "One claim view. Total visibility.",
    "Trusted by 170+ customers & investors, including 16 of the top 20 P&C carriers.",
  ],
  builtFor: "Carriers and claims organizations running the claim from the insurer's side.",
  faq: carrierSideFaq("Snapsheet"),
  page: {
    path: "/vs/checksops-vs-snapsheet",
    title: "ChecksOps vs Snapsheet - Claim check workflow for PA firms",
    description:
      "ChecksOps vs Snapsheet: Snapsheet is a claims system for carriers. ChecksOps is the claim check workflow for public adjusting firms, from payee endorsements to deposit and loss draft tracking.",
  },
};
VS_SNAPSHEET.page.jsonLd = faqJsonLd(VS_SNAPSHEET.faq);

export const VS_GUIDEWIRE: CarrierPlatformComparison = {
  name: "Guidewire ClaimCenter",
  shortName: "Guidewire",
  ownWords: [
    "The P&C platform, built for AI",
    "570+ insurers trust to run their core operations.",
  ],
  builtFor: "Property and casualty insurers running their core claims operations.",
  faq: carrierSideFaq("Guidewire ClaimCenter"),
  page: {
    path: "/vs/checksops-vs-guidewire-claimcenter",
    title: "ChecksOps vs Guidewire ClaimCenter - For PA firms, not carriers",
    description:
      "ChecksOps vs Guidewire ClaimCenter: ClaimCenter runs an insurer's core claims operations. ChecksOps is the claim check workflow for public adjusting firms: endorsements, deposit readiness, loss drafts.",
  },
};
VS_GUIDEWIRE.page.jsonLd = faqJsonLd(VS_GUIDEWIRE.faq);

// Category page for "claim check tracking" and "loss draft tracking" searches.
export const CLAIM_CHECK_TRACKING_FAQ: readonly FaqEntry[] = [
  {
    q: "What is claim check tracking?",
    a: "Knowing, for every insurance claim check your firm receives, which claim it belongs to, who still has to endorse it, whether it is ready to deposit, and where any loss draft held by a mortgage company stands.",
  },
  {
    q: "How do most public adjusting firms track claim checks today?",
    a: "In inboxes, spreadsheets and paper files. Status lives in someone's head, and partners email to ask where a check is.",
  },
  {
    q: "How does ChecksOps track loss drafts?",
    a: "Each loss draft stays on its claim file with the mortgage company, the amount held, draw requests and every status change in the audit log, while your team keeps the mortgage-company communication.",
  },
  ...HOME_FAQ.slice(2, 4),
];

export const CLAIM_CHECK_TRACKING_PAGE: MarketingPage = {
  path: "/claim-check-tracking",
  title: "Claim check and loss draft tracking for public adjusting firms - ChecksOps",
  description:
    "Track every insurance claim check by claim: payee endorsements, deposit readiness, and loss drafts held by mortgage companies. Built for public adjusting firms and their restoration partners.",
  jsonLd: faqJsonLd(CLAIM_CHECK_TRACKING_FAQ),
};

/** Every page that gets its own served HTML head at build time (home is index.html itself). */
export const MARKETING_PAGES: readonly MarketingPage[] = [
  HOME_PAGE,
  PRICING_PAGE,
  VS_IINK_PAGE,
  VS_SNAPSHEET.page,
  VS_GUIDEWIRE.page,
  CLAIM_CHECK_TRACKING_PAGE,
];

/** Footer and pricing-page links to the comparison and category pages. */
export const COMPARISON_LINKS: readonly { label: string; to: string }[] = [
  { label: "ChecksOps vs iink Payments", to: VS_IINK_PAGE.path },
  { label: "ChecksOps vs Snapsheet", to: VS_SNAPSHEET.page.path },
  { label: "ChecksOps vs Guidewire ClaimCenter", to: VS_GUIDEWIRE.page.path },
  { label: "Claim check tracking", to: CLAIM_CHECK_TRACKING_PAGE.path },
];
