/**
 * Canonical Supabase Storage bucket names.
 *
 * Check images (front, back, endorsed SVG composites) ALWAYS live in
 * `claim-files`. There is no `check-images` bucket — referencing it returns
 * a silent null from `createSignedUrl`, which used to cause check images to
 * mysteriously fail to load in the Deposit Operations view.
 *
 * Always import these constants instead of hardcoding bucket strings so a
 * typo or stale name can't reintroduce that bug.
 */
export const CHECK_IMAGES_BUCKET = "claim-files";
export const DEPOSIT_ATTACHMENTS_BUCKET = "deposit-attachments";
