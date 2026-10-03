#!/usr/bin/env bash
# Deploy ONLY the four #204 recipient Edge Functions to production.
# Usage: SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/m62f-deploy-recipient-edge.sh
set -euo pipefail

PRODUCTION_PROJECT_REF="${PRODUCTION_PROJECT_REF:-nbcqwpysqgyxrrbgtmkw}"
FORBIDDEN_REFS="sqyyvpaymashtdwjjmku xxrdgcmfssdfvtvbefgk"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "SUPABASE_ACCESS_TOKEN is required (management PAT, not publishable/service-role)." >&2
  exit 1
fi

if [ "$PRODUCTION_PROJECT_REF" != "nbcqwpysqgyxrrbgtmkw" ]; then
  echo "Refusing to deploy to $PRODUCTION_PROJECT_REF" >&2
  exit 1
fi
for bad in $FORBIDDEN_REFS; do
  if [ "$PRODUCTION_PROJECT_REF" = "$bad" ]; then
    echo "Refusing forbidden project ref $bad" >&2
    exit 1
  fi
done

unset SUPABASE_PROJECT_ID || true
export SUPABASE_ACCESS_TOKEN

FUNCTIONS=(
  moov-recipient-session
  moov-recipient-kyc-update
  moov-recipient-tos-accept
  moov-recipient-bank-verify
)

echo "Deploying ${FUNCTIONS[*]} to ${PRODUCTION_PROJECT_REF} with --no-verify-jwt"
for fn in "${FUNCTIONS[@]}"; do
  echo "=== deploy $fn ==="
  supabase functions deploy "$fn" \
    --project-ref "$PRODUCTION_PROJECT_REF" \
    --no-verify-jwt \
    --use-api \
    --yes
done

echo "=== functions list ==="
supabase functions list --project-ref "$PRODUCTION_PROJECT_REF"
