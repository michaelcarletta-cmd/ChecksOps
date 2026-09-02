#!/usr/bin/env python3
"""Generate remaining AWS staging write policies. Does not ENABLE RLS."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DUMP_DATA = Path("/tmp/dump-analysis/all_public_data.sql")
WRITE_PATHS = ROOT / "classification" / "write_paths.json"
CLAIMS = ROOT / "classification" / "claims_ownership.json"
OUT_WRITE = ROOT / "sql" / "24_complete_write_policies.sql"
OUT_BACKFILL = ROOT / "sql" / "23_claims_org_backfill.sql"
OUT_FK = ROOT / "sql" / "25_fk_retarget.sql"
OUT_JSON = ROOT / "classification" / "complete_write_policies.json"
FK_PLAN = ROOT / "sql" / "07_fk_retarget_plan.sql"

FREEDOM = "2eff5f1a-929d-4ce3-9a8b-cd96b98df42a"

OWNER_ONLY = (
    "public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader()"
)


def load_columns():
    text = DUMP_DATA.read_text()
    tables = {}
    for match in re.finditer(r"COPY public\.(\w+) \((.*?)\) FROM stdin;", text):
        tables[match.group(1)] = [c.strip() for c in match.group(2).split(",")]
    return tables


def write_clause(table: str, cols: list[str]) -> tuple[str, str]:
    special = {
        "deposit_batches": (
            f"{OWNER_ONLY} OR EXISTS ("
            " SELECT 1 FROM public.deposit_items di"
            " JOIN public.check_intake_items ci ON ci.id = di.check_id"
            " WHERE di.batch_id = deposit_batches.id"
            "   AND public.aws_can_write_tenant(ci.tenant_id))",
            "deposit_batch_join",
        ),
        "referral_events": (
            f"{OWNER_ONLY} OR public.aws_can_write_tenant(referrer_tenant_id)"
            " OR public.aws_can_write_tenant(referred_tenant_id)",
            "referral_tenants",
        ),
        "tenant_partnerships": (
            f"{OWNER_ONLY} OR public.aws_can_write_tenant(inviter_tenant_id)"
            " OR public.aws_can_write_tenant(invitee_tenant_id)",
            "partnership_tenants",
        ),
        "profiles": (
            "public.aws_is_authenticated() AND ("
            " id = auth.uid() OR public.aws_can_write_same_tenant_user(id))",
            "profiles_self_or_same_tenant",
        ),
        "homeowner_check_uploads": (
            f"{OWNER_ONLY} OR contractor_user_id = auth.uid()"
            " OR public.aws_can_write_check(converted_check_id)",
            "homeowner_upload",
        ),
        "audit_logs": (
            "public.aws_is_authenticated() AND ("
            " user_id = auth.uid() OR public.aws_is_cross_tenant_reader())",
            "audit_self_or_owner",
        ),
        "tenant_users": (
            f"{OWNER_ONLY} OR ("
            " public.aws_can_write_tenant(tenant_id)"
            " AND public.has_role(auth.uid(), 'admin'::public.app_role))",
            "tenant_users_admin",
        ),
        "check_billing_config": (OWNER_ONLY, "catalog_owner_only"),
        "document_templates": (OWNER_ONLY, "catalog_owner_only"),
        "email_templates": (OWNER_ONLY, "catalog_owner_only"),
        "mortgage_companies": (OWNER_ONLY, "catalog_owner_only"),
        "mortgage_desk_config": (OWNER_ONLY, "catalog_owner_only"),
        "platform_announcements": (OWNER_ONLY, "catalog_owner_only"),
        "signature_field_templates": (OWNER_ONLY, "catalog_owner_only"),
        "deposit_daily_digest": (OWNER_ONLY, "ops_owner_only"),
        "deposit_digest_delivery_log": (OWNER_ONLY, "ops_owner_only"),
        "deposit_manager_snapshots": (OWNER_ONLY, "ops_owner_only"),
        "deposit_pending_approvals": (OWNER_ONLY, "ops_owner_only"),
    }
    if table in special:
        return special[table]
    if "tenant_id" in cols:
        return "public.aws_can_write_tenant(tenant_id)", "tenant_id"
    if "org_id" in cols:
        return "public.aws_can_write_tenant(org_id)", "org_id"
    if "check_intake_item_id" in cols:
        return "public.aws_can_write_check(check_intake_item_id)", "check_intake_item_id"
    if "check_id" in cols:
        return "public.aws_can_write_check(check_id)", "check_id"
    if "claim_id" in cols:
        return "public.aws_can_write_claim(claim_id)", "claim_id"
    if "loss_draft_id" in cols:
        return (
            "EXISTS (SELECT 1 FROM public.loss_draft_tracking ldt"
            " WHERE ldt.id = loss_draft_id"
            "   AND public.aws_can_write_claim(ldt.claim_id))",
            "loss_draft_id",
        )
    if "deposit_item_id" in cols:
        return (
            "EXISTS (SELECT 1 FROM public.deposit_items di"
            " WHERE di.id = deposit_item_id"
            "   AND public.aws_can_write_check(di.check_id))",
            "deposit_item_id",
        )
    if "user_id" in cols:
        return "public.aws_can_write_same_tenant_user(user_id)", "user_id"
    raise SystemExit(f"no write clause for {table}: {cols[:20]}")


def policy_sql(name: str, table: str, expr: str) -> list[str]:
    return [
        f"DROP POLICY IF EXISTS {name} ON public.{table};",
        f"CREATE POLICY {name} ON public.{table}",
        "  FOR ALL TO authenticated",
        f"  USING ({expr})",
        f"  WITH CHECK ({expr});",
        "",
    ]


def write_backfill(ids: list[str]) -> None:
    if len(ids) != 83:
        raise SystemExit(f"expected 83 claim ids, got {len(ids)}")
    uniq = sorted(set(ids))
    if len(uniq) != 83:
        raise SystemExit("duplicate claim ids in assignable list")
    lines = [
        "-- Deterministic claims.org_id backfill. Freedom tenant only.",
        "-- Apply only after live verification that assignable=83 and ambiguous=0.",
        "-- Does not touch the 97 claims with no ownership evidence.",
        "-- Does not use created_by, uploaded_by, folder names, or admin roles.",
        "",
        "UPDATE public.claims",
        f"SET org_id = '{FREEDOM}'::uuid",
        "WHERE org_id IS NULL",
        "  AND id IN (",
    ]
    for i, cid in enumerate(uniq):
        comma = "," if i < len(uniq) - 1 else ""
        lines.append(f"    '{cid}'::uuid{comma}")
    lines += [
        "  );",
        "",
    ]
    OUT_BACKFILL.write_text("\n".join(lines) + "\n")


def write_fk() -> int:
    text = FK_PLAN.read_text()
    stmts = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("-- ALTER TABLE") or stripped.startswith("--   ADD CONSTRAINT") \
                or stripped.startswith("--   FOREIGN KEY") or stripped.startswith("--   ON DELETE"):
            stmts.append(stripped[3:].strip() if stripped.startswith("-- ") else stripped[2:].strip())
    # Reassemble ALTER statements that were split across comment lines
    alters = []
    buf = []
    for part in stmts:
        buf.append(part)
        if part.startswith("ON DELETE"):
            sql = " ".join(buf)
            # ensure NOT VALID
            if "NOT VALID" not in sql:
                sql = sql.rstrip(";") + " NOT VALID"
            alters.append(sql.rstrip(";") + ";")
            buf = []
    if buf:
        raise SystemExit(f"unfinished FK statement: {buf}")
    if len(alters) != 47:
        raise SystemExit(f"expected 47 FK ALTERs, got {len(alters)}")
    lines = [
        "-- Retarget 47 former auth.users FKs to identity_accounts(application_user_id).",
        "-- Staging only. Do not rewrite stored UUID values. Ninth UUID needs no Cognito sub.",
        "-- ADD ... NOT VALID then VALIDATE. Stop the oneshot if orphans exist.",
        "",
        "DO $$ BEGIN",
        "  IF NOT EXISTS (",
        "    SELECT 1 FROM pg_constraint",
        "    WHERE conrelid = 'public.identity_accounts'::regclass",
        "      AND contype IN ('p','u')",
        "      AND pg_get_constraintdef(oid) ILIKE '%application_user_id%'",
        "  ) THEN",
        "    RAISE EXCEPTION 'identity_accounts.application_user_id is not unique';",
        "  END IF;",
        "END $$;",
        "",
    ]
    validates = []
    for sql in alters:
        lines.append(sql)
        # extract constraint name
        m = re.search(r"ADD CONSTRAINT (\w+)", sql)
        table = re.search(r"ALTER TABLE public\.(\w+)", sql).group(1)
        name = m.group(1)
        validates.append(f"ALTER TABLE public.{table} VALIDATE CONSTRAINT {name};")
    lines.append("")
    lines.extend(validates)
    lines.append("")
    OUT_FK.write_text("\n".join(lines) + "\n")
    return len(alters)


def main() -> None:
    cols = load_columns()
    wp = json.loads(WRITE_PATHS.read_text())
    claims = json.loads(CLAIMS.read_text())
    ids = [row["claim_id"] for row in claims["assignable"]]
    write_backfill(ids)
    fk_n = write_fk()

    already = set(wp["representative_aws_write_policies"])
    remaining = [r["table"] for r in wp["dump_write_tables"] if r["proposed"] == "tenant_scoped_write_rls_needed"]
    platform = [r["table"] for r in wp["dump_write_tables"] if r["proposed"] == "platform_owner_or_api"]
    server = [r["table"] for r in wp["dump_write_tables"] if r["proposed"] == "server_side_api"]
    obsolete = [r["table"] for r in wp["dump_write_tables"] if r["proposed"] == "do_not_restore"]
    if len(remaining) != 108:
        raise SystemExit(f"expected 108 remaining, got {len(remaining)}")

    policies = []
    lines = [
        "-- Remaining AWS staging write policies (108 tenant-scoped + 7 platform-owner).",
        "-- Does not ENABLE ROW LEVEL SECURITY. Does not replace aws_select_* (165).",
        "-- No USING(true)/WITH CHECK(true). No anon. No service_role.",
        "-- 13 server-side API tables and 2 obsolete tables have no write policy (default deny).",
        "",
        "DO $$ BEGIN",
        "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
        "    CREATE ROLE authenticated NOLOGIN;",
        "  END IF;",
        "END $$;",
        "GRANT authenticated TO checksops;",
        "",
    ]
    kinds = {}
    for table in remaining:
        if table in already:
            raise SystemExit(f"{table} classified remaining but already representative")
        expr, kind = write_clause(table, cols[table])
        name = f"aws_write_{table}"
        policies.append({"table": table, "policy": name, "kind": kind, "class": "tenant_scoped", "using": expr})
        kinds[kind] = kinds.get(kind, 0) + 1
        lines.extend(policy_sql(name, table, expr))

    lines.append("-- Platform-owner/API tables: authenticated owner writes only. Not tenant staff.")
    lines.append("")
    for table in platform:
        name = f"aws_write_{table}"
        expr = OWNER_ONLY
        policies.append({"table": table, "policy": name, "kind": "platform_owner_only", "class": "platform_owner_or_api", "using": expr})
        kinds["platform_owner_only"] = kinds.get("platform_owner_only", 0) + 1
        lines.extend(policy_sql(name, table, expr))

    lines += [
        "-- Intentionally no write policies (default deny once RLS is on):",
        f"-- server_side_api: {', '.join(server)}",
        f"-- do_not_restore: {', '.join(obsolete)}",
        "",
    ]
    OUT_WRITE.write_text("\n".join(lines) + "\n")
    OUT_JSON.write_text(
        json.dumps(
            {
                "remaining_tenant_scoped": 108,
                "platform_owner_write_policies": 7,
                "representative_already_prepared": sorted(already),
                "server_side_api_no_write_policy": server,
                "obsolete_no_write_policy": obsolete,
                "expected_aws_write_total": 12 + 108 + 7,
                "fk_retargets": fk_n,
                "claims_backfill_ids": 83,
                "access_kind_totals": kinds,
                "policies": policies,
            },
            indent=2,
        )
        + "\n"
    )
    print("wrote", OUT_WRITE, "policies", len(policies))
    print("kinds", kinds)
    print("fk", fk_n, "claims", len(ids))


if __name__ == "__main__":
    main()
