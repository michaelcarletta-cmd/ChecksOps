#!/usr/bin/env bash
# Assemble a deployable Lambda zip from HEAD implementation modules.
# Does not deploy, invoke providers, or read Secrets Manager.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${ROOT}/../../.." && pwd)"
API="${REPO}/aws/functions/api"
PACK="${ROOT}/pack"
DIST="${ROOT}/dist"
ZIP_NAME="checksops-ocr-azure-validation-504e.zip"

MODULES=(
  azure-check-ocr.mjs
  check-ocr-provider.mjs
  ocr-normalize-azure.mjs
  textract-check-ocr.mjs
  ocr-parse.mjs
)

if [[ ! -f "${ROOT}/src/index.mjs" ]]; then
  echo "missing ${ROOT}/src/index.mjs" >&2
  exit 1
fi

for name in "${MODULES[@]}"; do
  if [[ ! -f "${API}/${name}" ]]; then
    echo "missing implementation module ${API}/${name}" >&2
    exit 1
  fi
done

rm -rf "${PACK}"
mkdir -p "${PACK}" "${DIST}"

cp "${ROOT}/src/index.mjs" "${PACK}/index.mjs"
cp "${ROOT}/package.json" "${PACK}/package.json"

for name in "${MODULES[@]}"; do
  cp "${API}/${name}" "${PACK}/${name}"
  src_hash="$(sha256sum "${API}/${name}" | awk '{print $1}')"
  pack_hash="$(sha256sum "${PACK}/${name}" | awk '{print $1}')"
  if [[ "${src_hash}" != "${pack_hash}" ]]; then
    echo "pack hash mismatch for ${name}" >&2
    exit 1
  fi
done

# Packaged parser must be the live API module, not the isolated Textract tester copy path.
if ! cmp -s "${API}/ocr-parse.mjs" "${PACK}/ocr-parse.mjs"; then
  echo "packaged ocr-parse.mjs is not aws/functions/api/ocr-parse.mjs" >&2
  exit 1
fi

if grep -R -nE 'sk-[A-Za-z0-9]{10,}|api_key["'\'']\s*:\s*["'\''][^" '\'']+' "${PACK}" --include='*.mjs' --include='*.json' >/dev/null; then
  echo "refusing pack: possible embedded secret material" >&2
  exit 1
fi

(
  cd "${PACK}"
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev
  else
    npm install --omit=dev --no-fund --no-audit
  fi
)

rm -f "${DIST}/${ZIP_NAME}"
(
  cd "${PACK}"
  zip -qr "${DIST}/${ZIP_NAME}" .
)

sha256sum "${DIST}/${ZIP_NAME}" | tee "${DIST}/${ZIP_NAME}.sha256"
echo "packed ${DIST}/${ZIP_NAME}"
