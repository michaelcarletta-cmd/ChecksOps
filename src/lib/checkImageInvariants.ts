export const CLEAN_STEM_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;

const ENDORSED_FILENAME_RE = /^(.*)_endorsed(?:_\d+)?\.[^.]+$/i;

export function isGeneratedBackArtifactPath(path: string | null | undefined): boolean {
  const p = String(path ?? "").trim();
  if (!p) return false;
  return (
    /_endorsed(?:_\d+)?\.[^.]+$/i.test(p) ||
    /endorsed_deposit_[^/]+\.[^.]+$/i.test(p) ||
    /\.svg(\?|$)/i.test(p) ||
    /\.checkalt\.jpg(\?|$)/i.test(p)
  );
}

/** Recognized generated endorsed filename: *_endorsed_*.ext — not deposit or checkalt. */
export function isRecognizedEndorsedGeneratedPath(path: string | null | undefined): boolean {
  const raw = String(path ?? "").trim().split("?")[0];
  if (!raw) return false;
  if (/endorsed_deposit_[^/]+\.[^.]+$/i.test(raw)) return false;
  if (/\.checkalt\.jpg$/i.test(raw)) return false;
  const name = fileNameOf(raw);
  return Boolean(name && ENDORSED_FILENAME_RE.test(name));
}

export function endorsedGeneratedStem(path: string | null | undefined): {
  directory: string;
  stem: string;
  candidates: string[];
} | null {
  const raw = String(path ?? "").trim().split("?")[0];
  if (!raw || !isRecognizedEndorsedGeneratedPath(raw)) return null;
  const directory = parentDirectory(raw) ?? "";
  const name = fileNameOf(raw);
  const match = name ? name.match(ENDORSED_FILENAME_RE) : null;
  const stem = match?.[1]?.trim() || "";
  if (!stem || stem.includes("/") || isGeneratedBackArtifactPath(stem)) return null;
  const candidates = CLEAN_STEM_EXTENSIONS.map((ext) => joinSibling(directory || null, `${stem}${ext}`));
  return { directory, stem, candidates };
}

export function isExactCleanStemOfGeneratedPointer(
  cleanPath: string | null | undefined,
  generatedPath: string | null | undefined,
): boolean {
  const rel = String(cleanPath ?? "").trim().split("?")[0];
  if (!rel || isGeneratedBackArtifactPath(rel)) return false;
  const derived = endorsedGeneratedStem(generatedPath);
  return Boolean(derived?.candidates.includes(rel));
}

export function assertCleanBackOriginalPath(path: string | null | undefined): string {
  const p = String(path ?? "").trim();
  if (!p) throw new Error("Clean back-of-check image path is missing.");
  if (isGeneratedBackArtifactPath(p)) {
    throw new Error("Refusing to treat a generated artifact as the clean original back image.");
  }
  return p;
}

export const CLEAN_ORIGINAL_MISSING_MESSAGE =
  "Clean original back image could not be recovered.";
export const CLEAN_ORIGINAL_AMBIGUOUS_MESSAGE =
  "Ambiguous clean original back image candidates; refusing to guess.";

const META_ORIGINAL_KEYS = [
  "original_back_image_path",
  "original_back_path",
  "originalBackImagePath",
] as const;

export type CleanBackOriginalRecord = {
  back_image_original_path?: string | null;
  back_image_path?: string | null;
  back_image_deposit_path?: string | null;
  endorsement_render_meta?: unknown;
};

export type CleanBackOriginalAudit = {
  original_back_image_path?: string | null;
  original_back_path?: string | null;
  endorsed_back_image_path?: string | null;
  composited_path?: string | null;
  composited_back_path?: string | null;
};

export type RecoverCleanBackOriginalInput = {
  record: CleanBackOriginalRecord;
  audits?: Array<CleanBackOriginalAudit | null | undefined> | null;
  siblingNames?: Array<string | null | undefined> | null;
  existingStemPaths?: Array<string | null | undefined> | null;
  normalizePath?: (path: string | null | undefined) => string | null;
};

export type RecoverCleanBackOriginalSource =
  | "original"
  | "meta"
  | "audit"
  | "current"
  | "sibling"
  | "endorsed_stem";

export type RecoverCleanBackOriginalSuccess = {
  ok: true;
  path: string;
  source: RecoverCleanBackOriginalSource;
};

export type RecoverCleanBackOriginalFailure = {
  ok: false;
  reason: "missing" | "ambiguous";
  message: string;
  directory: string | null;
  canTryAudits: boolean;
  canTrySiblings: boolean;
  canTryStemProbe: boolean;
};

export type RecoverCleanBackOriginalResult =
  | RecoverCleanBackOriginalSuccess
  | RecoverCleanBackOriginalFailure;

type Normalize = (path: string | null | undefined) => string | null;

function defaultNormalize(path: string | null | undefined): string | null {
  const p = String(path ?? "").trim();
  return p || null;
}

function parentDirectory(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

function fileNameOf(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function joinSibling(directory: string | null, name: string): string {
  if (!directory) return name;
  return `${directory}/${name}`;
}

function isFrontLikeName(name: string): boolean {
  return /(?:^|[/_-])front(?:[._-]|\.|$)/i.test(name);
}

function collectString(value: unknown, into: string[]): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) into.push(trimmed);
}

export function extractMetaOriginals(meta: unknown): string[] {
  const found: string[] = [];
  if (!meta || typeof meta !== "object") return found;
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 2) return;
    const record = value as Record<string, unknown>;
    for (const key of META_ORIGINAL_KEYS) {
      collectString(record[key], found);
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") visit(nested, depth + 1);
    }
  };
  visit(meta, 0);
  return [...new Set(found)];
}

function isUsableClean(
  path: string | null,
  depositPath: string | null,
): path is string {
  if (!path) return false;
  if (isGeneratedBackArtifactPath(path)) return false;
  if (depositPath && path === depositPath) return false;
  return true;
}

function fail(
  reason: RecoverCleanBackOriginalFailure["reason"],
  directory: string | null,
  auditsProvided: boolean,
  siblingsProvided: boolean,
  stemProbeProvided = true,
  canProbeStem = false,
): RecoverCleanBackOriginalFailure {
  return {
    ok: false,
    reason,
    message: reason === "ambiguous"
      ? CLEAN_ORIGINAL_AMBIGUOUS_MESSAGE
      : CLEAN_ORIGINAL_MISSING_MESSAGE,
    directory,
    canTryAudits: !auditsProvided,
    canTrySiblings: !siblingsProvided && directory !== null,
    canTryStemProbe: !stemProbeProvided && canProbeStem,
  };
}

export function recoverCleanBackOriginalPath(
  input: RecoverCleanBackOriginalInput,
): RecoverCleanBackOriginalResult {
  const normalize: Normalize = input.normalizePath ?? defaultNormalize;
  const original = normalize(input.record.back_image_original_path);
  const current = normalize(input.record.back_image_path);
  const deposit = normalize(input.record.back_image_deposit_path);
  const metaOriginals = extractMetaOriginals(input.record.endorsement_render_meta)
    .map((path) => normalize(path))
    .filter((path): path is string => Boolean(path));

  const auditsProvided = input.audits !== undefined && input.audits !== null;
  const siblingsProvided = input.siblingNames !== undefined && input.siblingNames !== null;
  const stemProbeProvided = input.existingStemPaths !== undefined && input.existingStemPaths !== null;

  const hintPaths = [original, current, deposit, ...metaOriginals];
  const directory = hintPaths.map(parentDirectory).find((dir) => dir !== null) ?? null;
  const stemSources = [original, current].filter((path): path is string => Boolean(endorsedGeneratedStem(path)));
  const stemCandidates = [...new Set(stemSources.flatMap((path) => endorsedGeneratedStem(path)?.candidates ?? []))];

  if (isUsableClean(original, deposit)) {
    return { ok: true, path: original, source: "original" };
  }

  const usableMeta = metaOriginals.find((path) => isUsableClean(path, deposit));
  if (usableMeta) {
    return { ok: true, path: usableMeta, source: "meta" };
  }

  if (auditsProvided) {
    const audits = (input.audits ?? []).filter(Boolean) as CleanBackOriginalAudit[];
    const artifactHints = new Set(
      [original, current, deposit].filter((path): path is string => Boolean(path)),
    );
    const matching = audits.filter((audit) => {
      const artifacts = [
        normalize(audit.endorsed_back_image_path),
        normalize(audit.composited_path),
        normalize(audit.composited_back_path),
      ].filter((path): path is string => Boolean(path));
      return artifacts.some((path) => artifactHints.has(path));
    });
    const ordered = matching.length ? [...matching, ...audits] : audits;
    for (const audit of ordered) {
      const candidates = [
        normalize(audit.original_back_image_path),
        normalize(audit.original_back_path),
      ];
      const usable = candidates.find((path) => isUsableClean(path, deposit));
      if (usable) return { ok: true, path: usable, source: "audit" };
    }
  }

  if (isUsableClean(current, deposit)) {
    return { ok: true, path: current, source: "current" };
  }

  if (stemProbeProvided) {
    const existing = [...new Set(
      (input.existingStemPaths ?? [])
        .map((path) => normalize(path))
        .filter((path): path is string => Boolean(path) && stemCandidates.includes(path) && isUsableClean(path, deposit)),
    )];
    if (existing.length === 1) {
      return { ok: true, path: existing[0], source: "endorsed_stem" };
    }
    if (existing.length > 1) {
      return fail("ambiguous", directory, auditsProvided, siblingsProvided, true, false);
    }
  }

  if (!siblingsProvided) {
    return fail("missing", directory, auditsProvided, false, stemProbeProvided, stemCandidates.length > 0);
  }

  const siblingNames = (input.siblingNames ?? [])
    .map((name) => String(name ?? "").trim())
    .map((name) => (name.includes("/") ? fileNameOf(name) ?? name : name))
    .filter(Boolean);

  if (stemCandidates.length) {
    const stemHits = [...new Set(
      stemCandidates.filter((path) => {
        const name = fileNameOf(path);
        return Boolean(name && siblingNames.includes(name) && isUsableClean(path, deposit));
      }),
    )];
    if (stemHits.length === 1) {
      return { ok: true, path: stemHits[0], source: "endorsed_stem" };
    }
    if (stemHits.length > 1) {
      return fail("ambiguous", directory, auditsProvided, true, stemProbeProvided, false);
    }
  }

  const depositName = fileNameOf(deposit);
  const cleanSiblings = siblingNames.filter((name) => (
    !name.includes("/")
    && !isGeneratedBackArtifactPath(name)
    && !isFrontLikeName(name)
    && name !== depositName
  ));

  const uniqueClean = [...new Set(cleanSiblings)];
  if (uniqueClean.length === 1) {
    return { ok: true, path: joinSibling(directory, uniqueClean[0]), source: "sibling" };
  }
  if (uniqueClean.length > 1) {
    return fail("ambiguous", directory, auditsProvided, true);
  }
  return fail("missing", directory, auditsProvided, true);
}

export function collectEndorsedCleanStemCandidates(
  record: CleanBackOriginalRecord,
  normalizePath?: (path: string | null | undefined) => string | null,
): string[] {
  const normalize: Normalize = normalizePath ?? defaultNormalize;
  const original = normalize(record.back_image_original_path);
  const current = normalize(record.back_image_path);
  return [...new Set(
    [original, current].flatMap((path) => endorsedGeneratedStem(path)?.candidates ?? []),
  )];
}

export async function resolveCleanBackOriginalPath(opts: {
  record: CleanBackOriginalRecord;
  audits?: Array<CleanBackOriginalAudit | null | undefined> | null;
  siblingNames?: Array<string | null | undefined> | null;
  existingStemPaths?: Array<string | null | undefined> | null;
  normalizePath?: (path: string | null | undefined) => string | null;
  loadAudits?: () => Promise<Array<CleanBackOriginalAudit | null | undefined>>;
  loadSiblingNames?: (directory: string) => Promise<Array<string | null | undefined>>;
  probeCleanStemPaths?: (candidates: string[]) => Promise<Array<string | null | undefined>>;
}): Promise<RecoverCleanBackOriginalSuccess> {
  let audits = opts.audits ?? null;
  let siblingNames = opts.siblingNames ?? null;
  let existingStemPaths = opts.existingStemPaths ?? null;
  let result = recoverCleanBackOriginalPath({
    record: opts.record,
    audits,
    siblingNames,
    existingStemPaths,
    normalizePath: opts.normalizePath,
  });

  if (!result.ok && result.canTryAudits && opts.loadAudits) {
    audits = await opts.loadAudits();
    result = recoverCleanBackOriginalPath({
      record: opts.record,
      audits,
      siblingNames,
      existingStemPaths,
      normalizePath: opts.normalizePath,
    });
  }

  if (!result.ok && result.canTryStemProbe && opts.probeCleanStemPaths) {
    const candidates = collectEndorsedCleanStemCandidates(opts.record, opts.normalizePath);
    existingStemPaths = await opts.probeCleanStemPaths(candidates);
    result = recoverCleanBackOriginalPath({
      record: opts.record,
      audits,
      siblingNames,
      existingStemPaths,
      normalizePath: opts.normalizePath,
    });
  }

  if (!result.ok && result.canTrySiblings && opts.loadSiblingNames && result.directory !== null) {
    siblingNames = await opts.loadSiblingNames(result.directory);
    result = recoverCleanBackOriginalPath({
      record: opts.record,
      audits,
      siblingNames,
      existingStemPaths,
      normalizePath: opts.normalizePath,
    });
  }

  if (!result.ok) throw new Error(result.message);
  return result;
}

export function depositImagePersistPatch(
  depositPath: string,
  originalPath: string,
  meta: Record<string, unknown> = {},
): {
  back_image_deposit_path: string;
  endorsement_render_meta: Record<string, unknown>;
} {
  const cleanOriginal = assertCleanBackOriginalPath(originalPath);
  const deposit = String(depositPath ?? "").trim();
  if (!deposit || !isGeneratedBackArtifactPath(deposit)) {
    throw new Error("Deposit persist path must be a generated artifact.");
  }
  return {
    back_image_deposit_path: deposit,
    endorsement_render_meta: {
      ...meta,
      original_back_image_path: cleanOriginal,
    },
  };
}
