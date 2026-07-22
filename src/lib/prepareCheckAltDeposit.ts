import { supabase } from "@/integrations/supabase/client";

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
  const invokeSide = async (side: "front" | "back") => {
    const { data, error } = await supabase.functions.invoke("checkalt-prepare-image", {
      body: { check_intake_item_id: checkIntakeItemId, side },
    });
    if (error) {
      console.warn(`[prepareCheckAltDeposit] ${side} prepare failed:`, error);
      return null;
    }
    return ((data as { prepared_path?: string | null })?.prepared_path ?? null) as string | null;
  };

  const [deposit_front_path, deposit_back_path] = await Promise.all([
    invokeSide("front"),
    invokeSide("back"),
  ]);

  return { deposit_front_path, deposit_back_path };
}
