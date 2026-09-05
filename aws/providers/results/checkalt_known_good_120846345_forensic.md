# Forensic: CheckAlt Accepted `120846345` vs AWS #130 Architecture A

**STOP FOR REVIEW** — no merge of #125 or #130 — no CheckAlt resubmit — production/provider/financial flags remain OFF.

Read-only forensic comparison using provider portal confirmation plus existing Lovable/Supabase historical rows and PR #130 offline Architecture A measurements. **Transaction `120846345` was not resubmitted. No customer/check images are included.**

## 1. ChecksOps / Lovable mapping

| Field | Value |
|---|---|
| CheckAlt transaction ID | `120846345` |
| Portal status / date / amount | Accepted / 2026-08-31 / **$3,802.10** |
| `checkalt_deposits.id` | `e630c449-48b3-4b92-8585-8a24421c600c` |
| Deposit fingerprint (`sha256(id)[:16]`) | `ed9b7609164ba6f0` |
| `check_intake_item_id` | `76ead31d-25ec-436c-b1f4-1e86dc05fc42` |
| Tenant | Freedom (`2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`) |
| DB status | `submitted` |
| `amount` / cents | `3802.10` / `380210` |
| `submitted_at` / `approved_at` | `2026-08-31T19:16:17.117Z` |

Portal amount and date match the ChecksOps deposit row.

## 2. Membership in PR #130 offline 8/8 sample

**Yes — this is the first of the eight successful pairs.**

| Metric | Result |
|---|---|
| Fingerprint | `ed9b7609164ba6f0` |
| Front decision | `reuse_cache` |
| Back decision | `browser_reencode` |
| Front AWS A identical | **true** |
| Back AWS A identical | **true** |
| Pair pass | **true** |

## 3. Exact image preparation path (accepted submit)

Architecture **A** (production Lovable success path):

1. Browser `prepareCheckAltDeposit` (1600px target, ≥1300 already-good floor, 450KB budget, quality 0.80→0.62→0.50→0.38; cache sibling `.deposit2.jpg`).
2. `checkalt-submit-deposit` downloads those **stored prepared** bytes and Base64-encodes them — **no second JPEG encode** when prepared paths are present.
3. Client `frontImage` / `rearImage` are not part of the Lovable submit body schema (AWS #130 also ignores client image bytes).

### Front (submitted object)

| | Source (not submitted) | Submitted prepared (`.deposit2.jpg`) |
|---|---|---|
| Decision | — | **`reuse_cache`** |
| alreadyGood | false | — |
| Dims / orientation | 3923×1953 / EXIF 1 / landscape | **1600×796** / 1 / landscape |
| JPEG | yes | yes (`ffd8ff`) |
| Bytes | 2,173,886 | **245,945** |
| SHA-256 | `3eb80f1f…b34395` | **`e25199a6…eb6826`** |
| Path | fingerprint `6ec36a09e5e7e952` only | sibling `.deposit2.jpg` of that path |

### Rear (submitted object)

| | Source (endorsed; not submitted as-is) | Submitted prepared (`.deposit2.jpg`) |
|---|---|---|
| Decision | — | **`browser_reencode`** (1200px fails ≥1300 rule; no upscale) |
| alreadyGood | false | — |
| Dims / orientation | 1200×583 / EXIF 1 / landscape | **1200×583** / 1 / landscape |
| JPEG | yes | yes (`ffd8ff`) |
| Bytes | 191,798 | **109,522** |
| SHA-256 | `a372eb0f…c95237` | **`272ce111…699feb`** |
| Path | fingerprint `6afaa2d561222660` only | sibling `.deposit2.jpg` of that path |

Endorsed deposit JPEG present: **yes**. Full storage paths and image pixels withheld.

## 4. Non-sensitive `/fincapture/deposit/process` characteristics

Exact Lovable + PR #130 body keys:

`fiKey`, `ssoKey`, `depositAccountNumber`, `captureDateTime`, `userAmount`, `frontImage`, `rearImage`, `performRiskAssessment`

| Characteristic | Known-good value |
|---|---|
| Method / path | `POST /fincapture/deposit/process` |
| `userAmount` | `380210` (integer cents) |
| `performRiskAssessment` | `true` |
| Images | Raw Base64 of prepared JPEGs; **no** `data:` prefix; **no** double-encoding |
| Combined prepared bytes / b64 chars | 355,467 / 473,960 (under 1.6M budget) |
| Optional Postman depositor name/email fields | Omitted |
| Secrets | `fiKey` / `ssoKey` / account number redacted |

## 5. Would AWS #130 generate the same image bytes and materially equivalent request?

**Yes — explicitly:**

AWS #130 Architecture A (`imagePipeline: browser_prepare_aws_base64`) downloads the same allowlisted prepared storage objects and Base64-encodes them only. For fingerprint `ed9b7609164ba6f0` (this deposit), offline parity recorded **`frontAwsAIdentical: true`** and **`backAwsAIdentical: true`**.

Therefore AWS #130 **reproduces this known-good transaction’s processing/request path**: same prepared JPEG bytes → same Base64 → same process body keys/semantics (`userAmount` cents, `performRiskAssessment: true`, no depositor extras). Credentials/host differ by environment; this historical accept was production CheckAlt.

No live resubmit was performed.

## 6. Measurable differences vs rejected synthetic VOID UAT

| Dimension | Known-good `120846345` | Rejected synthetic VOID UAT |
|---|---|---|
| Outcome | Accepted | CheckAlt **500** / AWS wrapper **502** |
| Image content | Real photo front + endorsed rear | Synthetic VOID / geometric JPEG |
| CheckAlt env | Production (portal Accepted) | UAT host + UAT FI |
| Amount | `$3802.10` / `380210` | `$0.01` / `1` |
| Front prepared | 1600×796 / **245,945 B** | #130: 1600×700 / 60,162 B; #125 improved: 1600×733 / 179,129 B |
| Back prepared | 1200×583 / **109,522 B** | #130: 1400×650 / 54,414 B; #125 improved: 1600×733 / 150,243 B |
| Prep decision | front `reuse_cache`; back `browser_reencode` | already-good pass-through on synthetics |
| Pipeline code path | Architecture A Base64-only | **Same** Architecture A (#130) |
| Process body keys | 8 Lovable keys | **Same** builder |

**Pipeline gap:** none remaining for this known-good path. Synthetic rejection is not explained by a second AWS encode or divergent process keys.

## 7. Verdict / stop

- Known-good `120846345` ↔ ChecksOps deposit `e630c449-48b3-4b92-8585-8a24421c600c` / check `76ead31d-25ec-436c-b1f4-1e86dc05fc42`.
- It **is** one of the #130 successful 8/8 offline pairs (first; `ed9b7609164ba6f0`).
- **AWS #130 reproduces this known-good processing/request path** (byte-identical prepared images under Architecture A; materially equivalent process body).
- Do **not** make speculative IQA code changes merely to satisfy synthetic UAT.
- Do **not** merge #125 or #130; do **not** submit another CheckAlt deposit until reviewed.
- Production provider/financial flags remain OFF.

Evidence: `aws/providers/results/checkalt_known_good_120846345_forensic.json`, prior `checkalt_pr130_*`, PR #130 offline artifact.
