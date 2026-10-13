/**
 * Display-only capitalization for names read off checks (payees, carriers, banks).
 * Checks print names in ALL CAPS; this shows them in normal capitalization without
 * changing stored values. Only all-caps words are rewritten, so text a person typed
 * in mixed case ("McDonald", "iRoofing") is left alone.
 */
const KEEP_UPPER = new Set([
  "LLC", "LLP", "LP", "PC", "PA", "PLLC", "INC", "DBA", "FBO", "ISAOA", "ATIMA",
  "NA", "FSB", "FCU", "HOA", "NJM", "USAA", "USA", "US", "AAA", "AIG",
  "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII",
]);

const LOWER_CONNECTORS = new Set(["and", "of", "the", "for", "or", "in", "on", "at", "to", "by", "as"]);

const isAllCaps = (word: string) => {
  const letters = word.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
};

const capWord = (word: string) => {
  if (!word) return word;
  const upper = word.toUpperCase();
  if (KEEP_UPPER.has(upper)) return upper === "INC" ? "Inc" : upper;
  if (/^MC[A-Z]{2,}$/.test(upper)) return `Mc${upper.charAt(2)}${upper.slice(3).toLowerCase()}`;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
};

const capPart = (part: string) => {
  const match = part.match(/^([^A-Za-z]*)(.*?)([^A-Za-z]*)$/);
  if (!match) return part;
  const [, lead, core, trail] = match;
  if (!core) return part;
  // Dotted initials ("J.R.") and single-letter initials stay as printed.
  if (/^([A-Za-z]\.)*[A-Za-z]$/.test(core)) return `${lead}${core.toUpperCase()}${trail}`;
  const cased = core.split(/(['’])/).map((piece) => (/^['’]$/.test(piece) ? piece : capWord(piece))).join("");
  return `${lead}${cased}${trail}`;
};

const capToken = (token: string, isFirst: boolean) => {
  if (/\d/.test(token) || token.includes("@")) return token;
  const bare = token.replace(/[^A-Za-z]/g, "").toLowerCase();
  if (!isFirst && LOWER_CONNECTORS.has(bare) && /^[A-Za-z]+$/.test(token)) return token.toLowerCase();
  if (!isAllCaps(token)) return token;
  return token.split(/([-/&])/).map((part) => (/^[-/&]$/.test(part) ? part : capPart(part))).join("");
};

export function displayCase(value: string | null | undefined): string {
  if (value == null) return "";
  const text = String(value);
  let seenWord = false;
  return text.split(/(\s+)/).map((token) => {
    if (!token || /^\s+$/.test(token)) return token;
    const out = capToken(token, !seenWord);
    seenWord = true;
    return out;
  }).join("");
}

/** Like displayCase, but keeps null/undefined/empty so `?? "—"` fallbacks still work. */
export function displayCaseOrNull(value: string | null | undefined): string | null {
  if (value == null || value === "") return value ?? null;
  return displayCase(value);
}
