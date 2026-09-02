#!/usr/bin/env python3
"""Generate the AWS staging SELECT-only RLS policy set. Does not ENABLE RLS."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DUMP_DATA = Path("/tmp/dump-analysis/all_public_data.sql")
TOC = Path("/tmp/dump-analysis/toc.list")
CLASSIFICATION = ROOT / "classification" / "policies.json"
OUT_SQL = ROOT / "sql" / "12_final_select_policies.sql"
OUT_JSON = ROOT / "classification" / "final_policy_set.json"

CATALOG = {
    "zip_geocache": "true",
    "platform_announcements": "(is_active = true)",
    "check_billing_config": "(active = true)",
    "document_templates": "(is_active = true)",
    "email_templates": "(is_active = true)",
    "signature_document_presets": "true",
    "mortgage_companies": "true",
    "mortgage_desk_config": "true",
}

HOMEOWNER_EMAIL = {
    "homeowner_intro_requests",
    "homeowner_check_uploads",
}

PLATFORM_ONLY = {
    "storage_backup_log",
    "checkalt_config",
    "plaid_webhook_cursors",
    "ai_response_cache",
    "tenant_partner_code_aliases",
    "checkalt_webhook_events",
}

SPECIAL = {
    "tenants": "public.aws_can_access_tenant(id)",
    "tenant_users": "public.aws_can_access_tenant(tenant_id) OR user_id = auth.uid()",
    "user_roles": "public.aws_can_access_same_tenant_user(user_id)",
    "profiles": "public.aws_can_access_same_tenant_user(id)",
    "role_version_tracker": "public.aws_can_access_same_tenant_user(user_id)",
    "contractor_profiles": "user_id = auth.uid() OR public.aws_is_cross_tenant_reader() OR (is_directory_listed = true AND directory_opt_in = true)",
    "claims": "public.aws_can_access_claim(id)",
    "contractor_reviews": "public.aws_can_access_tenant(org_id) OR public.aws_is_cross_tenant_reader()",
    "deposit_batches": (
        "public.aws_is_cross_tenant_reader() OR EXISTS ("
        " SELECT 1 FROM public.deposit_items di"
        " JOIN public.check_intake_items ci ON ci.id = di.check_id"
        " WHERE di.batch_id = deposit_batches.id"
        "   AND public.aws_can_access_tenant(ci.tenant_id))"
    ),
    "deposit_attachments": "public.aws_can_access_deposit_item(deposit_item_id)",
    "deposit_exceptions": "public.aws_can_access_deposit_item(deposit_item_id)",
    "deposit_webhook_events": "public.aws_can_access_deposit_item(deposit_item_id)",
    "loss_draft_documents": "public.aws_can_access_loss_draft(loss_draft_id)",
    "loss_draft_releases": "public.aws_can_access_loss_draft(loss_draft_id)",
    "loss_draft_audit_log": "public.aws_can_access_loss_draft(loss_draft_id)",
    "loss_draft_mortgage_intake": "public.aws_can_access_loss_draft(loss_draft_id)",
    "signature_field_values": (
        "EXISTS (SELECT 1 FROM public.signature_fields sf "
        " WHERE sf.id = signature_field_values.field_id "
        "   AND public.aws_can_access_signature_request(sf.signature_request_id))"
    ),
    "signature_signers": "public.aws_can_access_signature_request(signature_request_id)",
    "signature_fields": "public.aws_can_access_signature_request(signature_request_id)",
    "signature_field_templates": "public.aws_is_cross_tenant_reader()",
    "tenant_partnerships": (
        "public.aws_can_access_tenant(inviter_tenant_id) "
        "OR public.aws_can_access_tenant(invitee_tenant_id)"
    ),
    "referral_events": (
        "public.aws_can_access_tenant(referrer_tenant_id) "
        "OR public.aws_can_access_tenant(referred_tenant_id)"
    ),
    "audit_logs": "user_id = auth.uid() OR public.aws_is_cross_tenant_reader()",
    "pii_reveal_logs": "user_id = auth.uid() OR public.aws_is_cross_tenant_reader()",
    "user_sessions": "user_id = auth.uid() OR public.aws_is_cross_tenant_reader()",
    "notification_preferences": "user_id = auth.uid() OR public.aws_is_cross_tenant_reader()",
    "deposit_notification_prefs": "user_id = auth.uid() OR public.aws_is_cross_tenant_reader()",
    "referrers": "user_id = auth.uid() OR public.aws_is_cross_tenant_reader()",
    "_aws_rls_probe_items": "public.aws_can_access_tenant(tenant_id)",
}


def load_columns():
    text = DUMP_DATA.read_text() if DUMP_DATA.exists() else ""
    tables = {}
    for match in re.finditer(r"COPY public\.(\w+) \((.*?)\) FROM stdin;", text):
        tables[match.group(1)] = [c.strip() for c in match.group(2).split(",")]
    return tables


def load_rls_tables():
    names = []
    for line in TOC.read_text().splitlines():
        if " ROW SECURITY public " in line:
            parts = line.split()
            idx = parts.index("SECURITY")
            names.append(parts[idx + 2])
    return names


def using_clause(table: str, cols: list[str] | None) -> tuple[str, str]:
    cols = cols or []
    if table in SPECIAL:
        return SPECIAL[table], "special"
    if table in CATALOG:
        return (
            f"{CATALOG[table]} OR public.aws_is_cross_tenant_reader()",
            "catalog_authenticated",
        )
    if table in HOMEOWNER_EMAIL:
        return (
            "public.aws_is_cross_tenant_reader() "
            "OR contractor_user_id = auth.uid() "
            "OR lower(homeowner_email) = lower(COALESCE(auth.email(), ''))",
            "homeowner_email",
        )
    if table in PLATFORM_ONLY:
        return "public.aws_is_cross_tenant_reader()", "platform_owner_only"
    if "tenant_id" in cols:
        return "public.aws_can_access_tenant(tenant_id)", "tenant_id"
    if "org_id" in cols:
        return "public.aws_can_access_tenant(org_id)", "org_id"
    if "check_intake_item_id" in cols:
        return "public.aws_can_access_check(check_intake_item_id)", "check_intake_item_id"
    if "check_id" in cols:
        return "public.aws_can_access_check(check_id)", "check_id"
    if "claim_id" in cols:
        return "public.aws_can_access_claim(claim_id)", "claim_id"
    if "loss_draft_id" in cols:
        return "public.aws_can_access_loss_draft(loss_draft_id)", "loss_draft_id"
    if "user_id" in cols:
        return "public.aws_can_access_same_tenant_user(user_id)", "user_id"
    if "batch_id" in cols and table.startswith("deposit_"):
        return (
            "public.aws_is_cross_tenant_reader() OR EXISTS ("
            " SELECT 1 FROM public.deposit_items di"
            " JOIN public.check_intake_items ci ON ci.id = di.check_id"
            f" WHERE di.batch_id = {table}.batch_id"
            "   AND public.aws_can_access_tenant(ci.tenant_id))",
            "deposit_batch_join",
        )
    return "public.aws_is_cross_tenant_reader()", "platform_owner_only_fallback"


def main():
    cols = load_columns()
    rls_tables = load_rls_tables()
    inventory = json.loads(CLASSIFICATION.read_text())
    too_broad = {
        p["table"].split(".")[-1]
        for p in inventory["policies"]
        if p.get("too_broad_global_role")
    }
    policies = []
    lines = [
        "-- AWS staging SELECT-only RLS policy set.",
        "-- DO NOT ENABLE ROW LEVEL SECURITY on restored tables in this phase.",
        "-- No INSERT/UPDATE/DELETE policies: writes stay in the API.",
        "-- Excludes original service_role/anon policies and USING(true) open writes.",
        "",
        "DO $$ BEGIN",
        "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
        "    CREATE ROLE authenticated NOLOGIN;",
        "  END IF;",
        "END $$;",
        "GRANT authenticated TO checksops;",
        "",
    ]
    for table in rls_tables:
        expr, kind = using_clause(table, cols.get(table))
        name = f"aws_select_{table}"
        remediated = table in too_broad
        policies.append(
            {
                "table": f"public.{table}",
                "policy": name,
                "command": "SELECT",
                "roles": "authenticated",
                "access_kind": kind,
                "remediated_global_admin_staff": remediated,
                "using": expr,
            }
        )
        lines.append(f'DROP POLICY IF EXISTS {name} ON public.{table};')
        lines.append(f'CREATE POLICY {name} ON public.{table}')
        lines.append("  FOR SELECT TO authenticated")
        lines.append(f"  USING ({expr});")
        lines.append("")

    # empty-policy dump tables are included in rls_tables.
    OUT_SQL.write_text("\n".join(lines) + "\n")
    kinds = {}
    for p in policies:
        kinds[p["access_kind"]] = kinds.get(p["access_kind"], 0) + 1
    OUT_JSON.write_text(
        json.dumps(
            {
                "policy_count": len(policies),
                "command": "SELECT",
                "write_policies": 0,
                "obsolete_excluded": 6,
                "server_side_open_write_excluded": 10,
                "jwt_or_open_select_rewritten": 8,
                "global_admin_staff_remediated": sum(
                    1 for p in policies if p["remediated_global_admin_staff"]
                ),
                "rls_tables_in_dump": len(rls_tables),
                "empty_policy_tables": ["payment_idempotency_keys", "plaid_webhook_cursors"],
                "access_kind_totals": kinds,
                "notes": {
                    "payment_idempotency_keys": "tenant_id scoped SELECT (safer than dump deny-all with no policies)",
                    "plaid_webhook_cursors": "platform-owner only; no tenant key; API/webhook cursor",
                },
                "policies": policies,
            },
            indent=2,
        )
        + "\n"
    )
    print("wrote", OUT_SQL, "count", len(policies))
    print("kinds", kinds)
    print("remediated tables", sum(1 for p in policies if p["remediated_global_admin_staff"]))
    missing = []
    for p in policies:
        table = p["table"].split(".")[-1]
        using = p["using"]
        have = set(cols.get(table) or [])
        for col in (
            "tenant_id",
            "org_id",
            "claim_id",
            "check_id",
            "check_intake_item_id",
            "user_id",
            "loss_draft_id",
            "deposit_item_id",
        ):
            if f"({col})" in using or f" {col}" in using:
                qualified = f"{table}.{col}" in using
                if col not in have and not qualified:
                    missing.append((table, col, using))
    if missing:
        raise SystemExit(f"USING column missing from dump COPY: {missing}")


if __name__ == "__main__":
    main()
