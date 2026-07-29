import { supabase } from "@/integrations/supabase/client";
import imageCompression from "browser-image-compression";
import { CHECK_IMAGES_BUCKET } from "@/lib/storageBuckets";

const PER_IMAGE_BYTES_BUDGET = 450_000;
const TARGET_MAX_DIM = 1200;

const isRasterPath = (path: string | null | undefined) =>
  !!path && /\.(jpe?g|png|webp)(\?|$)/i.test(path);

const toDepositPath = (path: string) =>
  /\.(jpe?g|png|webp|svg)$/i.test(path)
    ? path.replace(/\.(jpe?g|png|webp|svg)$/i, ".deposit.jpg")
    : `${path}.deposit.jpg`;

async function downloadBlob(path: string) {
  const { data, error } = await supabase.storage.from(CHECK_IMAGES_BUCKET).download(path);
  if (error || !data) throw new Error(error?.message || `Could not download ${path}`);
  return data;
}

async function cachedPreparedPath(path: string) {
  const preparedPath = toDepositPath(path);
  const { data } = await supabase.storage.from(CHECK_IMAGES_BUCKET).download(preparedPath);
  if (data && data.size > 0 && data.size <= PER_IMAGE_BYTES_BUDGET) return preparedPath;
  return null;
}

async function compressForDeposit(blob: Blob, side: "front" | "back") {
  const file = new File([blob], `${side}.jpg`, {
    type: blob.type || "image/jpeg",
    lastModified: Date.now(),
  });

  let compressed = await imageCompression(file, {
    maxSizeMB: 0.42,
    maxWidthOrHeight: TARGET_MAX_DIM,
    useWebWorker: true,
    initialQuality: 0.68,
    fileType: "image/jpeg",
  });

  if (compressed.size > PER_IMAGE_BYTES_BUDGET) {
    compressed = await imageCompression(new File([compressed], `${side}.jpg`, { type: "image/jpeg" }), {
      maxSizeMB: 0.34,
      maxWidthOrHeight: 1000,
      useWebWorker: true,
      initialQuality: 0.55,
      fileType: "image/jpeg",
    });
  }

  if (compressed.size > PER_IMAGE_BYTES_BUDGET) {
    throw new Error(`${side} image is still too large after browser compression`);
  }

  return compressed;
}

async function prepareRasterInBrowser(path: string, side: "front" | "back") {
  const cached = await cachedPreparedPath(path);
  if (cached) return cached;

  const source = await downloadBlob(path);
  const isJpeg = /\.jpe?g(\?|$)/i.test(path) || /jpeg/i.test(source.type);
  if (isJpeg && source.size > 0 && source.size <= PER_IMAGE_BYTES_BUDGET) return path;

  const compressed = await compressForDeposit(source, side);
  const preparedPath = toDepositPath(path);
  const { error } = await supabase.storage.from(CHECK_IMAGES_BUCKET).upload(
    preparedPath,
    compressed,
    { upsert: true, contentType: "image/jpeg" },
  );
  if (error) throw new Error(`${side} prepared image upload failed: ${error.message}`);
  return preparedPath;
}

/**
 * Pre-normalize a check's front + back images via dedicated edge functions
 * BEFORE calling checkalt-submit-deposit. Each side runs in its own edge
 * invocation, so oversized (5MB+) legacy images never trip the deposit
 * worker's CPU limit. Once prepared, the result is cached in storage and
 * reused on retries.
 *
 * Returns the two prepared storage paths to pass through to submit. Safe to
 * call repeatedly — the edge function reuses the cached deposit-ready variant
 * whenever it already exists in storage.
 *
 * If preparation fails, callers should still be able to submit (the submit
 * function keeps its legacy inline-normalize path as a safety net), so we
 * return nulls rather than throwing.
 */
export async function prepareCheckAltDeposit(checkIntakeItemId: string): Promise<{
  deposit_front_path: string | null;
  deposit_back_path: string | null;
}> {
  const { data: check, error: checkErr } = await supabase
    .from("check_intake_items")
    .select("front_image_path, back_image_path, back_image_deposit_path")
    .eq("id", checkIntakeItemId)
    .maybeSingle();

  if (!checkErr && check) {
    const row = check as {
      front_image_path: string | null;
      back_image_path: string | null;
      back_image_deposit_path: string | null;
    };

    const frontSource = isRasterPath(row.front_image_path) ? row.front_image_path : null;
    const backSource = isRasterPath(row.back_image_deposit_path)
      ? row.back_image_deposit_path
      : isRasterPath(row.back_image_path)
        ? row.back_image_path
        : null;

    if (!backSource && row.back_image_path) {
      throw new Error(
        "Back image needs an approved deposit JPEG before submission. Open Adjust Endorsement, generate the deposit image, and approve it before depositing.",
      );
    }

    try {
      const [deposit_front_path, deposit_back_path] = await Promise.all([
        frontSource ? prepareRasterInBrowser(frontSource, "front") : Promise.resolve(null),
        backSource ? prepareRasterInBrowser(backSource, "back") : Promise.resolve(null),
      ]);

      if (!deposit_front_path && row.front_image_path) {
        throw new Error("Front image could not be prepared for deposit");
      }

      return { deposit_front_path, deposit_back_path };
    } catch (error) {
      console.warn("[prepareCheckAltDeposit] browser preparation failed:", error);
      if (frontSource) {
        throw new Error(
          "Front check image is too large to prepare safely. Reupload a smaller JPEG image and try again.",
        );
      }
    }
  }

  const invokeSide = async (side: "front" | "back") => {
    const { data, error } = await supabase.functions.invoke("checkalt-prepare-image", {
      body: { check_intake_item_id: checkIntakeItemId, side },
    });
    if (error) {
      throw new Error(`${side} image could not be prepared for deposit. Please reupload a smaller JPEG image and try again.`);
    }
    return ((data as { prepared_path?: string | null })?.prepared_path ?? null) as string | null;
  };

  const [deposit_front_path, deposit_back_path] = await Promise.all([
    invokeSide("front"),
    invokeSide("back"),
  ]);

  return { deposit_front_path, deposit_back_path };
}
