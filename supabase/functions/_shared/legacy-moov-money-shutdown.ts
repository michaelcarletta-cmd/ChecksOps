/**
 * Fail-closed hold for legacy Lovable/Supabase Moov money writers.
 * Historical function bodies stay in git; these stubs must not POST transfers.
 */

export const LEGACY_MOOV_MONEY_DISABLED_ERROR = 'legacy_moov_money_path_disabled';

export const LEGACY_MOOV_MONEY_DISABLED_MESSAGE =
  'Legacy Supabase/Lovable Moov money writers are held. Use the AWS production writers for wallet.fund / wallet.disburse. No transfer POST.';

export const legacyMoovMoneyCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-checksops-internal',
};

export function legacyMoovMoneyShutdownResponse(req: { method?: string }): {
  status: number;
  headers: Record<string, string>;
  body: string;
  providerHttp: false;
  transferPosted: false;
} {
  if (String(req?.method || '').toUpperCase() === 'OPTIONS') {
    return {
      status: 200,
      headers: { ...legacyMoovMoneyCorsHeaders },
      body: 'ok',
      providerHttp: false,
      transferPosted: false,
    };
  }
  return {
    status: 403,
    headers: {
      ...legacyMoovMoneyCorsHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      error: LEGACY_MOOV_MONEY_DISABLED_ERROR,
      message: LEGACY_MOOV_MONEY_DISABLED_MESSAGE,
      provider_http: false,
      transfer_posted: false,
    }),
    providerHttp: false,
    transferPosted: false,
  };
}
