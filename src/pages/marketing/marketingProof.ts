/**
 * Real-world proof for the marketing home page. Every list below is EMPTY on purpose:
 * each section renders nothing until real, permitted entries are added here. Never add
 * placeholder quotes, sample numbers or a stand-in founder.
 */

export interface Testimonial {
  /** One specific outcome in the customer's words, e.g. a check found or a draw released faster. */
  quote: string;
  /** First name and last initial, as the customer approved. */
  name: string;
  role: string;
  firm: string;
  /** Optional photo URL, only with the customer's permission. */
  photoUrl?: string;
}

// TODO(owner): add 3 to 5 one-line testimonials from deployed firms (first name, firm, role,
// photo where permitted, one specific outcome). The wall stays hidden while this is empty.
export const TESTIMONIALS: Testimonial[] = [];

export interface UsageStat {
  /** The number as published, e.g. "12". */
  value: string;
  /** What it counts, e.g. "firms live". */
  label: string;
}

// TODO(owner): add real deployment numbers (firms live, checks processed, dollars in claim
// checks tracked) and set USAGE_STATS_UPDATED_ON. The strip stays hidden while this is empty.
export const USAGE_STATS: UsageStat[] = [];
/** Date the usage numbers were last checked, e.g. "November 6, 2026". Shown with the strip. */
export const USAGE_STATS_UPDATED_ON = "";

export interface Founder {
  name: string;
  role: string;
  photoUrl: string;
  linkedInUrl: string;
  /** One paragraph: the claim-check problem from inside the industry, in the founder's words. */
  story: string;
}

// TODO(owner): add the founder's name, role, real photo, LinkedIn URL and a one-paragraph
// "why I built this". The block (home page, above the demo form) stays hidden while null.
export const FOUNDER: Founder | null = null;

export interface ExternalSignal {
  /** e.g. "Product Hunt", "Capterra", or a trade publication. */
  source: string;
  /** What it says, e.g. "4.8 from 23 reviews" or the headline of a mention. */
  text: string;
  /** When it happened, e.g. "October 2026". Required: undated signals are not shown. */
  date: string;
  url: string;
}

// TODO(owner): add dated third-party signals (review-site rating with review count, a
// Product Hunt badge, a trade-press mention). The strip stays hidden while this is empty.
export const EXTERNAL_SIGNALS: ExternalSignal[] = [];

export interface HeroScreenshot {
  /** Image in public/, e.g. "/marketing/hero-dashboard.png". */
  src: string;
  /** What the screen shows, e.g. "ChecksOps check pipeline for a public adjusting firm: 12 checks ready for deposit". */
  alt: string;
  width: number;
  height: number;
}

// TODO(owner): add a real, permission-cleared screenshot of a firm's ChecksOps dashboard
// (payee names and claim numbers blurred or cleared with the firm). The hero shows the sample
// mock until this is set.
export const HERO_SCREENSHOT: HeroScreenshot | null = null;
