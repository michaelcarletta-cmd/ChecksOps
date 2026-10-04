/**
 * Surgical staging dispatcher patch.
 * Starts from CURRENT live staging app-services.mjs and adds only the
 * Mortgage Agent Compensation Class A registration. Does not copy
 * production or origin/main dispatchers.
 */
export const LIVE_APP_SERVICES_SHA256 = '31b6c9d555f93941d78df067575765a565c5c58ad4c1ad9c4062f0be23207d9b';

const IMPORT_NEEDLE = "import { handleBillMortgageHandling } from './bill-mortgage-handling.mjs';\n";
const IMPORT_INSERT = `${IMPORT_NEEDLE}import { handleMortgageAgentCompensation } from './mortgage-agent-compensation.mjs';\n`;

const CLASS_A_NEEDLE = "  'hire-mortgage-agent',\n  'tenant-tax-profiles',\n";
const CLASS_A_INSERT = "  'hire-mortgage-agent',\n  'mortgage-agent-compensation',\n  'tenant-tax-profiles',\n";

const CASE_NEEDLE = "    case 'hire-mortgage-agent':\n      return handleHireMortgageAgent(event);\n    case 'tenant-tax-profiles':\n";
const CASE_INSERT = "    case 'hire-mortgage-agent':\n      return handleHireMortgageAgent(event);\n    case 'mortgage-agent-compensation':\n      return handleMortgageAgentCompensation(event);\n    case 'tenant-tax-profiles':\n";

export const REQUIRED_PRESERVED_ROUTES = Object.freeze([
  'homeowner-ledger-endorse-link',
  'homeowner-ledger-document-sign-link',
  'homeowner-ledger-sign-link',
  'homeowner-ledger-view',
  'send-signature-request',
  'tenant-email-branding-get',
  'tenant-email-branding-save',
  'hire-mortgage-agent',
  'bill-mortgage-handling',
  'tenant-tax-profiles',
]);

function count(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    n += 1;
    idx += needle.length;
  }
  return n;
}

export function patchLiveAppServices(source) {
  const src = String(source);
  if (src.includes('handleMortgageAgentCompensation') || src.includes("'mortgage-agent-compensation'")) {
    throw new Error('live dispatcher already registers mortgage-agent-compensation; STOP');
  }
  for (const [label, needle] of [
    ['import', IMPORT_NEEDLE],
    ['class_a', CLASS_A_NEEDLE],
    ['switch', CASE_NEEDLE],
  ]) {
    if (count(src, needle) !== 1) {
      throw new Error(`live dispatcher needle ${label} is not unique; STOP`);
    }
  }
  const patched = src
    .replace(IMPORT_NEEDLE, IMPORT_INSERT)
    .replace(CLASS_A_NEEDLE, CLASS_A_INSERT)
    .replace(CASE_NEEDLE, CASE_INSERT);
  if (!patched.includes("import { handleMortgageAgentCompensation } from './mortgage-agent-compensation.mjs';")) {
    throw new Error('import registration failed');
  }
  if (!patched.includes("  'mortgage-agent-compensation',\n")) {
    throw new Error('CLASS_A_FUNCTIONS registration failed');
  }
  if (!patched.includes("    case 'mortgage-agent-compensation':\n      return handleMortgageAgentCompensation(event);\n")) {
    throw new Error('switch/dispatcher registration failed');
  }
  for (const route of REQUIRED_PRESERVED_ROUTES) {
    if (!patched.includes(`'${route}'`)) {
      throw new Error(`patched dispatcher dropped preserved route ${route}`);
    }
  }
  if (patched.includes('save-tenant-billing-account') || patched.includes('tenant-company-branding-save')) {
    throw new Error('patched dispatcher absorbed production-only routes; STOP');
  }
  return patched;
}

export function addedLines(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  const removed = a.filter((line) => !b.includes(line));
  const added = b.filter((line) => !a.includes(line));
  return { removed, added };
}
