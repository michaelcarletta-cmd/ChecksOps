/**
 * Plain-language state for the Check Command Center "Deposit image check" card.
 *
 * The bank-ready copy (<name>.checkalt.jpg) of the front is only written when
 * the user presses Deposit, so a missing prepared copy next to an existing
 * source photo is "Ready to prepare", not a failure. Only a real problem the
 * user has to fix is shown in red. Raw reason codes stay in `code` for support
 * and are never part of a label or hint.
 *
 * Display only: this does not decide whether Deposit is enabled.
 */

import {
  CHECKALT_MAX_COMPLIANT_BYTES,
  CHECKALT_MIN_BYTES,
  combineCheckAltCompliance,
  emptySide,
  evaluateCheckAltImageCompliance,
  isCheckAltArtifactPath,
  normalizeClaimRel,
  toCheckAltPath,
  type CheckAltComplianceStatus,
  type CheckAltSideReport,
} from "./checkaltImageCompliance.ts";

export type CheckAltSide = "front" | "rear";

export type CheckAltSideStateKind =
  /** No source photo / endorsed image recorded on the check. */
  | "no_source"
  /** The recorded image is itself the bank copy and it is not in storage. */
  | "source_missing"
  /** The source is not a JPG, PNG or WebP, so Deposit cannot prepare it. */
  | "unsupported_source"
  /** Source exists; the bank-ready copy has not been created yet. */
  | "ready_to_prepare"
  /** Bank-ready copy exists and passes validation. */
  | "ready"
  /** Bank-ready copy exists but fails validation. */
  | "needs_new_photo"
  /** Storage could not be reached; nothing is known either way. */
  | "unknown";

export type CheckAltSideState = {
  side: CheckAltSide;
  kind: CheckAltSideStateKind;
  /** Support-only reason code (e.g. front_too_small). Never shown as text. */
  code: string | null;
  report: CheckAltSideReport | null;
};

export type CheckAltTone = "neutral" | "good" | "bad";

export type CheckAltSideDisplay = {
  label: string;
  hint: string | null;
  tone: CheckAltTone;
  code: string | null;
};

type StorageErrorLike = {
  message?: unknown;
  error?: unknown;
  statusCode?: unknown;
  status?: unknown;
} | null | undefined;

export type CheckAltDownload = (
  path: string,
) => Promise<{ data: Blob | null; error: StorageErrorLike }>;

export type CheckAltMeasure = (blob: Blob) => Promise<{
  present: boolean;
  jpeg: boolean;
  width: number;
  height: number;
  bytes: number;
}>;

const RASTER_SOURCE = /\.(jpe?g|png|webp)$/i;

/**
 * True when storage says the object does not exist. /storage/sign answers 404
 * `object_not_in_s3` for a missing key; the signed GET can also 404, and the
 * Supabase client reports "Object not found".
 */
export const isStorageObjectMissing = (error: StorageErrorLike): boolean => {
  if (!error) return false;
  const status = Number(error.statusCode ?? error.status);
  if (status === 404) return true;
  const text = `${String(error.message ?? "")} ${String(error.error ?? "")}`;
  return /object_not_in_s3|not present in .*s3|object not found|not_found|\bnot found\b|NoSuchKey/i.test(text);
};

const sideState = (
  side: CheckAltSide,
  kind: CheckAltSideStateKind,
  code: string | null,
  report: CheckAltSideReport | null = null,
): CheckAltSideState => ({ side, kind, code, report });

export async function inspectCheckAltSide(
  sourcePath: string | null | undefined,
  side: CheckAltSide,
  deps: { download: CheckAltDownload; measure: CheckAltMeasure },
): Promise<CheckAltSideState> {
  const source = normalizeClaimRel(sourcePath);
  if (!source) return sideState(side, "no_source", `${side}_missing`);
  const sourceIsArtifact = isCheckAltArtifactPath(source);
  if (!sourceIsArtifact && !RASTER_SOURCE.test(source)) {
    return sideState(side, "unsupported_source", `${side}_unsupported_source`);
  }
  const artifact = toCheckAltPath(source);
  if (!artifact) return sideState(side, "no_source", `${side}_missing`);

  let result: Awaited<ReturnType<CheckAltDownload>>;
  try {
    result = await deps.download(artifact);
  } catch {
    return sideState(side, "unknown", `${side}_check_unavailable`);
  }
  if (result.error || !result.data) {
    if (isStorageObjectMissing(result.error) || (!result.error && !result.data)) {
      return sourceIsArtifact
        ? sideState(side, "source_missing", `${side}_source_missing`)
        : sideState(side, "ready_to_prepare", `${side}_not_prepared`);
    }
    return sideState(side, "unknown", `${side}_check_unavailable`);
  }

  let info: Awaited<ReturnType<CheckAltMeasure>>;
  try {
    info = await deps.measure(result.data);
  } catch {
    info = { present: true, jpeg: false, width: 0, height: 0, bytes: result.data.size || 0 };
  }
  const report = evaluateCheckAltImageCompliance(info, side);
  if (report.pass) return sideState(side, "ready", null, report);
  return sideState(side, "needs_new_photo", report.reason, report);
}

const kb = (bytes: number) => Math.round(bytes / 1024);

/** Plain reason for a prepared copy that fails validation. */
export const plainComplianceReason = (code: string | null | undefined): string => {
  const c = String(code || "");
  if (/_too_small$/.test(c)) return `Image is too small (under ${kb(CHECKALT_MIN_BYTES)} KB)`;
  if (/_too_large$/.test(c)) return `Image is too large (over ${kb(CHECKALT_MAX_COMPLIANT_BYTES)} KB)`;
  if (/_dimensions$/.test(c)) return "Image is the wrong size or shape";
  if (/_invalid_jpeg$/.test(c)) return "Image file is damaged or not a JPEG";
  if (/_missing$/.test(c)) return "Image file is empty";
  return "Image did not pass the bank's checks";
};

export function describeCheckAltSide(state: CheckAltSideState): CheckAltSideDisplay {
  const front = state.side === "front";
  const name = front ? "Front" : "Back";
  const code = state.code;
  switch (state.kind) {
    case "ready":
      return { label: `${name}: Ready for bank ✓`, hint: null, tone: "good", code };
    case "ready_to_prepare":
      return {
        label: `${name}: Ready to prepare`,
        hint: front
          ? "The bank-ready image is created when you press Deposit."
          : "The bank-ready image is created from the endorsed back when you press Deposit.",
        tone: "neutral",
        code,
      };
    case "needs_new_photo":
      return {
        label: `${name}: Needs a new photo`,
        hint: front
          ? `${plainComplianceReason(code)}. Upload a new photo of the front.`
          : `${plainComplianceReason(code)}. Redo the endorsement or upload a new photo of the back.`,
        tone: "bad",
        code,
      };
    case "no_source":
      return front
        ? { label: "Front: No photo uploaded", hint: "Upload the front of the check.", tone: "bad", code }
        : {
          label: "Back: No endorsed image yet",
          hint: "Complete the endorsement to create the back of the check.",
          tone: "bad",
          code,
        };
    case "source_missing":
      return front
        ? { label: "Front: Photo file is missing", hint: "Upload the front of the check again.", tone: "bad", code }
        : {
          label: "Back: Endorsed image is missing",
          hint: "Complete the endorsement again to recreate the back of the check.",
          tone: "bad",
          code,
        };
    case "unsupported_source":
      return {
        label: `${name}: Needs a new photo`,
        hint: front
          ? "This file type can't be sent to the bank. Upload a JPG or PNG photo of the front."
          : "This file type can't be sent to the bank. Redo the endorsement or upload a JPG or PNG photo of the back.",
        tone: "bad",
        code,
      };
    case "unknown":
    default:
      return {
        label: `${name}: Couldn't check the image right now`,
        hint: "Refresh the page to try again.",
        tone: "neutral",
        code,
      };
  }
}

export type CheckAltCardState = {
  front: CheckAltSideState;
  rear: CheckAltSideState;
};

export function checkAltCardHeading(state: CheckAltCardState): { text: string; tone: CheckAltTone } {
  const red = [state.front, state.rear].some((s) => describeCheckAltSide(s).tone === "bad");
  return red
    ? { text: "Needs attention", tone: "bad" }
    : { text: "Ready to deposit", tone: "good" };
}

/** Compatibility view: PASS only when both bank-ready copies exist and pass. */
export function toCheckAltComplianceStatus(state: CheckAltCardState): CheckAltComplianceStatus {
  const reportFor = (s: CheckAltSideState) => s.report ?? { ...emptySide(s.side), reason: s.code };
  return combineCheckAltCompliance(reportFor(state.front), reportFor(state.rear));
}

export async function loadCheckAltCardState(
  input: { frontImagePath?: string | null; backImageDepositPath?: string | null },
  deps: { download: CheckAltDownload; measure: CheckAltMeasure },
): Promise<CheckAltCardState> {
  const [front, rear] = await Promise.all([
    inspectCheckAltSide(input.frontImagePath, "front", deps),
    inspectCheckAltSide(input.backImageDepositPath, "rear", deps),
  ]);
  return { front, rear };
}
