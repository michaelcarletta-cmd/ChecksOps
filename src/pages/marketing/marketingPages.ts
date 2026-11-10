/**
 * Title, description, path and structured data for every public marketing page. The pages
 * read their values from here at runtime (usePageMeta), and the production build
 * (vite.config.ts, marketingStaticHead) writes the same values into each page's served HTML,
 * so link previews and crawlers that do not run JavaScript see the right page.
 *
 * Relative imports only: vite.config.ts imports this file, and the "@/" alias does not
 * resolve there.
 */
export interface FaqEntry {
  q: string;
  a: string;
}

export interface MarketingPage {
  /** Path on checksops.com, e.g. "/claim-check-tracking". */
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
// money-movement note). Rendered on the page and as FAQPage JSON-LD. No prices: the owner keeps
// pricing off the public site (2026-11-09).
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

// /vs/checksops-vs-iink-payments. iink facts come from the website audit of iink's public
// pages; see the TODO in ChecksOpsVsIink.tsx.
export const VS_IINK_FAQ: readonly FaqEntry[] = [
  {
    q: "Is ChecksOps a payment processor like iink?",
    a: "No. ChecksOps is workflow software, not a bank, lender, escrow service, or payment processor. Your company owns the process and controls all communications with carriers, mortgage companies, payees, and banks.",
  },
  {
    q: "How does the cost of a mortgage check compare?",
    a: "iink charges 1% of the check amount on checks with a mortgage company payee, with a $25 minimum and a cap of $299 to $329 depending on tier. ChecksOps charges the same flat rate per check whatever the amount or payee.",
  },
  {
    q: "Which is cheaper for a small firm?",
    a: "For a firm with a handful of checks a month, iink's $45-a-month Basic tier is a low monthly start. ChecksOps is built for firms that process insurance claim checks at scale; its pricing is quoted on a live demo.",
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
    "ChecksOps vs iink Payments for public adjusting firms: a control layer your firm runs at a flat rate per check, versus a payments network with monthly tiers and a 1% fee on mortgage checks.",
  jsonLd: faqJsonLd(VS_IINK_FAQ),
};

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
  ...HOME_FAQ.slice(2, 3),
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
  VS_IINK_PAGE,
  CLAIM_CHECK_TRACKING_PAGE,
];

/**
 * Paths that used to be public marketing pages and are retired. The SPA routes each to "/", and
 * the build still writes a copy of the home page (home head, canonical "/") to its S3 key, so a
 * guarded upload overwrites the old prerendered object: the uploader only puts objects and never
 * deletes, and the production CloudFront function serves these keys as they are
 * (aws/cloudfront/spa-fallback.js). /pricing: retired 2026-11-09, the owner keeps pricing off
 * the public site. The Snapsheet and Guidewire ClaimCenter comparisons: retired 2026-11-10, the
 * owner says those are carrier systems and not relevant to ChecksOps.
 */
export const RETIRED_MARKETING_PATHS: readonly string[] = [
  "/pricing",
  "/vs/checksops-vs-snapsheet",
  "/vs/checksops-vs-guidewire-claimcenter",
];

/** Footer links to the comparison and category pages. */
export const COMPARISON_LINKS: readonly { label: string; to: string }[] = [
  { label: "ChecksOps vs iink Payments", to: VS_IINK_PAGE.path },
  { label: "Claim check tracking", to: CLAIM_CHECK_TRACKING_PAGE.path },
];
