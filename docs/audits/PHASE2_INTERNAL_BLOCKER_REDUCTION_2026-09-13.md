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

