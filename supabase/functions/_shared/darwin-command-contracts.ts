/**
 * Darwin conversational command: intent types and output asset types.
 */

export type DarwinIntent =
  | "analyze"
  | "operating_manual"
  | "case_study"
  | "marketing"
  | "financial_qa"
  | "create_task"
  | "send_client_sms"
  | "send_client_email"
  | "summary"
  | "unknown";

/**
 * Strip common conversational prefixes so regex can match the core verb.
 * "Hey Darwin, can you please analyze this claim" → "analyze this claim"
 */
function stripPrefixes(text: string): string {
  return text
    .replace(/^(hey\s+darwin[,!.\s]*|darwin[,!.\s]*|hi\s+darwin[,!.\s]*|yo\s+darwin[,!.\s]*)/i, '')
    .replace(/^(can\s+you\s+)?(please\s+)?(go\s+ahead\s+and\s+)?/i, '')
    .replace(/^(i\s+need\s+(you\s+)?to\s+|i\s+want\s+(you\s+)?to\s+|i'd\s+like\s+(you\s+)?to\s+|could\s+you\s+)/i, '')
    .trim();
}

export const INTENT_PATTERNS: Array<{ intent: DarwinIntent; pattern: RegExp }> = [
  // ── Analysis ──
  { intent: "analyze", pattern: /\b(run|do|perform|start|generate|give\s+me)\s+(an?\s+)?(full\s+)?analysis\b|analyze\s+(this\s+)?(claim|file|property)|claim\s+analysis/i },
  // ── Operating manual ──
  { intent: "operating_manual", pattern: /operating\s+manual|scenarios\s*\+\s*mini\s+trainings|turn\s+into\s+(an?\s+)?(operating\s+)?manual/i },
  // ── Case study ──
  { intent: "case_study", pattern: /case\s+study|write\s+a\s+case\s+study|redact|remove\s+identifying/i },
  // ── Marketing ──
  { intent: "marketing", pattern: /blog|facebook|instagram|tiktok|marketing\s+assets?|turn\s+(the\s+)?case\s+study\s+into/i },
  // ── Financial QA ──
  { intent: "financial_qa", pattern: /what['']?s\s+been\s+paid|depreciation|line\s+item|contents\s+vs\s+ale|dwelling\s+coverage|how\s+much\s+(is\s+)?(paid|outstanding|owed|left|remaining)|total\s+(paid|payments|settlement)/i },
  // ── Summary ──
  { intent: "summary", pattern: /\bsummar(ize|y)\b|what\s+happened|latest\s+activity|what['']?s\s+new|recap|catch\s+me\s+up|bring\s+me\s+up\s+to\s+(speed|date)|what\s+did\s+i\s+miss|status\s+update/i },
  // ── Create task (broadened) ──
  { intent: "create_task", pattern: /^task[:\s]|create\s+(a\s+)?task|add\s+(a\s+)?task|make\s+(a\s+)?task|remind\s+me|set\s+a?\s*reminder|follow\s*up\s+(with|on)|reach\s+out\s+to|schedule\s+(a\s+)?(call|meeting|follow)/i },
  // ── Send client SMS (broadened) ──
  { intent: "send_client_sms", pattern: /text\s+(the\s+)?client|send\s+(a\s+)?sms\s*(to\s+)?(client|update|policyholder)?|sms\s+(the\s+)?(client|update|policyholder)|message\s+(the\s+)?client|shoot\s+(the\s+)?client\s+(a\s+)?text/i },
  // ── Send client email (broadened) ──
  { intent: "send_client_email", pattern: /email\s+(the\s+)?client|send\s+(an?\s+)?email\s*(to\s+)?(client|update|policyholder)?|email\s+(the\s+)?(policyholder|update)|draft\s+(an?\s+)?email/i },
];

export function parseIntent(text: string): DarwinIntent {
  const t = text.trim();
  if (!t) return "unknown";
  // First try raw text
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(t)) return intent;
  }
  // Then try with conversational prefixes stripped
  const stripped = stripPrefixes(t);
  if (stripped && stripped !== t) {
    for (const { intent, pattern } of INTENT_PATTERNS) {
      if (pattern.test(stripped)) return intent;
    }
  }
  return "unknown";
}

export const ASSET_TYPES = {
  claim_analysis: "claim_analysis",
  operating_manual: "operating_manual",
  case_study: "case_study",
  marketing_assets: "marketing_assets",
} as const;
