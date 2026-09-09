/**
 * Fail-closed shutdown for the legacy Lovable CheckAlt money path.
 * Must not import checkalt.ts, read CHECKALT_* secrets, or open HTTP.
 */

export const LEGACY_CHECKALT_MONEY_DISABLED_ERROR = "legacy_checkalt_money_path_disabled";

export const LEGACY_CHECKALT_MONEY_DISABLED_MESSAGE =
  "Legacy CheckAlt money movement is shut down. Use the AWS controlled path.";

export const legacyCheckAltMoneyCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function legacyCheckAltMoneyShutdownResponse(req: { method?: string }): {
  status: number;
  headers: Record<string, string>;
  body: string;
  authenticatedToCheckAlt: false;
  providerHttp: false;
} {
  if (String(req?.method || "").toUpperCase() === "OPTIONS") {
    return {
      status: 200,
      headers: { ...legacyCheckAltMoneyCorsHeaders },
      body: "ok",
      authenticatedToCheckAlt: false,
      providerHttp: false,
    };
  }
  return {
    status: 403,
    headers: {
      ...legacyCheckAltMoneyCorsHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      error: LEGACY_CHECKALT_MONEY_DISABLED_ERROR,
      message: LEGACY_CHECKALT_MONEY_DISABLED_MESSAGE,
      authenticated_to_checkalt: false,
      provider_http: false,
    }),
    authenticatedToCheckAlt: false,
    providerHttp: false,
  };
}
