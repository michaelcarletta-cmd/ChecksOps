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
  | "unknown";

export const INTENT_PATTERNS: Array<{ intent: DarwinIntent; pattern: RegExp }> = [
  { intent: "analyze", pattern: /run\s+(an?\s+)?analysis|analyze\s+this\s+claim|claim\s+analysis/i },
  { intent: "operating_manual", pattern: /operating\s+manual|scenarios\s*\+\s*mini\s+trainings|turn\s+into\s+(an?\s+)?(operating\s+)?manual/i },
  { intent: "case_study", pattern: /case\s+study|write\s+a\s+case\s+study|redact|remove\s+identifying/i },
  { intent: "marketing", pattern: /blog|facebook|instagram|tiktok|marketing\s+assets|turn\s+(the\s+)?case\s+study\s+into/i },
  { intent: "financial_qa", pattern: /what'?s\s+been\s+paid|depreciation|line\s+item|contents\s+vs\s+ale|dwelling\s+coverage|how\s+much\s+(is\s+)?(paid|outstanding)/i },
  { intent: "create_task", pattern: /^task[:\s]|create\s+(a\s+)?task|add\s+(a\s+)?task|remind\s+me|set\s+a?\s*reminder|follow\s*up\s+with|reach\s+out\s+to/i },
  { intent: "send_client_sms", pattern: /text\s+client|send\s+sms\s+(client|update|to)|sms\s+(client|update)/i },
  { intent: "send_client_email", pattern: /email\s+client|send\s+email\s*(client|update|to)?|email\s+update/i },
];

export function parseIntent(text: string): DarwinIntent {
  const t = text.trim();
  if (!t) return "unknown";
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(t)) return intent;
  }
  return "unknown";
}

export const ASSET_TYPES = {
  claim_analysis: "claim_analysis",
  operating_manual: "operating_manual",
  case_study: "case_study",
  marketing_assets: "marketing_assets",
} as const;
