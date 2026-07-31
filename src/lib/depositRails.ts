/**
 * Deposit rail visibility.
 *
 * CheckAlt (FinCapture RDC) is temporarily hidden from the product while the
 * platform payment provider contract is being finalised. Nothing is removed:
 * the backend functions, tables, webhooks and in-flight deposits all keep
 * running exactly as before — this flag only controls whether CheckAlt
 * surfaces are rendered. Flip it back to `true` to restore the UI.
 */
export const SHOW_CHECKALT = true;
