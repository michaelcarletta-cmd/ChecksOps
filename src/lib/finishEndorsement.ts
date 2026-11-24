/**
 * "Finish endorsement" on the check page (owner 2026-11-24, item 3 of "1 and 3").
 *
 * When the last payee signs, the API composites the endorsed back image and, only if that
 * succeeds, advances the check to ready. If the composite fails at that moment the check is
 * stuck: every signature is collected but there is no endorsed back image and the status never
 * advanced. The button re-runs the same completion path through the live, authenticated
 * `check-endorsement` action `finalize_existing_endorsements` (website only, no API change).
 *
 * This file holds the two pure pieces: when the button shows, and the owner-facing message for
 * the action's result. The result shape is finalizeEndorsementState / applyAutoAdvanceIfEligible
 * in aws/functions/api/check-endorsement.mjs and compositeEndorsementSignatures in
 * aws/functions/api/endorsement-composite.mjs.
 */
import { evaluateEndorsementMath, type EndorsementRow } from "./endorsementCompletion.ts";
import { isCheckDeposited, type CheckDepositStateLike } from "./checkValidity.ts";

export const FINISH_ENDORSEMENT_ACTION = "finalize_existing_endorsements" as const;

/**
 * Statuses and stages that mean the check already advanced past endorsing: ready for deposit
 * (the page's manuallyReadyForDeposit), routed to branch deposit, or deposited / released
 * (isCheckDeposited covers deposited_at and the deposited / released statuses and stages).
 */
export const ADVANCED_CHECK_STATUSES: ReadonlySet<string> = new Set([
  "approved_for_deposit",
  "deposit_ready",
  "endorsements_complete",
  "branch_deposit_required",
]);

export const ADVANCED_CHECK_STAGES: ReadonlySet<string> = new Set([
  "ready_for_deposit",
  "branch",
]);

export type FinishEndorsementCheck = CheckDepositStateLike & {
  deposit_recommendation?: string | null;
};

const norm = (v: string | null | undefined) => String(v ?? "").trim().toLowerCase();

export function hasCheckAdvancedPastEndorsing(check: FinishEndorsementCheck | null | undefined): boolean {
  if (!check) return true; // unknown state: fail closed, no button
  if (isCheckDeposited(check)) return true;
  if (ADVANCED_CHECK_STATUSES.has(norm(check.status))) return true;
  if (ADVANCED_CHECK_STAGES.has(norm(check.check_stage))) return true;
  return false;
}

export interface FinishEndorsementVisibilityInput {
  /** The viewer's tenant owns the check (CheckCommandCenter's isOwner). */
  isOwner: boolean;
  /** Read-only or partner (shared) view. */
  readOnly?: boolean;
  partnerMode?: boolean;
  endorsements: EndorsementRow[];
  check: FinishEndorsementCheck | null | undefined;
}

/** The button shows only to the owning tenant, once every required endorsement is satisfied
 *  (the same math as the checklist's "All Complete"), while the check has not advanced. */
export function shouldShowFinishEndorsement(input: FinishEndorsementVisibilityInput): boolean {
  if (!input.isOwner || input.readOnly || input.partnerMode) return false;
  const { allRequiredSatisfied, anyRejected } = evaluateEndorsementMath(input.endorsements ?? []);
  if (!allRequiredSatisfied || anyRejected) return false;
  return !hasCheckAdvancedPastEndorsing(input.check);
}

/** Composite failures that mean the back photo could not be made into a bank-ready image. */
export const IMAGE_UNUSABLE_ERRORS: ReadonlySet<string> = new Set([
  "source_too_small",
  "too_small",
  "too_large",
  "aspect_distorted",
  "quality_floor_violated",
  "checkalt_normalize_failed",
  "unsupported_image",
]);

export const FINISH_ENDORSEMENT_SUCCESS = "Endorsement finished. The check is ready for deposit.";
export const FINISH_ENDORSEMENT_SUCCESS_BRANCH = "Endorsement finished. The check is ready for deposit at the branch.";

export const FINISH_ENDORSEMENT_MESSAGES: Readonly<Record<string, string>> = {
  signature_image_missing:
    "One of the signed endorsements has no drawn signature saved. Ask that payee to sign again.",
  original_back_missing:
    "The original photo of the back of the check is missing. Upload the back of the check again.",
  original_back_unavailable:
    "The original photo of the back of the check is missing. Upload the back of the check again.",
  original_back_ambiguous:
    "More than one back photo was found; upload the back of the check again so we know which to use.",
  historical_deposit_locked:
    "This check has already been deposited, so its endorsement can't be finished again.",
  held_loss_draft:
    "The check is on a loss-draft hold, so it can't be moved to ready for deposit until the loss draft is released.",
  skipped_ineligible:
    "The check's current stage can't be moved to ready for deposit automatically.",
  image_unusable:
    "The back photo couldn't be made into a bank-ready image; upload a clearer photo of the back.",
  not_all_signed:
    "Not every required endorsement is signed yet, so the endorsement can't be finished.",
  rejected:
    "A payee rejected the endorsement, so the check was sent back to review.",
  forbidden:
    "Only the company that owns this check can finish its endorsement.",
};

export const FINISH_ENDORSEMENT_GENERIC =
  "The endorsement couldn't be finished. Try again, or contact support with the error code.";

type Composited = {
  ok?: boolean;
  error?: string | null;
  message?: string | null;
  missing?: unknown;
} | null | undefined;

export interface FinishEndorsementResult {
  ok?: boolean;
  success?: boolean;
  error?: string | null;
  message?: string | null;
  allSigned?: boolean;
  anyRejected?: boolean;
  composited?: Composited;
  officialRearReady?: boolean;
  newStatus?: string | null;
  depositAdvanceDenied?: boolean;
  advance_check_on_endorsement_complete?: string | null;
}

export interface FinishEndorsementOutcome {
  /** True only when the check advanced (or already was ready) with an endorsed back image. */
  advanced: boolean;
  /** Machine code the message was chosen from ("applied", "signature_image_missing", ...). */
  code: string;
  title: string;
  message: string;
}

const ADVANCED_CODES: ReadonlySet<string> = new Set(["applied", "already_ready", "branch_deposit_required"]);

function payeeNames(missing: unknown): string[] {
  if (!Array.isArray(missing)) return [];
  return missing
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter(Boolean);
}

function failure(code: string, message: string): FinishEndorsementOutcome {
  return { advanced: false, code, title: "Endorsement not finished", message };
}

function messageForError(code: string, composited?: Composited): FinishEndorsementOutcome {
  if (code === "signature_image_missing") {
    const names = payeeNames(composited?.missing);
    const base = FINISH_ENDORSEMENT_MESSAGES.signature_image_missing;
    return failure(code, names.length ? `${base} Missing: ${names.join(", ")}.` : base);
  }
  if (IMAGE_UNUSABLE_ERRORS.has(code)) {
    return failure(code, FINISH_ENDORSEMENT_MESSAGES.image_unusable);
  }
  const known = FINISH_ENDORSEMENT_MESSAGES[code];
  if (known) return failure(code, known);
  return failure(code, `${FINISH_ENDORSEMENT_GENERIC} (Error code: ${code})`);
}

/** Owner-facing outcome of `finalize_existing_endorsements`. Pass the response body, or the
 *  error payload when the call returned a non-2xx status. */
export function describeFinishEndorsementResult(
  result: FinishEndorsementResult | null | undefined,
): FinishEndorsementOutcome {
  if (!result || typeof result !== "object") {
    return messageForError("no_response");
  }
  const advance = String(result.advance_check_on_endorsement_complete || "");
  const composited = result.composited && typeof result.composited === "object" ? result.composited : null;

  if (result.depositAdvanceDenied === false && ADVANCED_CODES.has(advance) && result.ok !== false) {
    return {
      advanced: true,
      code: advance,
      title: "Endorsement finished",
      message: advance === "branch_deposit_required"
        ? FINISH_ENDORSEMENT_SUCCESS_BRANCH
        : FINISH_ENDORSEMENT_SUCCESS,
    };
  }

  // A hold or an ineligible stage blocks the advance whatever happened to the image.
  if (advance === "held_loss_draft" || advance === "skipped_ineligible") {
    return messageForError(advance);
  }
  if (composited && composited.ok === false && composited.error) {
    return messageForError(String(composited.error), composited);
  }
  if (result.anyRejected) return messageForError("rejected");
  if (result.allSigned === false || advance === "denied") return messageForError("not_all_signed");
  if (advance) return messageForError(advance);
  if (result.error) return messageForError(String(result.error));
  // Image made but no advance decision returned (automatic advance switched off on the server).
  return messageForError("not_advanced");
}
