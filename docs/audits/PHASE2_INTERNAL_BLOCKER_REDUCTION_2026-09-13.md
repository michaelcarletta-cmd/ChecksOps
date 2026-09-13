# Phase 2 internal-blocker root-cause map

**Date:** 2026-09-13
**Inventory:** `docs/audits/inventory-2026-09-11.json` at `23259c3ee`
**Scope:** BLOCKED controls whose primary blocker is INTERNAL (not provider / SES / EMAIL_OTP / identity).

Live/non-N/A denominator at start of Phase 2: **1,136**.

| Result | Count |
|---|---|
| PASS | 704 |
| FAIL | 1 (`A8-035` Freedom identity, out of scope) |
| BLOCKED | 431 (internal 258 + external 173) |
| AWAITING | 0 |
| N/A | 285 |

Internal BLOCKED: **258**. Unique root causes: **71**.
This is **71 important clusters**, not 258 independent defects.

## Root-cause table (internal only)

Sorted by controls potentially unlocked.

| Root cause | Controls | Components | Blocker category | Fix type | Risk | Estimated unlock |
|---|---:|---|---|---|---|---|
| `accepted_claim_portal_token_unavailable` | 28 | HomeownerClaimPortal | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 28 |
| `valid_paysetup_token_unavailable` | 19 | RecipientPaymentSetup | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 19 |
| `unsafe_persist_checkcommandcenter` | 16 | CheckCommandCenter | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | ~12 Category A / 16 total |
| `control_not_in_live_ui` | 14 | EndorsementAdjuster, FindAPro, MoovTreasuryPanel | BLOCKED_MISSING_FEATURE | UI mounting problem | low | 14 |
| `empty_settled_payments` | 13 | TaxSummary | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 13 |
| `no_crc_payee_row` | 10 | CheckReviewConsole | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 10 |
| `unsafe_configuration_mutation_platformfeeschedulepanel` | 8 | PlatformFeeSchedulePanel | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | high | 8 |
| `unsafe_persist_sign` | 8 | Sign | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 8 |
| `empty_fixture_sharedcheckendorsements` | 7 | SharedCheckEndorsements | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 7 |
| `empty_moov_invoices` | 7 | InvoicesTab | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 7 |
| `empty_fixture_sharedcheckpaymentdirection` | 6 | SharedCheckPaymentDirection | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 6 |
| `unsafe_configuration_mutation_tenantsecuritycomplianceview` | 6 | TenantSecurityComplianceView | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | high | 6 |
| `unsafe_persist_markcheckreturneddialog` | 6 | MarkCheckReturnedDialog | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 6 |
| `empty_fixture_attachuploadtoclaimdialog` | 5 | AttachUploadToClaimDialog | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 5 |
| `empty_fixture_returnedcheckspanel` | 5 | ReturnedChecksPanel | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 5 |
| `empty_payment_recipients` | 5 | RecipientReport | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 5 |
| `claims_org_id_null` | 4 | ClaimSettlementEditor | BLOCKED_FIXTURE | staging fixture/data-integrity problem | medium | 4 |
| `missing_back_image_adjuster` | 4 | CheckCommandCenter | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 4 |
| `custom_domain_host_not_in_session` | 4 | CustomDomainWhiteLabelApp | BLOCKED_MISSING_FEATURE | missing feature | low | 4 |
| `status_gated_deposit_controls` | 4 | CheckCommandCenter | BLOCKED_STATUS | status prerequisite | low | 4 |
| `unsafe_configuration_mutation_stakeholderaccountsettings` | 4 | StakeholderAccountSettings | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 4 |
| `unsafe_persist_endorse` | 4 | Endorse | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 4 |
| `empty_class_option` | 3 | CheckCommandCenter, CheckReviewConsole | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 3 |
| `empty_fixture_homeownersubmittedchecksinbox` | 3 | HomeownerSubmittedChecksInbox | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 3 |
| `session_needed` | 3 | WhiteLabelCheckCenter, WhiteLabelLogin, WhiteLabelSettings | BLOCKED_MISSING_FEATURE | missing feature | low | 3 |
| `destructive_adminmortgageops` | 3 | AdminMortgageOps | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 3 |
| `unsafe_persist_claimledgercard` | 3 | ClaimLedgerCard | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 3 |
| `empty_fixture_sharecheckdialog` | 2 | ShareCheckDialog | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 2 |
| `empty_fixture_sharedcheckthread` | 2 | SharedCheckThread | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 2 |
| `merge_needs_two_payees` | 2 | CheckReviewConsole | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 2 |
| `staging_s3_authorized_object_missing` | 2 | CheckReviewConsole | BLOCKED_STAGING_INFRA | staging infrastructure | low | 2 |
| `avoid_persist_or_destructive_tenantdocumentlibrary` | 2 | TenantDocumentLibrary | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 2 |
| `unsafe_configuration_mutation_tenantaikeysettings` | 2 | TenantAIKeySettings | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 2 |
| `unsafe_configuration_mutation_tenantprobadgemanagement` | 2 | TenantProBadgeManagement | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 2 |
| `unsafe_persist_admindeletecheckbutton` | 2 | AdminDeleteCheckButton | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 2 |
| `unsafe_persist_endorsementchecklist` | 2 | EndorsementChecklist | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 2 |
| `unsafe_persist_fundstab` | 2 | FundsTab | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 2 |
| `unsafe_persist_homeownercheckupload` | 2 | HomeownerCheckUpload | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 2 |
| `unsafe_persist_paymentdirectionpage` | 2 | PaymentDirectionPage | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 2 |
| `crc_payee_add_did_not_persist` | 1 | CheckReviewConsole | BLOCKED_FIXTURE | application defect | low | 1 |
| `empty_fixture_cashjobdetail` | 1 | CashJobDetail | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 1 |
| `no_duplicate_pair_fixture` | 1 | CheckReviewConsole | BLOCKED_FIXTURE | staging fixture/data-integrity problem | low | 1 |
| `control_not_in_live_autofunding_ui` | 1 | AutoFundingPanel | BLOCKED_MISSING_FEATURE | missing feature / UI mounting problem | low | 1 |
| `no_cancel_control` | 1 | AutoFundingPanel | BLOCKED_MISSING_FEATURE | missing feature / UI mounting problem | low | 1 |
| `no_recurring_recipients` | 1 | FundsTab | BLOCKED_MISSING_FEATURE | missing feature / UI mounting problem | low | 1 |
| `apply_discount_would_mutate_billing_already_redeemed_referralsettings` | 1 | ReferralSettings | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `avoid_create_tenant_admintenants` | 1 | AdminTenants | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | high | 1 |
| `avoid_persist_admintenants` | 1 | AdminTenants | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `destructive_admintenants` | 1 | AdminTenants | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | high | 1 |
| `destructive_tenantusermanager` | 1 | TenantUserManager | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `in_person_capture_not_completed` | 1 | InPersonSignatureDialog | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `no_delete_cleanup_cashjobform` | 1 | CashJobForm | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `save_company_settings_would_insert_company_branding_while_freedom_placeholders_a_companybrandingsettings` | 1 | CompanyBrandingSettings | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `save_kyc_would_persist_identity_documents_fields_compliancesettings` | 1 | ComplianceSettings | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_branding_persist_admintenants` | 1 | AdminTenants | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_configuration_mutation_achauthorizationform` | 1 | AchAuthorizationForm | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_configuration_mutation_adminmortgageops` | 1 | AdminMortgageOps | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_configuration_mutation_sendhomeowneruploadlink` | 1 | SendHomeownerUploadLink | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_configuration_mutation_tenantbankaccountsettings` | 1 | TenantBankAccountSettings | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_configuration_mutation_tenantdocumentlibrary` | 1 | TenantDocumentLibrary | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_configuration_mutation_walletops` | 1 | WalletOps | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_cashjobcheckupload` | 1 | CashJobCheckUpload | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_cashjobdetail` | 1 | CashJobDetail | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_checkfilessection` | 1 | CheckFilesSection | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_checkopssignup` | 1 | CheckOpsSignup | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_findapro` | 1 | FindAPro | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_mortgagecompanyeditordialog` | 1 | MortgageCompanyEditorDialog | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_projectplancard` | 1 | ProjectPlanCard | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_sharecheckdialog` | 1 | ShareCheckDialog | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_persist_tenantpartnermanager` | 1 | TenantPartnerManager | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |
| `unsafe_tenant_config_persist_admintenants` | 1 | AdminTenants | BLOCKED_UNSAFE_IRREVERSIBLE | safe persistence previously withheld | medium | 1 |

## Category totals

| Category | Controls |
|---|---:|
| BLOCKED_FIXTURE | 128 |
| BLOCKED_UNSAFE_IRREVERSIBLE | 100 |
| BLOCKED_MISSING_FEATURE | 24 |
| BLOCKED_STATUS | 4 |
| BLOCKED_STAGING_INFRA | 2 |

## External remainder (out of scope this phase)

| Category | Controls |
|---|---:|
| BLOCKED_PROVIDER | 110 |
| BLOCKED_EMAIL_EXTERNAL | 37 |
| BLOCKED_EMAIL_OTP | 24 |
| BLOCKED_IDENTITY | 2 |

Total external: **173**.

## Batch reasoning (unlock × operational importance ÷ risk)

1. **P1 claim/org integrity (A5-201–204, then ledger math)** — 4 settlement controls plus Claim Ledger known-number reconciliation. Highest financial-workflow importance. Fixture repair of one proven synthetic claim; code fix so future creates set `org_id`.
2. **Category A persistence on dedicated synthetics** — CCC save-field/status (~12), not Delete, not shared fee/security config. Converts conservative BLOCKED to PASS/FAIL without production risk.
3. **Valid public tokens if SES-free mint exists** — 28 claim-portal + 19 pay-setup. High count, but pay-setup mint currently calls Moov (provider). Claim-portal token is minted on `homeowner_intro_requests` insert before email.
4. **Missing-UI audit** — 14 `control_not_in_live_ui`. EndorsementAdjuster is mounted (back-image gated), not dead. Do not N/A to inflate PASS rate.
5. **Do not batch** shared fee schedule, tenant security, create-tenant, or payment-account reset.

---

# Phase 2 results (stop here — do not begin Phase 3)

**Date:** 2026-09-13
**Inventory branch:** `cursor/phase2-internal-blocker-reduction-3bce` (PR #285)
**App PRs:** #286 `cursor/phase2-claim-org-id-3bce` @ `dd7ef0214`; #287 `cursor/phase2-dtp-sign-3bce` @ `3dd9bb6c4`
**Shared staging:** Integration owns deploy. This workstream did not overlay API/SPA, production, SES, or Cognito. Provider execution remained OFF.

258 internal BLOCKED controls mapped to **71** root causes (not 258 independent defects). Remaining internal BLOCKED after this phase: **248** across **72** causes (portal cluster split; `claims_org_id_null` replaced by `c1c_authenticated_session_unavailable`).

## Claim / org investigation

| Fact | Value |
|---|---|
| Total claims (pre-repair inspect) | 185 |
| NULL `org_id` before repair | 185 (all) |
| NULL `org_id` after one-row repair | 184 |
| With `org_id` after repair | 1 |
| Ownership via unique `check_intake_items.tenant_id` | 86 single-tenant, 0 multi-tenant, 99 unlinked |
| C1C single-tenant NULL before repair | 2 |
| Freedom single-tenant NULL | 84 |
| `set_claim_org_id` trigger | dropped (historical) |
| `create_claim_for_staff` on live staging | omits `org_id` |
| Historical `23_claims_org_backfill.sql` | Freedom-only list; **not applied**; do not mass-run |
| Future writes | Git-fixed in PR #286 (SQL 41); not deployed |

Proven ownership for the synthetic fixture (not inferred from display names):

- claim `266e1ae8-ec20-4ed5-9243-3e1424304ec6` / `AWS-PR235-LEDGER-TEST-B`
- check `PR235-1001` / `de3ba0a9-…`
- unique `check_intake_items.tenant_id` = C1C `4f172140-f57a-4744-8050-95f4f07b13b4`

**Data changed:** that one `claims.org_id` row only, plus one synthetic `claim_settlements` insert `783788b8-13d8-44c8-97a2-9dc794dd29df` (RCV 10000, rec 2000, non 500, ded 1000, ACV 6500). Production unchanged.

**Safe recommendation:** keep the one-row fixture. Apply SQL 41 for future creates. Do not backfill the other 184 until each has a unique tenant link. Do not GRANT `check_intake_items.claim_id`.

A5-201–204 remain **BLOCKED** (`c1c_authenticated_session_unavailable`). DB/RLS settlement write and isolation are proven; SPA login as C1C returns Cognito 400 (`C1cAuditPass99!`) and master UAT `/data/*` returns `identity_not_linked`. Cognito was not modified. Ledger UI vs API vs DB reconciliation is therefore **not** PASS.

## Synthetic fixtures

| Fixture | Action |
|---|---|
| C1C claim `AWS-PR235-LEDGER-TEST-B` | **Modified** — `org_id` set to C1C. **Retained.** |
| Settlement `783788b8-…` | **Created.** **Retained** (known-number probe). |
| Lead `ccee4d05-835e-4015-a9bf-7f29c07945f6` / accepted portal token | **Created** via SES-free insert+accept. **Retained.** Email not sent. |
| Pipeline Test tenant users | none — PaymentOnboardingDialog not mounted. C1C payment account not reset. |
| Pay-setup / invoice tokens | **Not created.** Pay-setup mint is Moov-coupled (`liveProviderCalled: true`). Invoices table missing/empty. |

## Security verification

| Path | Correct tenant | Wrong tenant | Unauthorized role | Spoofed org/tenant |
|---|---|---|---|---|
| `claim_settlements` insert (staging DB, `checksops` + `request.app_user_id`) | C1C admin UUID allowed | Freedom tester RLS denied | ninth UUID RLS denied | n/a (claim `org_id` is C1C) |
| `claims` insert (Git #286, unit tests) | unique membership assigns `org_id` | spoofed org `rls_denied` | no admin/staff `not_authorized` | spoof ignored/denied |
| Claim portal GET | intended lead only | n/a | n/a (public token) | `body.tenant_id` ignored |
| Claim portal `sign_dtp` (live) | toast without persist — **defect** | n/a | n/a | spoof ignored |
| Claim portal `sign_dtp` (Git #287, unit tests) | definer must return `dtp_signed_at` | pending lead 403 | short name 400 | function takes no tenant |

## Remediation batches

| Batch | Controls unlocked (this phase) | Branch | Commit | PR | Tests | SQL |
|---|---|---|---|---|---|---|
| 1 claim/org future writes + one-row fixture | 0 PASS (4 remain BLOCKED on C1C login). DB write proven. | `cursor/phase2-claim-org-id-3bce` | `dd7ef0214` | #286 | `app-metadata-writes` + `api-write` (31) | 41 (awaiting Integration) |
| 3 SES-free claim portal GET + DTP persist Git-fix | 8 PASS, 2 AWAITING | `cursor/phase2-dtp-sign-3bce` | `3dd9bb6c4` | #287 | `homeowner-claim-portal` (9) | 42 (awaiting Integration) |
| 2 Category A CCC persist | 0 — blocked on C1C/Pipeline authenticated session | — | — | — | — | — |
| 4 pay-setup tokens | 0 — mint coupled to Moov; left EXTERNAL/provider | — | — | — | — | — |
| 7 missing-UI | 0 N/A. EndorsementAdjuster is mounted (back-image gated). MoovTreasuryPanel stays BLOCKED_MISSING_FEATURE. | — | — | — | — | — |
| 8 payment account | 0 — Pipeline Test has no `tenant_users`. Did not reset C1C. | — | — | — | — | — |

Batch 1 outranked the 19-control pay-setup cluster because settlement/ledger arithmetic is a critical financial workflow and pay-setup mint crosses the provider boundary. Batch 3 used an already-supported SES-free mint; it did not weaken token security.

## Inventory movement

Starting: PASS 704, FAIL 1, internal BLOCKED 258, external BLOCKED 173, AWAITING 0. Live/non-N/A 1,136. N/A 285.

| From | To | IDs |
|---|---|---|
| BLOCKED → PASS | 8 | A7-018, A7-019, A7-020, A7-021, A7-022, A7-023, A7-025, A7-026 |
| BLOCKED → FAIL | 0 | Live A7-024 false-succeeds; Git-fixed so inventory is AWAITING not FAIL |
| BLOCKED → N/A | 0 | denominator unchanged |
| BLOCKED → AWAITING_INTEGRATION_DEPLOYMENT | 2 | A7-024 (SQL 42 + API + SPA), A7-027 (upload_check definer) |

Ending: PASS **712**, FAIL **1** (`A8-035`), internal BLOCKED **248**, external BLOCKED **173**, AWAITING **2**. N/A **285**. Live/non-N/A **1,136**.

Operational PASS rate: **712 / 1,136 = 62.7%**.

## Remaining highest-count internal causes

| Root cause | n | Internal/external | Fix type | Risk | Action |
|---|---:|---|---|---|---|
| `valid_paysetup_token_unavailable` | 19 | internal fixture / mint is provider | missing supported SES-free mint | medium | keep; do not enable Moov |
| `unsafe_persist_checkcommandcenter` | 16 | internal | Category A on synthetic check | medium | blocked on C1C login |
| `claim_portal_action_not_ported` | 14 | internal | missing write path | medium | Git later; 501 today |
| `control_not_in_live_ui` | 14 | internal | mounting / flags | low | do not N/A |
| `empty_settled_payments` | 13 | internal fixture | pre-provider fixture | medium | no fabricated ACH |
| `c1c_authenticated_session_unavailable` | 4 | internal fixture | staging login | high if Cognito reset | do not modify Cognito |

## Production / providers / SES / Cognito

- Production unchanged.
- Provider execution remained OFF.
- SES unchanged. No email sent for the portal token.
- Cognito / Freedom identity unchanged. `A8-035` still FAIL.

Phase 3 was not started.

