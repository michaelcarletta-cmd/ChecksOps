/**
 * Legacy embedded VOID JPEG fixtures removed.
 * Live UAT deposits build synthetic check rasters and run them through
 * `prepareSyntheticUatDepositImages` / `normalizeToBudget` in
 * `parity/checkalt-image.mjs` — the same constants as production
 * `checkalt-prepare-image`. Source rasters are UAT-only / non-negotiable
 * and include readable amount + MICR-style bands (not customer data).
 */
export {};
