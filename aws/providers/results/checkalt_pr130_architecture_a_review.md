# CheckAlt PR #130 — Architecture A evidence review

**Source agent:** `bc-27f549f5-ddd1-4582-9986-f09f951d3a4a`  
**PR:** [#130](https://github.com/michaelcarletta-cmd/ChecksOps/pull/130) (`cursor/checkalt-lovable-parity-3a4a`)  
**This extraction did not call CheckAlt and did not merge.**

## 1. Offline 8/8 summary

42 Lovable submitted deposits with refs+pairs on staging copy; sampled 8/8 complete pairs. Architecture `A_browser_prepare_aws_base64`.

| Fingerprint | Front decision | Back decision | AWS A identical |
| --- | --- | --- | --- |
| `ed9b7609164ba6f0` | reuse_cache 1600x796 JPEG 245945B | browser_reencode 1200x583 JPEG 109522B | true |
| `4bcb3d264efc3761` | reuse_cache 1600x693 JPEG 206035B | browser_reencode 1200x551 JPEG 106910B | true |
| `fb857c9554122263` | reuse_cache 1520x1140 JPEG 352943B | browser_reencode 1200x900 JPEG 256125B | true |
| `93373325944ab505` | reuse_cache 1600x697 JPEG 208345B | browser_reencode 1200x510 JPEG 85106B | true |
| `5f39120fca044d54` | browser_reencode 945x428 JPEG 55762B | browser_reencode 1200x568 JPEG 87476B | true |
| `fd033ae138320250` | browser_reencode 945x428 JPEG 55762B | browser_reencode 1200x568 JPEG 87476B | true |
| `9a5f035ae41dedb2` | reuse_cache 1600x1200 JPEG 397578B | browser_reencode 1200x900 JPEG 204539B | true |
| `02ee71d2dcf100a3` | reuse_cache | passthrough_original | true |

**Byte-identical confirmation:** AWS A Base64 of the Lovable-decided stored object is byte-identical to those stored prepared bytes for all 8 pairs. jpeg-js server re-encode previously diverged (245945 vs 273457 front on the first pair).  
Offline CheckAlt HTTP: **False**. Production modified: **False**.

## 2. Synthetic UAT submit

- `imagePipeline`: `browser_prepare_aws_base64`
- Front 1600×700 / 60162B; back 1400×650 / 54414B (already-good pass-through; injected client image ignored=True)
- CheckAlt API **500**; AWS wrapper/Lambda **502**; accepted **False**
- liveProviderCalled **True**
- Production CheckAlt deposits written **0**; historical resubmit **False**; productionExecution **False**
- Sanitized CheckAlt keys: ['details', 'error', 'message', 'status', 'timestamp']; reference=None; deposit_id=5b9f5c69-4da2-4cc4-84ca-9d560808165c
- stopBecauseIqa **True** (no poll/history/second submit)

## 3. Remaining differences (successful Lovable vs rejected synthetic)

1. Image content: real Lovable endorsed check photos vs synthetic VOID non-negotiable JPEGs
2. Acceptance: offline Architecture A byte-identity pass vs CheckAlt 500 / AWS wrapper 502 on synthetic
3. Cause separation: AWS re-encode defect fixed; remaining failure is CheckAlt IQA/acceptance of synthetic VOID image, not a second AWS JPEG encode
4. Follow-ons not run without acceptance: poll / idempotency / reconciliation

Final scorecard quote: 'AWS migration re-encode defect is fixed by architecture A. Remaining CheckAlt 500 on this synthetic VOID JPEG is vendor IQA/acceptance of non-negotiable test images, not a second AWS encoder pass.'

## 4. Production flags confirmed OFF

Confirmed: **True**  
Flags: `{"AWS_CHECKALT_ENABLED": false, "AWS_PROVIDER_EXECUTION_ENABLED": false, "AWS_FINANCIAL_PERMISSIONS_ACTIVATED": false}`  
UAT flags: `{"AWS_CHECKALT_ENABLED": "false", "AWS_PROVIDER_EXECUTION_ENABLED": "false", "AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED": "true"}`  
Staging health: ok; productionSupabaseChanged false.

Compact JSON: `/opt/cursor/artifacts/checkalt_pr130_evidence_summary.json`
