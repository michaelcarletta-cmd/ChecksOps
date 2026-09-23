import { supabase } from "@/integrations/aws/client";
import { CHECK_IMAGES_BUCKET } from "@/lib/storageBuckets";
import {
  CHECKALT_IMAGE_ERROR,
  evaluateCheckAltImageCompliance,
  isCheckAltArtifactPath,
  measureBlob,
  normalizeBlobToCheckAltCanvas,
  toCheckAltPath,
} from "@/lib/checkaltImageCompliance";

const isRasterPath = (path: string | null | undefined) =>
  !!path && /\.(jpe?g|png|webp)$/i.test(path);

async function downloadBlob(path: string) {
  const { data, error } = await supabase.storage.from(CHECK_IMAGES_BUCKET).download(path);
  if (error || !data) throw new Error(error?.message || `Could not download ${path}`);
  return data;
}

async function reuseIfCompliant(path: string | null) {
  if (!path || !isCheckAltArtifactPath(path)) return null;
  try {
    const blob = await downloadBlob(path);
    const info = await measureBlob(blob);
    const side = path.includes("back") || path.includes("endorsed") ? "rear" : "front";
    const report = evaluateCheckAltImageCompliance(
      { ...info, jpeg: true },
      side,
    );
    if (report.pass) return path;
  } catch {
    return null;
  }
  return null;
}

async function writeCheckAltArtifact(sourcePath: string, blob: Blob) {
  const preparedPath = toCheckAltPath(sourcePath);
  if (!preparedPath) throw new Error("Could not derive CheckAlt image path");
  const { error } = await supabase.storage.from(CHECK_IMAGES_BUCKET).upload(
    preparedPath,
    blob,
    { upsert: true, contentType: "image/jpeg" },
  );
  if (error) throw new Error(`CheckAlt image upload failed: ${error.message}`);
  return preparedPath;
}

async function prepareRasterToCheckAlt(path: string, side: "front" | "rear", force = false) {
  if (!force) {
    const existing = await reuseIfCompliant(toCheckAltPath(path));
    if (existing) return existing;
  }

  const source = await downloadBlob(path);
  const prepared = await normalizeBlobToCheckAltCanvas(source);
  if (!prepared.ok) {
    throw new Error(`${side} ${(prepared as { message?: string }).message ?? "image normalization failed"}`);
  }
  return writeCheckAltArtifact(path, prepared.blob);
}

/**
 * Build official 1920x1080 CheckAlt artifacts for front + endorsed rear.
 * Does not modify the original claim images. AWS submit validates the artifacts.
 */
export async function prepareCheckAltDeposit(
  checkIntakeItemId: string,
  options: { forceFront?: boolean; forceRear?: boolean } = {},
): Promise<{
  deposit_front_path: string;
  deposit_back_path: string;
}> {
  const { data: check, error: checkErr } = await supabase
    .from("check_intake_items")
    .select("front_image_path, back_image_path, back_image_deposit_path")
    .eq("id", checkIntakeItemId)
    .maybeSingle();

  if (checkErr || !check) {
    throw new Error("Check not found for CheckAlt image preparation");
  }

  const row = check as {
    front_image_path: string | null;
    back_image_path: string | null;
    back_image_deposit_path: string | null;
  };

  const frontSource = isRasterPath(row.front_image_path) ? row.front_image_path : null;
  const backSource = isRasterPath(row.back_image_deposit_path)
    ? row.back_image_deposit_path
    : null;

  if (!frontSource) {
    throw new Error(`${CHECKALT_IMAGE_ERROR}: front_missing`);
  }
  if (!backSource) {
    throw new Error(
      `${CHECKALT_IMAGE_ERROR}: rear_missing. Generate the endorsed deposit image before depositing.`,
    );
  }

  const [deposit_front_path, deposit_back_path] = await Promise.all([
    prepareRasterToCheckAlt(frontSource, "front", options.forceFront === true),
    prepareRasterToCheckAlt(backSource, "rear", options.forceRear === true),
  ]);

  if (!isCheckAltArtifactPath(deposit_front_path) || !isCheckAltArtifactPath(deposit_back_path)) {
    throw new Error(`${CHECKALT_IMAGE_ERROR}: preparation produced a non-official artifact`);
  }

  return { deposit_front_path, deposit_back_path };
}
