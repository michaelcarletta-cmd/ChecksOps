#!/usr/bin/env bash
# Deploy ONLY moov-recipient-session to production nbcqwpysqgyxrrbgtmkw.
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

echo "Deploying moov-recipient-session to ${PRODUCTION_PROJECT_REF} with --no-verify-jwt"
supabase functions deploy moov-recipient-session \
  --project-ref "$PRODUCTION_PROJECT_REF" \
  --no-verify-jwt \
  --use-api \
  --yes

echo "=== functions list (names only) ==="
supabase functions list --project-ref "$PRODUCTION_PROJECT_REF" | awk 'NR==1 || /moov-recipient-session/'
