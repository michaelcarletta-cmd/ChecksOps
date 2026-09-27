#!/usr/bin/env bash
# Assemble a deployable Lambda zip. Does not deploy or write to ChecksOps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${ROOT}/../../.." && pwd)"
PACK="${ROOT}/pack"
DIST="${ROOT}/dist"
ZIP_NAME="checksops-staging-mortgage-desk-e2e-harness.zip"
CA_SRC="${REPO}/aws/functions/api/rds-global-bundle.pem"

if [[ ! -f "${ROOT}/src/index.mjs" ]]; then
  echo "missing ${ROOT}/src/index.mjs" >&2
  exit 1
fi
if [[ ! -f "${CA_SRC}" ]]; then
  echo "missing RDS CA ${CA_SRC}" >&2
  exit 1
fi

rm -rf "${PACK}"
mkdir -p "${PACK}" "${DIST}"

cp "${ROOT}/package.json" "${PACK}/package.json"
cp "${ROOT}/src/"*.mjs "${PACK}/"
cp "${CA_SRC}" "${PACK}/rds-global-bundle.pem"

if grep -R -nE 'sk-[A-Za-z0-9]{10,}|checksops_admin|PROVIDER_SECRETS' "${PACK}" --include='*.mjs' --include='*.json' >/dev/null; then
  echo "refusing pack: forbidden secret material" >&2
  exit 1
fi

(
  cd "${PACK}"
  npm install --omit=dev --no-fund --no-audit
)

rm -f "${DIST}/${ZIP_NAME}"
(
  cd "${PACK}"
  zip -qr "${DIST}/${ZIP_NAME}" .
)

sha256sum "${DIST}/${ZIP_NAME}" | tee "${DIST}/${ZIP_NAME}.sha256"
echo "packed ${DIST}/${ZIP_NAME}"
