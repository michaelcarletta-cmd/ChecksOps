/**
 * Weak Language Filter
 * Detects and rewrites vague or non-authoritative language in justification text.
 * Returns cleaned text and a flag if revision was needed.
 */

interface FilterResult {
  text: string;
  wasFiltered: boolean;
  flaggedPhrases: string[];
}

const WEAK_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /required per code(?!\s*\()/gi,
    replacement: "required per adopted building code",
  },
  {
    pattern: /industry standard[s]?/gi,
    replacement: "manufacturer installation requirements and adopted building code",
  },
  {
    pattern: /typically required/gi,
    replacement: "required per system specifications",
  },
  {
    pattern: /generally required/gi,
    replacement: "required per manufacturer and code specifications",
  },
  {
    pattern: /it is recommended/gi,
    replacement: "it is required",
  },
  {
    pattern: /best practice[s]?/gi,
    replacement: "manufacturer-specified installation requirements",
  },
  {
    pattern: /common[ly]?\s+(?:used|installed|applied)/gi,
    replacement: "required per system specifications",
  },
  {
    pattern: /should be (?:used|installed|applied)/gi,
    replacement: "must be installed",
  },
  {
    pattern: /it appears/gi,
    replacement: "the evidence indicates",
  },
  {
    pattern: /it seems/gi,
    replacement: "the documentation shows",
  },
];

export function filterWeakLanguage(text: string): FilterResult {
  let filtered = text;
  const flaggedPhrases: string[] = [];

  for (const { pattern, replacement } of WEAK_PATTERNS) {
    const match = filtered.match(pattern);
    if (match) {
      flaggedPhrases.push(match[0]);
      filtered = filtered.replace(pattern, replacement);
    }
  }

  return {
    text: filtered,
    wasFiltered: flaggedPhrases.length > 0,
    flaggedPhrases,
  };
}
