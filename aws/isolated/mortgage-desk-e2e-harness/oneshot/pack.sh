#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${ROOT}/../../../.." && pwd)"
PACK="${ROOT}/pack"
DIST="${ROOT}/dist"
ZIP_NAME="checksops-staging-mde2e-identity-oneshot.zip"
CA_SRC="${REPO}/aws/functions/api/rds-global-bundle.pem"

if [[ ! -f "${ROOT}/index.mjs" ]]; then
  echo "missing ${ROOT}/index.mjs" >&2
  exit 1
fi
if [[ ! -f "${CA_SRC}" ]]; then
  echo "missing RDS CA ${CA_SRC}" >&2
  exit 1
fi

rm -rf "${PACK}"
mkdir -p "${PACK}" "${DIST}"
cp "${ROOT}/package.json" "${PACK}/package.json"
cp "${ROOT}/index.mjs" "${PACK}/index.mjs"
cp "${CA_SRC}" "${PACK}/rds-global-bundle.pem"

if grep -R -nE 'sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH )?PRIVATE KEY|aws_secret_access_key[[:space:]]*[:=]' "${PACK}" --include='*.mjs' --include='*.json' >/dev/null; then
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
