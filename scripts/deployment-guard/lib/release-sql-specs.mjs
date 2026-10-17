/**
 * Specs of the release 2026-10-17 SQL (SQL 90 to SQL 100) for the shared engine in
 * release-sql-state.mjs: what each pinned file creates, replaces or drops, the reviewed
 * EXECUTE ACLs, the prerequisites and predecessors, and the PostgreSQL renderings the file
 * leaves (policy expressions, view, column, constraint, index and trigger definitions as
 * pg_get_expr / pg_get_viewdef / pg_get_constraintdef / pg_get_indexdef / pg_get_triggerdef
 * print them with search_path pg_catalog, whitespace collapsed).
 *
 * Function bodies, languages, volatility, SECURITY DEFINER, result types and proconfig are
 * not repeated here: the engine derives them from the pinned file's bytes. Everything below
 * is re-derived on PostgreSQL 16 by aws/tests/release-sql90-97-executor.test.mjs and
 * release-sql98-100-executor.test.mjs (the real files applied in order, as a non-superuser
 * owner): a change to a file or a rendering fails those tests and the pins'
 * intended_replacement_sha256.
 *
 * Field reference:
 *   prerequisites      objects that must exist (the file's own prerequisite checks plus every
 *                      object it changes only when present, so the post-state is fixed)
 *   predecessors       migrations that must be in place (pin "predecessors")
 *   refuse_after       a later migration whose marker makes this one refuse (SQL 93 after SQL 96)
 *   supersedes         migrations whose objects this one replaces (SQL 96 replaces SQL 93's guard)
 *   functions          created or replaced: identity, final EXECUTE ACL (owner read as 'owner'),
 *                      revokes = ACL lines the file removes (default: PUBLIC EXECUTE)
 *   tables             created by the file: columns [name, type, not null, default, column ACL],
 *                      constraints and indexes [name, definition], non-owner table ACL
 *   added_columns      added to an existing table; column_acl: column grants on an existing column
 *   table_privileges   pinned grantees' pinned privileges on an existing table, after the file
 *   altered_relations  existing relations the file changes (must be owned by the login)
 *   tables[].may_preexist / revokes_from
 *                      CREATE TABLE IF NOT EXISTS of a table that may already exist (SQL 98's
 *                      platform_billing_destination): taken over only with the reviewed
 *                      columns, constraints and indexes, no trigger but the file's and
 *                      privileges only of the roles the file revokes from
 *   column_acl[].revokes
 *                      column grants the file revokes (SQL 100)
 *   indexes            created on an existing table: name and pg_get_indexdef (SQL 98)
 *   unique_covers      a unique index covering columns (contains, none outside within) that the
 *                      file adds only when none exists; duplicates_count names the count that
 *                      must be 0 otherwise (SQL 98)
 *   added_indexes      index names the unrelated snapshot skips (created only conditionally)
 *   definer_writes     tables a DEFINER function of the file writes under RLS (SQL 99)
 *   render             { grantors, policy_comments }: ACL grantors and policy comment hashes
 *                      in the fingerprint (SQL 100)
 *   production_noop    on production the state must already be the intended one (SQL 100);
 *                      the production tool never runs the file
 *
 * SQL 101 and later: add a spec here, its staging pin in sql-executor-auth.mjs
 * (RELEASE_2026_10_17_PENDING_SQL_PINS or a successor map) and its production pin; the
 * engine, the executor handler and the production tool are generic.
 */

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

export const RELEASE_SQL_SPECS = deepFreeze({
  sql90: {
    "key": "sql90",
    "label": "SQL 90",
    "choice": "sql90-users-only-tenant-roles",
    "production_pin_rel": "ops/deployment-guard/sql90-users-only-tenant-roles-production-apply.json",
    "script": "sql90-users-only-tenant-roles-production-apply",
    "prerequisites": [
      "public.tenant_users",
      "public.tenants",
      "public.user_roles",
      "public.recipient_tax_profiles",
      "public.aws_is_authenticated()",
      "public.aws_is_cross_tenant_reader()",
      "public.is_platform_owner()",
      "public.aws_can_access_tenant(uuid)",
      "public.aws_can_write_tenant(uuid)",
      "public.aws_can_write_check(uuid)",
      "public.aws_can_write_claim(uuid)",
      "public.check_intake_items",
      "public.claims",
      "public.identity_accounts",
      "public.profiles",
      "public.aws_can_write_same_tenant_user(uuid)",
      "public.aws_can_access_tax_profiles(uuid)",
      "role checksops",
      "role authenticated",
      "auth.uid()",
      "public.aws_is_tenant_manager_admin()",
      "public.deposit_provider_config",
      "public.deposit_provider_config_public",
      "public.aws_can_manage_mortgage_library(uuid)",
      "public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)",
      "public.tenant_email_settings",
      "public.checkalt_tenant_accounts",
      "public.contractor_profiles",
      "public.deposit_items",
      "public.deposit_batches",
      "public.homeowner_check_uploads",
      "public.referral_events",
      "public.tenant_partnerships"
    ],
    "predecessors": [
      "sql29",
      "sql30"
    ],
    "functions": [
      {
        "identity": "public.aws_is_tenant_member(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_can_write_tenant(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_can_write_check(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_can_write_claim(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_tenant_has_no_members(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_is_platform_owner_user(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_has_any_tenant_membership()",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_can_write_same_tenant_user(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_can_access_tax_profiles(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_first_invite_allowed(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_invite_create_user_identity(uuid, text, text, text)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_create_deposit_batch_for_item(uuid, text)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_is_tenant_manager_admin()",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ],
        "revokes": []
      },
      {
        "identity": "public.aws_can_manage_mortgage_library(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ],
        "revokes": []
      },
      {
        "identity": "public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      }
    ],
    "policies": [
      {
        "table": "public.tenant_users",
        "name": "aws_insert_tenant_users",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "(public.aws_is_authenticated() AND (NOT public.aws_is_platform_owner_user(user_id)) AND (public.aws_is_tenant_member(tenant_id) OR (COALESCE(public.is_platform_owner(), false) AND public.aws_first_invite_allowed(tenant_id))))"
      },
      {
        "table": "public.tenant_users",
        "name": "aws_delete_tenant_users",
        "cmd": "DELETE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND public.aws_is_tenant_member(tenant_id))",
        "with_check": null
      },
      {
        "table": "public.tenants",
        "name": "aws_write_tenants",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND public.aws_is_tenant_member(id))",
        "with_check": "(public.aws_is_authenticated() AND public.aws_is_tenant_member(id))"
      },
      {
        "table": "public.tenants",
        "name": "aws_insert_tenants",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))"
      },
      {
        "table": "public.tenant_email_settings",
        "name": "aws_write_tenant_email_settings",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND public.aws_is_tenant_member(tenant_id))",
        "with_check": "(public.aws_is_authenticated() AND public.aws_is_tenant_member(tenant_id))"
      },
      {
        "table": "public.checkalt_tenant_accounts",
        "name": "aws_write_checkalt_tenant_accounts",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))"
      },
      {
        "table": "public.profiles",
        "name": "aws_platform_owner_insert_profiles",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))"
      },
      {
        "table": "public.contractor_profiles",
        "name": "aws_platform_owner_update_contractor_profiles",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))"
      },
      {
        "table": "public.deposit_batches",
        "name": "aws_write_deposit_batches",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(EXISTS ( SELECT 1 FROM (public.deposit_items di JOIN public.check_intake_items ci ON ((ci.id = di.check_id))) WHERE ((di.batch_id = deposit_batches.id) AND public.aws_can_write_tenant(ci.tenant_id))))",
        "with_check": "(EXISTS ( SELECT 1 FROM (public.deposit_items di JOIN public.check_intake_items ci ON ((ci.id = di.check_id))) WHERE ((di.batch_id = deposit_batches.id) AND public.aws_can_write_tenant(ci.tenant_id))))"
      },
      {
        "table": "public.homeowner_check_uploads",
        "name": "aws_write_homeowner_check_uploads",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND ((contractor_user_id = auth.uid()) OR public.aws_can_write_check(converted_check_id)))",
        "with_check": "(public.aws_is_authenticated() AND ((contractor_user_id = auth.uid()) OR public.aws_can_write_check(converted_check_id)))"
      },
      {
        "table": "public.referral_events",
        "name": "aws_write_referral_events",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_can_write_tenant(referrer_tenant_id) OR public.aws_can_write_tenant(referred_tenant_id))",
        "with_check": "(public.aws_can_write_tenant(referrer_tenant_id) OR public.aws_can_write_tenant(referred_tenant_id))"
      },
      {
        "table": "public.tenant_partnerships",
        "name": "aws_write_tenant_partnerships",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id))",
        "with_check": "(public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id))"
      },
      {
        "table": "public.user_roles",
        "name": "aws_write_user_roles",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))"
      }
    ],
    "dropped_policies": [
      {
        "table": "public.tenant_users",
        "name": "aws_write_tenant_users"
      }
    ],
    "views": [
      {
        "name": "public.deposit_provider_config_public",
        "definition": "SELECT id, provider, display_name, is_active, is_stubbed, CASE WHEN public.aws_is_tenant_manager_admin() THEN capabilities ELSE NULL::jsonb END AS capabilities, created_at, updated_at FROM public.deposit_provider_config WHERE (public.aws_is_tenant_manager_admin() OR public.aws_has_any_tenant_membership());",
        "options": [
          "security_barrier=true",
          "security_invoker=false"
        ]
      }
    ],
    "altered_relations": [
      "public.tenant_users",
      "public.tenants",
      "public.user_roles",
      "public.tenant_email_settings",
      "public.checkalt_tenant_accounts",
      "public.profiles",
      "public.contractor_profiles",
      "public.deposit_batches",
      "public.homeowner_check_uploads",
      "public.referral_events",
      "public.tenant_partnerships",
      "public.deposit_provider_config_public"
    ]
  },
  sql91: {
    "key": "sql91",
    "label": "SQL 91",
    "choice": "sql91-moov-onboarding",
    "production_pin_rel": "ops/deployment-guard/sql91-moov-onboarding-production-apply.json",
    "script": "sql91-moov-onboarding-production-apply",
    "prerequisites": [
      "public.tenants",
      "public.identity_accounts",
      "public.tenant_users",
      "public.payment_provider_accounts",
      "public.payment_provider_methods",
      "public.payment_method_verifications",
      "public.payment_event_log",
      "public.payment_idempotency_keys",
      "public.aws_is_authenticated()",
      "public.is_platform_owner()",
      "public.aws_can_access_tenant(uuid)",
      "auth.uid()",
      "role checksops",
      "role authenticated"
    ],
    "predecessors": [],
    "functions": [
      {
        "identity": "public.aws_moov_onboarding_active()",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_can_submit_moov_onboarding(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_moov_onboarding_writer(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_moov_webhook_apply_active()",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      }
    ],
    "policies": [
      {
        "table": "public.moov_onboarding_profiles",
        "name": "aws_select_moov_onboarding_profiles",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_can_access_tenant(tenant_id)",
        "with_check": null
      },
      {
        "table": "public.moov_onboarding_profiles",
        "name": "aws_insert_moov_onboarding_profiles",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.moov_onboarding_profiles",
        "name": "aws_update_moov_onboarding_profiles",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_onboarding_writer(tenant_id)",
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.moov_onboarding_profiles",
        "name": "aws_webhook_select_moov_onboarding_profiles",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_webhook_apply_active()",
        "with_check": null
      },
      {
        "table": "public.moov_onboarding_profiles",
        "name": "aws_webhook_update_moov_onboarding_profiles",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_webhook_apply_active()",
        "with_check": "public.aws_moov_webhook_apply_active()"
      },
      {
        "table": "public.moov_onboarding_representatives",
        "name": "aws_select_moov_onboarding_representatives",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_can_access_tenant(tenant_id)",
        "with_check": null
      },
      {
        "table": "public.moov_onboarding_representatives",
        "name": "aws_insert_moov_onboarding_representatives",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.moov_onboarding_representatives",
        "name": "aws_update_moov_onboarding_representatives",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_onboarding_writer(tenant_id)",
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.moov_compliance_documents",
        "name": "aws_select_moov_compliance_documents",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_can_access_tenant(tenant_id)",
        "with_check": null
      },
      {
        "table": "public.moov_compliance_documents",
        "name": "aws_insert_moov_compliance_documents",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.moov_compliance_documents",
        "name": "aws_update_moov_compliance_documents",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_onboarding_writer(tenant_id)",
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.moov_onboarding_outbox",
        "name": "aws_select_moov_onboarding_outbox",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_can_access_tenant(tenant_id)",
        "with_check": null
      },
      {
        "table": "public.moov_onboarding_outbox",
        "name": "aws_insert_moov_onboarding_outbox",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.moov_onboarding_outbox",
        "name": "aws_update_moov_onboarding_outbox",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_onboarding_writer(tenant_id)",
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_provider_accounts",
        "name": "aws_onboarding_insert_payment_provider_accounts",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_provider_accounts",
        "name": "aws_onboarding_update_payment_provider_accounts",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_onboarding_writer(tenant_id)",
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_provider_accounts",
        "name": "aws_webhook_select_payment_provider_accounts",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_webhook_apply_active()",
        "with_check": null
      },
      {
        "table": "public.payment_provider_accounts",
        "name": "aws_webhook_update_payment_provider_accounts",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_webhook_apply_active()",
        "with_check": "public.aws_moov_webhook_apply_active()"
      },
      {
        "table": "public.payment_provider_methods",
        "name": "aws_onboarding_insert_payment_provider_methods",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_provider_methods",
        "name": "aws_onboarding_update_payment_provider_methods",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_onboarding_writer(tenant_id)",
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_method_verifications",
        "name": "aws_onboarding_insert_payment_method_verifications",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_method_verifications",
        "name": "aws_onboarding_update_payment_method_verifications",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_onboarding_writer(tenant_id)",
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_event_log",
        "name": "aws_onboarding_insert_payment_event_log",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_event_log",
        "name": "aws_webhook_insert_payment_event_log",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_webhook_apply_active()"
      },
      {
        "table": "public.payment_idempotency_keys",
        "name": "aws_onboarding_insert_payment_idempotency_keys",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      },
      {
        "table": "public.payment_idempotency_keys",
        "name": "aws_onboarding_update_payment_idempotency_keys",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_moov_onboarding_writer(tenant_id)",
        "with_check": "public.aws_moov_onboarding_writer(tenant_id)"
      }
    ],
    "tables": [
      {
        "name": "public.moov_onboarding_profiles",
        "rls": true,
        "forced": false,
        "columns": [
          [
            "id",
            "uuid",
            true,
            "gen_random_uuid()"
          ],
          [
            "tenant_id",
            "uuid",
            true,
            null
          ],
          [
            "environment",
            "text",
            true,
            null
          ],
          [
            "legal_name",
            "text",
            false,
            null
          ],
          [
            "dba",
            "text",
            false,
            null
          ],
          [
            "business_type",
            "text",
            false,
            null
          ],
          [
            "email",
            "text",
            false,
            null
          ],
          [
            "phone",
            "text",
            false,
            null
          ],
          [
            "website",
            "text",
            false,
            null
          ],
          [
            "description",
            "text",
            false,
            null
          ],
          [
            "address",
            "jsonb",
            true,
            "'{}'::jsonb"
          ],
          [
            "ein_ciphertext",
            "text",
            false,
            null
          ],
          [
            "ein_last4",
            "text",
            false,
            null
          ],
          [
            "ein_key_arn",
            "text",
            false,
            null
          ],
          [
            "moov_account_id",
            "text",
            false,
            null
          ],
          [
            "moov_profile_synced_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "sync_pending",
            "boolean",
            true,
            "false"
          ],
          [
            "last_error_code",
            "text",
            false,
            null
          ],
          [
            "last_webhook_event_type",
            "text",
            false,
            null
          ],
          [
            "last_webhook_event_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "submitted_by",
            "uuid",
            false,
            null
          ],
          [
            "created_at",
            "timestamp with time zone",
            true,
            "now()"
          ],
          [
            "updated_at",
            "timestamp with time zone",
            true,
            "now()"
          ]
        ],
        "constraints": [
          [
            "moov_onboarding_profiles_ein_ciphertext_check",
            "CHECK (((ein_ciphertext IS NULL) OR (ein_ciphertext ~~ 'kms:v1:%'::text)))"
          ],
          [
            "moov_onboarding_profiles_ein_last4_check",
            "CHECK (((ein_last4 IS NULL) OR (ein_last4 ~ '^[0-9]{4}$'::text)))"
          ],
          [
            "moov_onboarding_profiles_ein_pair_check",
            "CHECK (((ein_ciphertext IS NULL) = (ein_last4 IS NULL)))"
          ],
          [
            "moov_onboarding_profiles_environment_check",
            "CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text])))"
          ],
          [
            "moov_onboarding_profiles_pkey",
            "PRIMARY KEY (id)"
          ],
          [
            "moov_onboarding_profiles_submitted_by_fkey",
            "FOREIGN KEY (submitted_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL"
          ],
          [
            "moov_onboarding_profiles_tenant_env_unique",
            "UNIQUE (tenant_id, environment)"
          ],
          [
            "moov_onboarding_profiles_tenant_id_fkey",
            "FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE"
          ]
        ],
        "indexes": [
          [
            "moov_onboarding_profiles_moov_account_idx",
            "CREATE INDEX moov_onboarding_profiles_moov_account_idx ON public.moov_onboarding_profiles USING btree (environment, moov_account_id) WHERE (moov_account_id IS NOT NULL)"
          ],
          [
            "moov_onboarding_profiles_pkey",
            "CREATE UNIQUE INDEX moov_onboarding_profiles_pkey ON public.moov_onboarding_profiles USING btree (id)"
          ],
          [
            "moov_onboarding_profiles_tenant_env_unique",
            "CREATE UNIQUE INDEX moov_onboarding_profiles_tenant_env_unique ON public.moov_onboarding_profiles USING btree (tenant_id, environment)"
          ]
        ],
        "acl": [
          "authenticated INSERT",
          "authenticated SELECT",
          "authenticated UPDATE",
          "checksops INSERT",
          "checksops SELECT",
          "checksops UPDATE"
        ]
      },
      {
        "name": "public.moov_onboarding_representatives",
        "rls": true,
        "forced": false,
        "columns": [
          [
            "id",
            "uuid",
            true,
            "gen_random_uuid()"
          ],
          [
            "tenant_id",
            "uuid",
            true,
            null
          ],
          [
            "environment",
            "text",
            true,
            null
          ],
          [
            "first_name",
            "text",
            true,
            null
          ],
          [
            "last_name",
            "text",
            true,
            null
          ],
          [
            "email",
            "text",
            false,
            null
          ],
          [
            "phone",
            "text",
            false,
            null
          ],
          [
            "title",
            "text",
            false,
            null
          ],
          [
            "address",
            "jsonb",
            true,
            "'{}'::jsonb"
          ],
          [
            "is_controller",
            "boolean",
            true,
            "false"
          ],
          [
            "is_owner",
            "boolean",
            true,
            "false"
          ],
          [
            "ownership_pct",
            "numeric(5,2)",
            false,
            null
          ],
          [
            "dob_ciphertext",
            "text",
            false,
            null
          ],
          [
            "dob_year",
            "smallint",
            false,
            null
          ],
          [
            "ssn_last4",
            "text",
            false,
            null
          ],
          [
            "ssn_resubmit_required",
            "boolean",
            true,
            "false"
          ],
          [
            "moov_representative_id",
            "text",
            false,
            null
          ],
          [
            "moov_synced_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "last_error_code",
            "text",
            false,
            null
          ],
          [
            "removed_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "created_by",
            "uuid",
            false,
            null
          ],
          [
            "created_at",
            "timestamp with time zone",
            true,
            "now()"
          ],
          [
            "updated_at",
            "timestamp with time zone",
            true,
            "now()"
          ]
        ],
        "constraints": [
          [
            "moov_onboarding_representatives_created_by_fkey",
            "FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL"
          ],
          [
            "moov_onboarding_representatives_dob_ciphertext_check",
            "CHECK (((dob_ciphertext IS NULL) OR (dob_ciphertext ~~ 'kms:v1:%'::text)))"
          ],
          [
            "moov_onboarding_representatives_environment_check",
            "CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text])))"
          ],
          [
            "moov_onboarding_representatives_ownership_check",
            "CHECK (((ownership_pct IS NULL) OR ((ownership_pct >= (0)::numeric) AND (ownership_pct <= (100)::numeric))))"
          ],
          [
            "moov_onboarding_representatives_pkey",
            "PRIMARY KEY (id)"
          ],
          [
            "moov_onboarding_representatives_profile_fkey",
            "FOREIGN KEY (tenant_id, environment) REFERENCES public.moov_onboarding_profiles(tenant_id, environment) ON DELETE CASCADE"
          ],
          [
            "moov_onboarding_representatives_ssn_last4_check",
            "CHECK (((ssn_last4 IS NULL) OR (ssn_last4 ~ '^[0-9]{4}$'::text)))"
          ]
        ],
        "indexes": [
          [
            "moov_onboarding_representatives_moov_id_unique",
            "CREATE UNIQUE INDEX moov_onboarding_representatives_moov_id_unique ON public.moov_onboarding_representatives USING btree (environment, moov_representative_id) WHERE (moov_representative_id IS NOT NULL)"
          ],
          [
            "moov_onboarding_representatives_pkey",
            "CREATE UNIQUE INDEX moov_onboarding_representatives_pkey ON public.moov_onboarding_representatives USING btree (id)"
          ],
          [
            "moov_onboarding_representatives_tenant_idx",
            "CREATE INDEX moov_onboarding_representatives_tenant_idx ON public.moov_onboarding_representatives USING btree (tenant_id, environment)"
          ]
        ],
        "acl": [
          "authenticated INSERT",
          "authenticated SELECT",
          "authenticated UPDATE",
          "checksops INSERT",
          "checksops SELECT",
          "checksops UPDATE"
        ]
      },
      {
        "name": "public.moov_compliance_documents",
        "rls": true,
        "forced": false,
        "columns": [
          [
            "id",
            "uuid",
            true,
            "gen_random_uuid()"
          ],
          [
            "tenant_id",
            "uuid",
            true,
            null
          ],
          [
            "environment",
            "text",
            true,
            null
          ],
          [
            "purpose",
            "text",
            true,
            null
          ],
          [
            "representative_id",
            "uuid",
            false,
            null
          ],
          [
            "file_name",
            "text",
            true,
            null
          ],
          [
            "content_type",
            "text",
            true,
            null
          ],
          [
            "size_bytes",
            "bigint",
            true,
            null
          ],
          [
            "storage_key",
            "text",
            true,
            null
          ],
          [
            "kms_key_arn",
            "text",
            true,
            null
          ],
          [
            "final_storage_key",
            "text",
            false,
            null
          ],
          [
            "s3_version_id",
            "text",
            false,
            null
          ],
          [
            "status",
            "text",
            true,
            "'pending_upload'::text"
          ],
          [
            "sha256",
            "text",
            false,
            null
          ],
          [
            "moov_account_id",
            "text",
            false,
            null
          ],
          [
            "moov_file_id",
            "text",
            false,
            null
          ],
          [
            "moov_status",
            "text",
            false,
            null
          ],
          [
            "last_error_code",
            "text",
            false,
            null
          ],
          [
            "uploaded_by",
            "uuid",
            false,
            null
          ],
          [
            "upload_url_issued_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "uploaded_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "sent_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "created_at",
            "timestamp with time zone",
            true,
            "now()"
          ],
          [
            "updated_at",
            "timestamp with time zone",
            true,
            "now()"
          ]
        ],
        "constraints": [
          [
            "moov_compliance_documents_content_type_check",
            "CHECK ((content_type = ANY (ARRAY['application/pdf'::text, 'image/jpeg'::text, 'image/png'::text, 'text/csv'::text])))"
          ],
          [
            "moov_compliance_documents_environment_check",
            "CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text])))"
          ],
          [
            "moov_compliance_documents_final_key_check",
            "CHECK (((final_storage_key IS NULL) OR (final_storage_key = ((('files/verification-docs/final/'::text || (tenant_id)::text) || '/'::text) || (id)::text))))"
          ],
          [
            "moov_compliance_documents_pkey",
            "PRIMARY KEY (id)"
          ],
          [
            "moov_compliance_documents_purpose_check",
            "CHECK ((purpose = ANY (ARRAY['business_verification'::text, 'identity_verification'::text, 'individual_verification'::text, 'representative_verification'::text, 'w9'::text, 'bank_statement'::text, 'license'::text, 'insurance'::text, 'saas_agreement'::text, 'terms_of_service'::text, 'privacy_policy'::text])))"
          ],
          [
            "moov_compliance_documents_representative_id_fkey",
            "FOREIGN KEY (representative_id) REFERENCES public.moov_onboarding_representatives(id) ON DELETE SET NULL"
          ],
          [
            "moov_compliance_documents_size_check",
            "CHECK (((size_bytes >= 1) AND (size_bytes <= 20971520)))"
          ],
          [
            "moov_compliance_documents_status_check",
            "CHECK ((status = ANY (ARRAY['pending_upload'::text, 'stored'::text, 'sent'::text, 'rejected'::text])))"
          ],
          [
            "moov_compliance_documents_storage_key_check",
            "CHECK ((storage_key = ((('files/verification-docs/uploads/'::text || (tenant_id)::text) || '/'::text) || (id)::text)))"
          ],
          [
            "moov_compliance_documents_tenant_id_fkey",
            "FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE"
          ],
          [
            "moov_compliance_documents_uploaded_by_fkey",
            "FOREIGN KEY (uploaded_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL"
          ],
          [
            "moov_compliance_documents_version_check",
            "CHECK (((status <> ALL (ARRAY['stored'::text, 'sent'::text])) OR ((s3_version_id IS NOT NULL) AND (final_storage_key IS NOT NULL))))"
          ]
        ],
        "indexes": [
          [
            "moov_compliance_documents_moov_file_unique",
            "CREATE UNIQUE INDEX moov_compliance_documents_moov_file_unique ON public.moov_compliance_documents USING btree (environment, moov_file_id) WHERE (moov_file_id IS NOT NULL)"
          ],
          [
            "moov_compliance_documents_pkey",
            "CREATE UNIQUE INDEX moov_compliance_documents_pkey ON public.moov_compliance_documents USING btree (id)"
          ],
          [
            "moov_compliance_documents_tenant_idx",
            "CREATE INDEX moov_compliance_documents_tenant_idx ON public.moov_compliance_documents USING btree (tenant_id, environment, created_at DESC)"
          ]
        ],
        "acl": [
          "authenticated INSERT",
          "authenticated SELECT",
          "authenticated UPDATE",
          "checksops INSERT",
          "checksops SELECT",
          "checksops UPDATE"
        ]
      },
      {
        "name": "public.moov_onboarding_outbox",
        "rls": true,
        "forced": false,
        "columns": [
          [
            "id",
            "uuid",
            true,
            "gen_random_uuid()"
          ],
          [
            "tenant_id",
            "uuid",
            true,
            null
          ],
          [
            "environment",
            "text",
            true,
            null
          ],
          [
            "kind",
            "text",
            true,
            null
          ],
          [
            "subject_id",
            "uuid",
            true,
            null
          ],
          [
            "payload",
            "jsonb",
            true,
            "'{}'::jsonb"
          ],
          [
            "status",
            "text",
            true,
            "'pending'::text"
          ],
          [
            "attempts",
            "integer",
            true,
            "0"
          ],
          [
            "next_attempt_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "last_error_code",
            "text",
            false,
            null
          ],
          [
            "created_by",
            "uuid",
            false,
            null
          ],
          [
            "created_at",
            "timestamp with time zone",
            true,
            "now()"
          ],
          [
            "updated_at",
            "timestamp with time zone",
            true,
            "now()"
          ],
          [
            "completed_at",
            "timestamp with time zone",
            false,
            null
          ]
        ],
        "constraints": [
          [
            "moov_onboarding_outbox_attempts_check",
            "CHECK (((attempts >= 0) AND (attempts <= 10)))"
          ],
          [
            "moov_onboarding_outbox_created_by_fkey",
            "FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL"
          ],
          [
            "moov_onboarding_outbox_environment_check",
            "CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text])))"
          ],
          [
            "moov_onboarding_outbox_kind_check",
            "CHECK ((kind = ANY (ARRAY['onboarding_sync'::text, 'document_upload'::text])))"
          ],
          [
            "moov_onboarding_outbox_payload_no_pii",
            "CHECK ((((payload)::text !~* '\"(ssn|ssn_full|ein|tax_?id|government_?id|dob|birth_?date|account_?number|routing_?number|file_?base64)\"\\s*:'::text) AND ((payload)::text !~ '\"[0-9]{3}-?[0-9]{2}-?[0-9]{4}\"'::text)))"
          ],
          [
            "moov_onboarding_outbox_pkey",
            "PRIMARY KEY (id)"
          ],
          [
            "moov_onboarding_outbox_status_check",
            "CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'abandoned'::text, 'failed'::text])))"
          ],
          [
            "moov_onboarding_outbox_tenant_id_fkey",
            "FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE"
          ]
        ],
        "indexes": [
          [
            "moov_onboarding_outbox_one_pending",
            "CREATE UNIQUE INDEX moov_onboarding_outbox_one_pending ON public.moov_onboarding_outbox USING btree (tenant_id, environment, kind, subject_id) WHERE (status = 'pending'::text)"
          ],
          [
            "moov_onboarding_outbox_pkey",
            "CREATE UNIQUE INDEX moov_onboarding_outbox_pkey ON public.moov_onboarding_outbox USING btree (id)"
          ],
          [
            "moov_onboarding_outbox_tenant_idx",
            "CREATE INDEX moov_onboarding_outbox_tenant_idx ON public.moov_onboarding_outbox USING btree (tenant_id, environment, status)"
          ]
        ],
        "acl": [
          "authenticated INSERT",
          "authenticated SELECT",
          "authenticated UPDATE",
          "checksops INSERT",
          "checksops SELECT",
          "checksops UPDATE"
        ]
      }
    ],
    "added_columns": [
      {
        "table": "public.payment_provider_methods",
        "column": "routing_last_four",
        "type": "text",
        "notnull": false,
        "default": null,
        "acl": []
      }
    ],
    "constraints": [
      {
        "table": "public.payment_provider_methods",
        "name": "payment_provider_methods_routing_last_four_check",
        "def": "CHECK (((routing_last_four IS NULL) OR (routing_last_four ~ '^[0-9]{4}$'::text)))"
      }
    ],
    "altered_relations": [
      "public.payment_provider_accounts",
      "public.payment_provider_methods",
      "public.payment_method_verifications",
      "public.payment_event_log",
      "public.payment_idempotency_keys"
    ]
  },
  sql92: {
    "key": "sql92",
    "label": "SQL 92",
    "choice": "sql92-signature-request-check-files-link-grant",
    "production_pin_rel": "ops/deployment-guard/sql92-signature-request-check-files-link-grant-production-apply.json",
    "script": "sql92-signature-request-check-files-link-grant-production-apply",
    "prerequisites": [
      "public.check_files",
      "column public.check_files.signature_request_id",
      "role checksops",
      "role authenticated"
    ],
    "predecessors": [],
    "functions": [],
    "column_acl": [
      {
        "table": "public.check_files",
        "column": "signature_request_id",
        "acl": [
          "authenticated UPDATE",
          "checksops UPDATE"
        ]
      }
    ],
    "altered_relations": [
      "public.check_files"
    ]
  },
  sql93: {
    "key": "sql93",
    "label": "SQL 93",
    "choice": "sql93-tenant-company-info",
    "production_pin_rel": "ops/deployment-guard/sql93-tenant-company-info-production-apply.json",
    "script": "sql93-tenant-company-info-production-apply",
    "prerequisites": [
      "public.tenants",
      "public.aws_is_tenant_member(uuid)",
      "public.aws_is_authenticated()"
    ],
    "predecessors": [
      "sql90"
    ],
    "refuse_after": [
      {
        "key": "sql96",
        "object": "public.aws_platform_owner_set_tenant_pricing(uuid, jsonb)"
      }
    ],
    "functions": [
      {
        "identity": "public.aws_tenants_member_column_guard()",
        "acl": [
          "PUBLIC EXECUTE",
          "owner EXECUTE"
        ],
        "revokes": []
      }
    ],
    "dropped_policies": [
      {
        "table": "public.tenants",
        "name": "aws_member_update_tenant_branding"
      }
    ],
    "added_columns": [
      {
        "table": "public.tenants",
        "column": "company_address",
        "type": "text",
        "notnull": false,
        "default": null,
        "acl": []
      },
      {
        "table": "public.tenants",
        "column": "company_phone",
        "type": "text",
        "notnull": false,
        "default": null,
        "acl": []
      },
      {
        "table": "public.tenants",
        "column": "company_email",
        "type": "text",
        "notnull": false,
        "default": null,
        "acl": []
      },
      {
        "table": "public.tenants",
        "column": "letterhead_url",
        "type": "text",
        "notnull": false,
        "default": null,
        "acl": []
      }
    ],
    "triggers": [
      {
        "table": "public.tenants",
        "name": "aws_tenants_member_column_guard",
        "def": "CREATE TRIGGER aws_tenants_member_column_guard BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.aws_tenants_member_column_guard()"
      }
    ],
    "altered_relations": [
      "public.tenants"
    ]
  },
  sql94: {
    "key": "sql94",
    "label": "SQL 94",
    "choice": "sql94-document-library-restore",
    "production_pin_rel": "ops/deployment-guard/sql94-document-library-restore-production-apply.json",
    "script": "sql94-document-library-restore-production-apply",
    "prerequisites": [
      "public.tenant_documents",
      "public.tenant_users",
      "public.claims",
      "public.check_intake_items",
      "public.homeowner_ledger_tokens",
      "public.homeowner_ledger_events",
      "auth.uid()",
      "role checksops",
      "role authenticated",
      "column public.tenant_documents.doc_type"
    ],
    "predecessors": [
      "sql29",
      "sql90"
    ],
    "reads_library": true,
    "extra_preconditions": [
      "doc_type_check_supported",
      "no_rows_outside_sql94_rule"
    ],
    "counts": {
      "rows_outside_sql94_rule": {
        "requires": [
          "public.tenant_documents"
        ],
        "sql": "SELECT count(*)::int AS n FROM public.tenant_documents\nWHERE NOT (doc_type IS NOT NULL AND (\n  doc_type = ANY (ARRAY['w9', 'license', 'insurance', 'saas_agreement', 'terms_of_service', 'privacy_policy',\n    'library:mortgage:w-9', 'library:mortgage:contractor-license', 'library:mortgage:general-liability-insurance',\n    'library:mortgage:workers-comp-insurance', 'library:mortgage:certificate-of-insurance', 'library:mortgage:signed-contract',\n    'library:mortgage:adjuster-tpa-letter']::text[])\n  OR (doc_type ~ '^library:(template|shingle|siding|catalog|letterhead):[a-z0-9]+(-[a-z0-9]+)*$'\n      AND char_length(regexp_replace(doc_type, '^library:[a-z]+:', '')) <= 60)))"
      }
    },
    "functions": [
      {
        "identity": "public.aws_tenant_document_doc_type_ok(text)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_homeowner_share_member(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_homeowner_shared_documents_guard()",
        "acl": [
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_public_homeowner_shared_documents(text)",
        "acl": [
          "checksops EXECUTE",
          "owner EXECUTE"
        ],
        "revokes": [
          "PUBLIC EXECUTE",
          "authenticated EXECUTE"
        ]
      },
      {
        "identity": "public.aws_public_homeowner_shared_document(text, uuid)",
        "acl": [
          "checksops EXECUTE",
          "owner EXECUTE"
        ],
        "revokes": [
          "PUBLIC EXECUTE",
          "authenticated EXECUTE"
        ]
      }
    ],
    "policies": [
      {
        "table": "public.homeowner_shared_documents",
        "name": "aws_select_homeowner_shared_documents",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_homeowner_share_member(tenant_id)",
        "with_check": null
      },
      {
        "table": "public.homeowner_shared_documents",
        "name": "aws_insert_homeowner_shared_documents",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "(public.aws_homeowner_share_member(tenant_id) AND (shared_by = auth.uid()))"
      },
      {
        "table": "public.homeowner_shared_documents",
        "name": "aws_update_homeowner_shared_documents",
        "cmd": "UPDATE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "public.aws_homeowner_share_member(tenant_id)",
        "with_check": "public.aws_homeowner_share_member(tenant_id)"
      }
    ],
    "tables": [
      {
        "name": "public.homeowner_shared_documents",
        "rls": true,
        "forced": false,
        "columns": [
          [
            "id",
            "uuid",
            true,
            "gen_random_uuid()"
          ],
          [
            "tenant_id",
            "uuid",
            true,
            null
          ],
          [
            "claim_id",
            "uuid",
            true,
            null
          ],
          [
            "tenant_document_id",
            "uuid",
            true,
            null
          ],
          [
            "shared_by",
            "uuid",
            false,
            null
          ],
          [
            "shared_at",
            "timestamp with time zone",
            true,
            "now()"
          ],
          [
            "revoked_at",
            "timestamp with time zone",
            false,
            null,
            [
              "authenticated UPDATE",
              "checksops UPDATE"
            ]
          ],
          [
            "revoked_by",
            "uuid",
            false,
            null,
            [
              "authenticated UPDATE",
              "checksops UPDATE"
            ]
          ]
        ],
        "constraints": [
          [
            "homeowner_shared_documents_claim_id_fkey",
            "FOREIGN KEY (claim_id) REFERENCES public.claims(id) ON DELETE CASCADE"
          ],
          [
            "homeowner_shared_documents_pkey",
            "PRIMARY KEY (id)"
          ],
          [
            "homeowner_shared_documents_revoked_by_check",
            "CHECK (((revoked_at IS NOT NULL) OR (revoked_by IS NULL)))"
          ],
          [
            "homeowner_shared_documents_tenant_document_id_fkey",
            "FOREIGN KEY (tenant_document_id) REFERENCES public.tenant_documents(id) ON DELETE CASCADE"
          ]
        ],
        "indexes": [
          [
            "homeowner_shared_documents_active_uniq",
            "CREATE UNIQUE INDEX homeowner_shared_documents_active_uniq ON public.homeowner_shared_documents USING btree (claim_id, tenant_document_id) WHERE (revoked_at IS NULL)"
          ],
          [
            "homeowner_shared_documents_pkey",
            "CREATE UNIQUE INDEX homeowner_shared_documents_pkey ON public.homeowner_shared_documents USING btree (id)"
          ],
          [
            "homeowner_shared_documents_tenant_claim_idx",
            "CREATE INDEX homeowner_shared_documents_tenant_claim_idx ON public.homeowner_shared_documents USING btree (tenant_id, claim_id)"
          ]
        ],
        "acl": [
          "authenticated INSERT",
          "authenticated SELECT",
          "checksops INSERT",
          "checksops SELECT"
        ]
      }
    ],
    "constraints": [
      {
        "table": "public.tenant_documents",
        "name": "tenant_documents_doc_type_check",
        "def": "CHECK (public.aws_tenant_document_doc_type_ok(doc_type))"
      }
    ],
    "triggers": [
      {
        "table": "public.homeowner_shared_documents",
        "name": "homeowner_shared_documents_guard",
        "def": "CREATE TRIGGER homeowner_shared_documents_guard BEFORE INSERT OR UPDATE ON public.homeowner_shared_documents FOR EACH ROW EXECUTE FUNCTION public.aws_homeowner_shared_documents_guard()"
      }
    ],
    "altered_relations": [
      "public.tenant_documents"
    ]
  },
  sql95: {
    "key": "sql95",
    "label": "SQL 95",
    "choice": "sql95-remove-freedom-claims-bridge",
    "production_pin_rel": "ops/deployment-guard/sql95-remove-freedom-claims-bridge-production-apply.json",
    "script": "sql95-remove-freedom-claims-bridge-production-apply",
    "prerequisites": [
      "public.check_intake_items"
    ],
    "predecessors": [],
    "functions": [],
    "dropped_functions": [
      "public.notify_freedom_status_change()",
      "public.list_checks_by_freedom_claim(text, uuid)",
      "public.aws_ingest_shared_check(jsonb)",
      "public.vault_create_bridge_secret(text)",
      "public.vault_update_bridge_secret(text)"
    ],
    "dropped_triggers": [
      {
        "table": "public.check_intake_items",
        "name": "trg_notify_freedom_status_change"
      }
    ],
    "altered_relations": [
      "public.check_intake_items"
    ]
  },
  sql96: {
    "key": "sql96",
    "label": "SQL 96",
    "choice": "sql96-platform-owner-tenant-pricing",
    "production_pin_rel": "ops/deployment-guard/sql96-platform-owner-tenant-pricing-production-apply.json",
    "script": "sql96-platform-owner-tenant-pricing-production-apply",
    "prerequisites": [
      "public.tenants",
      "auth.uid()",
      "public.is_platform_owner()",
      "public.aws_is_authenticated()",
      "public.aws_is_tenant_member(uuid)",
      "public.aws_tenants_member_column_guard()",
      "public.platform_fee_schedules",
      "role checksops",
      "role authenticated"
    ],
    "predecessors": [
      "sql93"
    ],
    "refuse_after": [
      {
        "key": "sql98",
        "object": "public.aws_platform_owner_set_tenant_deposits_enabled(uuid, boolean)"
      }
    ],
    "supersedes": [
      "sql93"
    ],
    "functions": [
      {
        "identity": "public.aws_tenant_pricing_columns()",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_tenant_pricing_audit_row()",
        "acl": [
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_tenants_member_column_guard()",
        "acl": [
          "PUBLIC EXECUTE",
          "owner EXECUTE"
        ],
        "revokes": []
      },
      {
        "identity": "public.aws_platform_owner_set_tenant_pricing(uuid, jsonb)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      }
    ],
    "policies": [
      {
        "table": "public.tenant_pricing_audit",
        "name": "aws_select_tenant_pricing_audit",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": null
      },
      {
        "table": "public.platform_fee_schedules",
        "name": "aws_write_platform_fee_schedules",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))"
      }
    ],
    "tables": [
      {
        "name": "public.tenant_pricing_audit",
        "rls": true,
        "forced": false,
        "columns": [
          [
            "id",
            "uuid",
            true,
            "gen_random_uuid()"
          ],
          [
            "tenant_id",
            "uuid",
            true,
            null
          ],
          [
            "actor_id",
            "uuid",
            false,
            null
          ],
          [
            "field",
            "text",
            true,
            null
          ],
          [
            "old_value",
            "jsonb",
            false,
            null
          ],
          [
            "new_value",
            "jsonb",
            false,
            null
          ],
          [
            "created_at",
            "timestamp with time zone",
            true,
            "now()"
          ]
        ],
        "constraints": [
          [
            "tenant_pricing_audit_pkey",
            "PRIMARY KEY (id)"
          ]
        ],
        "indexes": [
          [
            "tenant_pricing_audit_pkey",
            "CREATE UNIQUE INDEX tenant_pricing_audit_pkey ON public.tenant_pricing_audit USING btree (id)"
          ],
          [
            "tenant_pricing_audit_tenant_idx",
            "CREATE INDEX tenant_pricing_audit_tenant_idx ON public.tenant_pricing_audit USING btree (tenant_id, created_at DESC)"
          ]
        ],
        "acl": [
          "authenticated SELECT",
          "checksops SELECT"
        ]
      }
    ],
    "triggers": [
      {
        "table": "public.tenants",
        "name": "aws_tenant_pricing_audit",
        "def": "CREATE TRIGGER aws_tenant_pricing_audit AFTER UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.aws_tenant_pricing_audit_row()"
      }
    ],
    "altered_relations": [
      "public.tenants",
      "public.platform_fee_schedules"
    ]
  },
  sql97: {
    "key": "sql97",
    "label": "SQL 97",
    "choice": "sql97-financial-stepup-log-server-writer",
    "production_pin_rel": "ops/deployment-guard/sql97-financial-stepup-log-server-writer-production-apply.json",
    "script": "sql97-financial-stepup-log-server-writer-production-apply",
    "prerequisites": [
      "public.financial_stepup_log",
      "column public.financial_stepup_log.metadata",
      "role checksops",
      "role authenticated"
    ],
    "predecessors": [],
    "functions": [
      {
        "identity": "public.aws_financial_stepup_log_writer_guard()",
        "acl": [
          "owner EXECUTE"
        ]
      }
    ],
    "triggers": [
      {
        "table": "public.financial_stepup_log",
        "name": "aws_financial_stepup_log_writer_guard",
        "def": "CREATE TRIGGER aws_financial_stepup_log_writer_guard BEFORE INSERT ON public.financial_stepup_log FOR EACH ROW EXECUTE FUNCTION public.aws_financial_stepup_log_writer_guard()"
      }
    ],
    "table_privileges": [
      {
        "table": "public.financial_stepup_log",
        "grantees": [
          "PUBLIC",
          "authenticated",
          "checksops"
        ],
        "privileges": [
          "INSERT"
        ],
        "intended": [
          "checksops INSERT"
        ]
      }
    ],
    "altered_relations": [
      "public.financial_stepup_log"
    ]
  },
  sql98: {
    "key": "sql98",
    "label": "SQL 98",
    "choice": "sql98-tenant-fee-collection",
    "production_pin_rel": "ops/deployment-guard/sql98-tenant-fee-collection-production-apply.json",
    "script": "sql98-tenant-fee-collection-production-apply",
    "prerequisites": [
      "public.tenants",
      "public.check_intake_items",
      "public.check_billing_events",
      "public.check_billing_config",
      "public.tenant_maintenance_payments",
      "auth.uid()",
      "public.is_platform_owner()",
      "public.aws_is_authenticated()",
      "public.aws_platform_owner_set_tenant_pricing(uuid, jsonb)",
      "public.aws_tenant_pricing_columns()",
      "public.aws_is_tenant_member(uuid)",
      "public.tenant_pricing_audit",
      "column public.tenant_maintenance_payments.billing_period",
      "column public.tenant_maintenance_payments.tenant_id",
      "column public.check_billing_events.event_type",
      "column public.check_billing_events.check_intake_item_id",
      "column public.check_billing_events.tenant_id",
      "column public.check_billing_events.unit_price_cents",
      "column public.check_billing_events.currency",
      "column public.check_billing_events.status",
      "column public.check_billing_config.price_per_check_cents",
      "column public.check_billing_config.currency",
      "column public.check_billing_config.active",
      "column public.check_billing_config.created_at",
      "column public.check_intake_items.status",
      "column public.check_intake_items.tenant_id",
      "column public.tenants.per_check_billing_enabled",
      "column public.tenants.per_check_rate_cents",
      "role checksops",
      "role authenticated"
    ],
    "predecessors": [
      "sql96"
    ],
    "supersedes": [
      "sql96"
    ],
    "extra_preconditions": [
      "no_duplicate_billing_periods",
      "check_billing_config_active_or_empty",
      "platform_billing_destination_absent_or_empty"
    ],
    "counts": {
      "platform_billing_destination_rows": {
        "requires": [
          "public.platform_billing_destination"
        ],
        "sql": "SELECT count(*)::int AS n FROM public.platform_billing_destination"
      },
      "duplicate_billing_periods": {
        "requires": [
          "public.tenant_maintenance_payments",
          "column public.tenant_maintenance_payments.billing_period"
        ],
        "sql": "SELECT count(*)::int AS n FROM (SELECT 1 FROM public.tenant_maintenance_payments\nWHERE billing_period IS NOT NULL GROUP BY tenant_id, billing_period HAVING count(*) > 1) d"
      },
      "check_billing_event_duplicates": {
        "requires": [
          "public.check_billing_events",
          "column public.check_billing_events.check_intake_item_id",
          "column public.check_billing_events.event_type"
        ],
        "sql": "SELECT count(*)::int AS n FROM (SELECT 1 FROM public.check_billing_events\nWHERE check_intake_item_id IS NOT NULL GROUP BY check_intake_item_id, event_type HAVING count(*) > 1) d"
      },
      "check_billing_config_rows": {
        "requires": [
          "public.check_billing_config"
        ],
        "sql": "SELECT count(*)::int AS n FROM public.check_billing_config"
      },
      "check_billing_config_active_rows": {
        "requires": [
          "public.check_billing_config",
          "column public.check_billing_config.active"
        ],
        "sql": "SELECT count(*)::int AS n FROM public.check_billing_config WHERE active = true"
      }
    },
    "functions": [
      {
        "identity": "public.aws_check_billing_default_price_cents()",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_check_billing_charges_when_per_check_off()",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.record_check_billing_event()",
        "acl": [
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_platform_owner_record_billing_audit(jsonb)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_platform_billing_destination_audit_row()",
        "acl": [
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_tenant_deposits_enabled(uuid)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_tenant_deposits_enabled_audit_row()",
        "acl": [
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_platform_owner_set_tenant_deposits_enabled(uuid, boolean)",
        "acl": [
          "authenticated EXECUTE",
          "checksops EXECUTE",
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_tenants_member_column_guard()",
        "acl": [
          "PUBLIC EXECUTE",
          "owner EXECUTE"
        ],
        "revokes": []
      }
    ],
    "policies": [
      {
        "table": "public.platform_billing_audit",
        "name": "aws_select_platform_billing_audit",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": null
      },
      {
        "table": "public.tenant_fee_invoice_outbox",
        "name": "aws_platform_owner_tenant_fee_invoice_outbox",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))"
      },
      {
        "table": "public.platform_billing_destination",
        "name": "aws_select_platform_billing_destination",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": null
      },
      {
        "table": "public.platform_billing_destination",
        "name": "aws_write_platform_billing_destination",
        "cmd": "ALL",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))",
        "with_check": "(public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))"
      }
    ],
    "tables": [
      {
        "name": "public.platform_billing_audit",
        "rls": true,
        "forced": false,
        "columns": [
          [
            "id",
            "uuid",
            true,
            "gen_random_uuid()"
          ],
          [
            "event",
            "text",
            true,
            null
          ],
          [
            "actor_id",
            "uuid",
            false,
            null
          ],
          [
            "tenant_id",
            "uuid",
            false,
            null
          ],
          [
            "billing_period",
            "text",
            false,
            null
          ],
          [
            "amount_cents",
            "bigint",
            false,
            null
          ],
          [
            "occurrence_id",
            "uuid",
            false,
            null
          ],
          [
            "provider_transfer_ids",
            "text[]",
            true,
            "ARRAY[]::text[]"
          ],
          [
            "outcome",
            "text",
            true,
            null
          ],
          [
            "preview_hash",
            "text",
            false,
            null
          ],
          [
            "details",
            "jsonb",
            true,
            "'{}'::jsonb"
          ],
          [
            "created_at",
            "timestamp with time zone",
            true,
            "now()"
          ]
        ],
        "constraints": [
          [
            "platform_billing_audit_event_check",
            "CHECK ((event = ANY (ARRAY['pull'::text, 'verify_debit'::text, 'destination_set'::text, 'invoice_email'::text])))"
          ],
          [
            "platform_billing_audit_pkey",
            "PRIMARY KEY (id)"
          ]
        ],
        "indexes": [
          [
            "platform_billing_audit_invoice_email_once_uidx",
            "CREATE UNIQUE INDEX platform_billing_audit_invoice_email_once_uidx ON public.platform_billing_audit USING btree (occurrence_id) WHERE ((event = 'invoice_email'::text) AND (outcome = ANY (ARRAY['sent'::text, 'sunk'::text])))"
          ],
          [
            "platform_billing_audit_pkey",
            "CREATE UNIQUE INDEX platform_billing_audit_pkey ON public.platform_billing_audit USING btree (id)"
          ],
          [
            "platform_billing_audit_tenant_idx",
            "CREATE INDEX platform_billing_audit_tenant_idx ON public.platform_billing_audit USING btree (tenant_id, created_at DESC)"
          ]
        ],
        "acl": [
          "authenticated SELECT",
          "checksops SELECT"
        ]
      },
      {
        "name": "public.tenant_fee_invoice_outbox",
        "rls": true,
        "forced": false,
        "columns": [
          [
            "occurrence_id",
            "uuid",
            true,
            null
          ],
          [
            "tenant_id",
            "uuid",
            true,
            null
          ],
          [
            "billing_period",
            "text",
            true,
            null
          ],
          [
            "status",
            "text",
            true,
            "'pending'::text"
          ],
          [
            "attempts",
            "integer",
            true,
            "0"
          ],
          [
            "last_error",
            "text",
            false,
            null
          ],
          [
            "message_id",
            "text",
            false,
            null
          ],
          [
            "created_at",
            "timestamp with time zone",
            true,
            "now()"
          ],
          [
            "updated_at",
            "timestamp with time zone",
            true,
            "now()"
          ]
        ],
        "constraints": [
          [
            "tenant_fee_invoice_outbox_pkey",
            "PRIMARY KEY (occurrence_id)"
          ],
          [
            "tenant_fee_invoice_outbox_status_check",
            "CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'sunk'::text, 'failed'::text, 'no_recipient'::text])))"
          ]
        ],
        "indexes": [
          [
            "tenant_fee_invoice_outbox_pkey",
            "CREATE UNIQUE INDEX tenant_fee_invoice_outbox_pkey ON public.tenant_fee_invoice_outbox USING btree (occurrence_id)"
          ]
        ],
        "acl": [
          "authenticated SELECT",
          "checksops INSERT",
          "checksops SELECT",
          "checksops UPDATE"
        ]
      },
      {
        "name": "public.platform_billing_destination",
        "may_preexist": true,
        "revokes_from": [
          "PUBLIC",
          "authenticated",
          "checksops"
        ],
        "rls": true,
        "forced": false,
        "columns": [
          [
            "environment",
            "text",
            true,
            null
          ],
          [
            "moov_account_id",
            "text",
            true,
            null
          ],
          [
            "moov_payment_method_id",
            "text",
            true,
            null
          ],
          [
            "label",
            "text",
            true,
            "'ChecksOps merchant'::text"
          ],
          [
            "verified_at",
            "timestamp with time zone",
            false,
            null
          ],
          [
            "created_at",
            "timestamp with time zone",
            true,
            "now()"
          ],
          [
            "updated_at",
            "timestamp with time zone",
            true,
            "now()"
          ]
        ],
        "constraints": [
          [
            "platform_billing_destination_environment_check",
            "CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text])))"
          ],
          [
            "platform_billing_destination_pkey",
            "PRIMARY KEY (environment)"
          ]
        ],
        "indexes": [
          [
            "platform_billing_destination_pkey",
            "CREATE UNIQUE INDEX platform_billing_destination_pkey ON public.platform_billing_destination USING btree (environment)"
          ]
        ],
        "acl": [
          "authenticated SELECT",
          "checksops INSERT",
          "checksops SELECT",
          "checksops UPDATE"
        ]
      }
    ],
    "added_columns": [
      {
        "table": "public.tenants",
        "column": "deposits_enabled",
        "type": "boolean",
        "notnull": true,
        "default": "true",
        "acl": []
      }
    ],
    "indexes": [
      {
        "table": "public.tenant_maintenance_payments",
        "name": "tenant_maintenance_payments_tenant_period_uidx",
        "def": "CREATE UNIQUE INDEX tenant_maintenance_payments_tenant_period_uidx ON public.tenant_maintenance_payments USING btree (tenant_id, billing_period) WHERE (billing_period IS NOT NULL)"
      }
    ],
    "unique_covers": [
      {
        "table": "public.check_billing_events",
        "name": "check_event",
        "contains": [
          "check_intake_item_id",
          "event_type"
        ],
        "within": [
          "check_intake_item_id",
          "event_type",
          "tenant_id"
        ],
        "duplicates_count": "check_billing_event_duplicates"
      }
    ],
    "added_indexes": [
      "public.check_billing_events_check_event_uidx"
    ],
    "triggers": [
      {
        "table": "public.check_intake_items",
        "name": "trg_record_check_billing_event",
        "def": "CREATE TRIGGER trg_record_check_billing_event AFTER UPDATE OF status ON public.check_intake_items FOR EACH ROW EXECUTE FUNCTION public.record_check_billing_event()"
      },
      {
        "table": "public.platform_billing_destination",
        "name": "aws_platform_billing_destination_audit",
        "def": "CREATE TRIGGER aws_platform_billing_destination_audit AFTER INSERT OR DELETE OR UPDATE ON public.platform_billing_destination FOR EACH ROW EXECUTE FUNCTION public.aws_platform_billing_destination_audit_row()"
      },
      {
        "table": "public.tenants",
        "name": "aws_tenant_deposits_enabled_audit",
        "def": "CREATE TRIGGER aws_tenant_deposits_enabled_audit AFTER UPDATE OF deposits_enabled ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.aws_tenant_deposits_enabled_audit_row()"
      }
    ],
    "altered_relations": [
      "public.tenants",
      "public.check_intake_items",
      "public.check_billing_events",
      "public.tenant_maintenance_payments"
    ]
  },
  sql99: {
    "key": "sql99",
    "label": "SQL 99",
    "choice": "sql99-mortgage-desk-completion-messages",
    "production_pin_rel": "ops/deployment-guard/sql99-mortgage-desk-completion-messages-production-apply.json",
    "script": "sql99-mortgage-desk-completion-messages-production-apply",
    "prerequisites": [
      "public.aws_is_tenant_member(uuid)",
      "auth.uid()",
      "public.check_messages",
      "public.mortgage_handling_requests",
      "column public.check_messages.check_id",
      "column public.check_messages.sender_id",
      "column public.check_messages.body",
      "column public.check_messages.is_deleted",
      "column public.check_messages.created_at",
      "column public.mortgage_handling_requests.id",
      "column public.mortgage_handling_requests.status",
      "column public.mortgage_handling_requests.check_intake_item_id",
      "column public.mortgage_handling_requests.assigned_employee_id",
      "column public.mortgage_handling_requests.mortgage_company",
      "column public.mortgage_handling_requests.mortgage_servicer",
      "column public.mortgage_handling_requests.work_notes"
    ],
    "predecessors": [
      "sql90"
    ],
    "functions": [
      {
        "identity": "public.aws_mortgage_desk_appended_note(text, text)",
        "acl": [
          "owner EXECUTE"
        ]
      },
      {
        "identity": "public.aws_mortgage_desk_completion_messages()",
        "acl": [
          "owner EXECUTE"
        ]
      }
    ],
    "triggers": [
      {
        "table": "public.mortgage_handling_requests",
        "name": "tr_mortgage_desk_completion_messages",
        "def": "CREATE TRIGGER tr_mortgage_desk_completion_messages AFTER UPDATE ON public.mortgage_handling_requests FOR EACH ROW WHEN (((old.status IS DISTINCT FROM 'completed'::text) AND (new.status = 'completed'::text) AND (new.check_intake_item_id IS NOT NULL) AND (new.assigned_employee_id IS NOT NULL))) EXECUTE FUNCTION public.aws_mortgage_desk_completion_messages()"
      }
    ],
    "definer_writes": [
      "public.check_messages"
    ],
    "altered_relations": [
      "public.mortgage_handling_requests"
    ]
  },
  sql100: {
    "key": "sql100",
    "label": "SQL 100",
    "choice": "sql100-mortgage-desk-live-access",
    "production_pin_rel": "ops/deployment-guard/sql100-mortgage-desk-live-access-production-apply.json",
    "script": "sql100-mortgage-desk-live-access-production-apply",
    "production_noop": true,
    "render": {
      "grantors": true,
      "policy_comments": true
    },
    "prerequisites": [
      "public.mortgage_handling_requests",
      "type public.app_role",
      "public.has_role(uuid, public.app_role)",
      "public.aws_is_authenticated()",
      "public.aws_is_cross_tenant_reader()",
      "public.aws_can_access_tenant(uuid)",
      "public.aws_can_write_tenant(uuid)",
      "auth.uid()",
      "public.mortgage_agent_accounts",
      "column public.mortgage_agent_accounts.application_user_id",
      "column public.mortgage_agent_accounts.status",
      "column public.mortgage_handling_requests.tenant_id",
      "column public.mortgage_handling_requests.status",
      "column public.mortgage_handling_requests.assigned_employee_id",
      "column public.mortgage_handling_requests.accepted_at",
      "column public.mortgage_handling_requests.cancelled_at",
      "column public.mortgage_handling_requests.claim_number",
      "column public.mortgage_handling_requests.completed_at",
      "column public.mortgage_handling_requests.homeowner_email",
      "column public.mortgage_handling_requests.homeowner_name",
      "column public.mortgage_handling_requests.homeowner_phone",
      "column public.mortgage_handling_requests.insurance_company",
      "column public.mortgage_handling_requests.loan_number",
      "column public.mortgage_handling_requests.mortgage_company",
      "column public.mortgage_handling_requests.mortgage_servicer",
      "column public.mortgage_handling_requests.note",
      "column public.mortgage_handling_requests.property_address",
      "column public.mortgage_handling_requests.updated_at",
      "column public.mortgage_handling_requests.work_notes",
      "role checksops",
      "role authenticated"
    ],
    "predecessors": [
      "sql90"
    ],
    "functions": [
      {
        "identity": "public.aws_is_mortgage_ops_agent()",
        "acl": [
          "PUBLIC EXECUTE grantor=owner",
          "owner EXECUTE grantor=owner"
        ],
        "revokes": []
      },
      {
        "identity": "public.aws_mortgage_agent_queue_visible(text, uuid)",
        "acl": [
          "PUBLIC EXECUTE grantor=owner",
          "owner EXECUTE grantor=owner"
        ],
        "revokes": []
      },
      {
        "identity": "public.aws_is_active_mortgage_agent(uuid)",
        "acl": [
          "PUBLIC EXECUTE grantor=owner",
          "owner EXECUTE grantor=owner"
        ],
        "revokes": []
      }
    ],
    "policies": [
      {
        "table": "public.mortgage_handling_requests",
        "name": "aws_select_mortgage_handling_requests",
        "cmd": "SELECT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id) OR public.aws_mortgage_agent_queue_visible(status, assigned_employee_id))",
        "with_check": null
      },
      {
        "table": "public.mortgage_handling_requests",
        "name": "aws_select_mortgage_ops_agent_queue",
        "cmd": "SELECT",
        "roles": [
          "authenticated",
          "checksops"
        ],
        "permissive": true,
        "qual": "public.aws_is_mortgage_ops_agent()",
        "with_check": null
      },
      {
        "table": "public.mortgage_handling_requests",
        "name": "aws_update_mortgage_ops_accept_complete",
        "cmd": "UPDATE",
        "roles": [
          "authenticated",
          "checksops"
        ],
        "permissive": true,
        "qual": "(public.aws_is_mortgage_ops_agent() AND (((status = 'requested'::text) AND (assigned_employee_id IS NULL)) OR (assigned_employee_id = auth.uid())))",
        "with_check": "(public.aws_is_mortgage_ops_agent() AND (assigned_employee_id = auth.uid()) AND (status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'cancelled'::text])) AND (((status = 'in_progress'::text) AND (accepted_at IS NOT NULL)) OR (status = ANY (ARRAY['completed'::text, 'cancelled'::text]))))"
      },
      {
        "table": "public.mortgage_handling_requests",
        "name": "aws_insert_mortgage_handling_requests",
        "cmd": "INSERT",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": null,
        "with_check": "(public.aws_is_cross_tenant_reader() OR (public.aws_can_write_tenant(tenant_id) AND (status = 'requested'::text) AND (assigned_employee_id IS NULL)))"
      },
      {
        "table": "public.mortgage_handling_requests",
        "name": "aws_delete_mortgage_handling_requests",
        "cmd": "DELETE",
        "roles": [
          "authenticated"
        ],
        "permissive": true,
        "qual": "(public.aws_is_cross_tenant_reader() OR public.aws_can_write_tenant(tenant_id))",
        "with_check": null
      }
    ],
    "dropped_policies": [
      {
        "table": "public.mortgage_handling_requests",
        "name": "aws_write_mortgage_handling_requests"
      }
    ],
    "column_acl": [
      {
        "table": "public.mortgage_handling_requests",
        "column": "accepted_at",
        "acl": [
          "authenticated UPDATE grantor=owner",
          "checksops UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "assigned_employee_id",
        "acl": [
          "authenticated UPDATE grantor=owner",
          "checksops UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "cancelled_at",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "claim_number",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "completed_at",
        "acl": [
          "authenticated UPDATE grantor=owner",
          "checksops UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "homeowner_email",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "homeowner_name",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "homeowner_phone",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "insurance_company",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "loan_number",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "mortgage_company",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "mortgage_servicer",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "note",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "property_address",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "status",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "updated_at",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      },
      {
        "table": "public.mortgage_handling_requests",
        "column": "work_notes",
        "acl": [
          "checksops UPDATE grantor=owner"
        ],
        "revokes": [
          "authenticated UPDATE grantor=owner"
        ]
      }
    ],
    "table_privileges": [
      {
        "table": "public.mortgage_handling_requests",
        "grantees": [
          "authenticated",
          "checksops"
        ],
        "privileges": [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER"
        ],
        "intended": [
          "checksops DELETE grantor=owner",
          "checksops INSERT grantor=owner",
          "checksops SELECT grantor=owner"
        ]
      }
    ],
    "altered_relations": [
      "public.mortgage_handling_requests"
    ],
    "whole_tables": [
      {
        "table": "public.mortgage_handling_requests",
        "rls": true,
        "forced": false
      }
    ]
  },
});
