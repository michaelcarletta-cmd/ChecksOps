#!/usr/bin/env node
/**
 * Read-only endorsement migration audit.
 *
 * Required:
 *   CHECKSOPS_SOURCE_DATABASE_URL  Original/source PostgreSQL URL
 *   CHECKSOPS_TARGET_DATABASE_URL  Migrated AWS PostgreSQL URL
 *
 * Optional:
 *   CHECKSOPS_AUDIT_OUT             Output prefix (default: endorsement-migration-audit)
 *
 * This program never issues INSERT/UPDATE/DELETE and begins both sessions with
 * an explicit READ ONLY transaction.
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const requireFromApi = createRequire(new URL("../functions/api/package.json", import.meta.url));
const { Client } = requireFromApi("pg");

const sourceUrl = process.env.CHECKSOPS_SOURCE_DATABASE_URL;
const targetUrl = process.env.CHECKSOPS_TARGET_DATABASE_URL;
const outPrefix = process.env.CHECKSOPS_AUDIT_OUT || "endorsement-migration-audit";

if (!sourceUrl || !targetUrl) {
  console.error("Missing CHECKSOPS_SOURCE_DATABASE_URL or CHECKSOPS_TARGET_DATABASE_URL.");
  process.exit(2);
}
if (sourceUrl === targetUrl) {
  console.error("Refusing audit: source and target connection strings are identical.");
  process.exit(2);
}

const normalize = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const normType = (v) => normalize(v) || "other";
const signedValues = new Set(["signed", "endorsed", "complete", "completed", "waived"]);
const normalizedStatus = (status, signedAt) => signedAt ? "signed" : (signedValues.has(normalize(status)) ? "signed" : (normalize(status) || "pending"));
const csv = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;

async function openReadOnly(label, connectionString) {
  const client = new Client({
    connectionString,
    application_name: `checksops_endorsement_audit_${label}`,
    statement_timeout: 30000,
    query_timeout: 35000,
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
      ? undefined
      : { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const check = await client.query("SHOW transaction_read_only");
  if (check.rows[0]?.transaction_read_only !== "on") {
    await client.query("ROLLBACK");
    await client.end();
    throw new Error(`${label} connection is not read-only`);
  }
  return client;
}

async function tableColumns(client, table) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(result.rows.map((r) => r.column_name));
}

const safeColumns = {
  check_intake_items: ["id", "tenant_id", "check_number", "detected_claim_number", "payee_line", "status", "check_stage", "created_at"],
  check_payees: ["id", "check_id", "payee_name", "payee_type", "endorsement_status", "endorsed_at", "created_at"],
  check_endorsements: ["id", "check_id", "payee_id", "payee_name", "payee_type", "status", "signed_at", "created_at"],
  check_endorsement_events: ["id", "check_id", "endorsement_id", "event_type", "created_at"],
  signature_requests: ["id", "check_id", "check_intake_item_id", "status", "created_at", "completed_at"],
  signature_signers: ["id", "signature_request_id", "name", "signer_index", "status", "signed_at", "created_at"],
};

async function selectSafe(client, table, where = "", params = []) {
  const existing = await tableColumns(client, table);
  if (!existing.size) return [];
  const cols = safeColumns[table].filter((c) => existing.has(c));
  if (!cols.length) return [];
  const result = await client.query(
    `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM public."${table}" ${where}`,
    params,
  );
  return result.rows;
}

async function snapshot(client, endorsingIds = null) {
  const checkCols = await tableColumns(client, "check_intake_items");
  if (!checkCols.has("id")) throw new Error("check_intake_items is missing");
  const checks = endorsingIds
    ? await selectSafe(client, "check_intake_items", "WHERE id = ANY($1::uuid[])", [endorsingIds])
    : await selectSafe(
        client,
        "check_intake_items",
        `WHERE ${checkCols.has("check_stage") ? "check_stage = 'endorsing'" : "FALSE"}
           OR ${checkCols.has("status") ? "status = 'endorsements_in_progress'" : "FALSE"}`,
      );
  const ids = checks.map((c) => c.id);
  if (!ids.length) return { checks, payees: [], endorsements: [], events: [], requests: [], signers: [] };

  const payees = await selectSafe(client, "check_payees", "WHERE check_id = ANY($1::uuid[])", [ids]);
  const endorsements = await selectSafe(client, "check_endorsements", "WHERE check_id = ANY($1::uuid[])", [ids]);
  const events = await selectSafe(client, "check_endorsement_events", "WHERE check_id = ANY($1::uuid[])", [ids]);

  const requestCols = await tableColumns(client, "signature_requests");
  const requestCheckCol = requestCols.has("check_id") ? "check_id" : requestCols.has("check_intake_item_id") ? "check_intake_item_id" : null;
  const requests = requestCheckCol
    ? await selectSafe(client, "signature_requests", `WHERE "${requestCheckCol}" = ANY($1::uuid[])`, [ids])
    : [];
  const requestIds = requests.map((r) => r.id);
  const signers = requestIds.length
    ? await selectSafe(client, "signature_signers", "WHERE signature_request_id = ANY($1::uuid[])", [requestIds])
    : [];

  return { checks, payees, endorsements, events, requests, signers };
}

function evidenceStatus(snapshot, payee) {
  const candidates = snapshot.endorsements.filter((e) =>
    e.check_id === payee.check_id && (
      (e.payee_id && e.payee_id === payee.id) ||
      (normalize(e.payee_name) === normalize(payee.payee_name) && normType(e.payee_type) === normType(payee.payee_type))
    )
  );
  const signed = candidates.find((e) => normalizedStatus(e.status, e.signed_at) === "signed");
  return {
    payeeStatus: normalizedStatus(payee.endorsement_status, payee.endorsed_at),
    endorsementStatus: signed ? "signed" : (candidates[0] ? normalizedStatus(candidates[0].status, candidates[0].signed_at) : "none"),
    endorsementIds: candidates.map((e) => e.id),
  };
}

let source;
let target;
try {
  source = await openReadOnly("source", sourceUrl);
  target = await openReadOnly("target", targetUrl);

  const targetSnap = await snapshot(target);
  const ids = targetSnap.checks.map((c) => c.id);
  const sourceSnap = await snapshot(source, ids);

  const sourceChecks = new Map(sourceSnap.checks.map((c) => [c.id, c]));
  const targetChecks = new Map(targetSnap.checks.map((c) => [c.id, c]));
  const findings = [];

  for (const checkId of ids) {
    const sPayees = sourceSnap.payees.filter((p) => p.check_id === checkId);
    const tPayees = targetSnap.payees.filter((p) => p.check_id === checkId);
    const usedTarget = new Set();

    for (const sp of sPayees) {
      const exact = tPayees.find((tp) => !usedTarget.has(tp.id) && tp.id === sp.id);
      const identity = exact || tPayees.find((tp) =>
        !usedTarget.has(tp.id) &&
        normalize(tp.payee_name) === normalize(sp.payee_name) &&
        normType(tp.payee_type) === normType(sp.payee_type)
      );
      const se = evidenceStatus(sourceSnap, sp);
      if (!identity) {
        findings.push({
          severity: se.payeeStatus === "signed" || se.endorsementStatus === "signed" ? "critical" : "high",
          classification: se.payeeStatus === "signed" || se.endorsementStatus === "signed" ? "missing_signed_payee" : "missing_pending_payee",
          check_id: checkId,
          check_number: targetChecks.get(checkId)?.check_number ?? sourceChecks.get(checkId)?.check_number ?? "",
          claim_number: targetChecks.get(checkId)?.detected_claim_number ?? sourceChecks.get(checkId)?.detected_claim_number ?? "",
          payee_name: sp.payee_name,
          payee_type: sp.payee_type,
          source_status: se.payeeStatus,
          target_status: "missing",
          evidence: se.endorsementIds.length ? `source endorsements: ${se.endorsementIds.join(",")}` : "source payee record",
        });
        continue;
      }
      usedTarget.add(identity.id);
      const te = evidenceStatus(targetSnap, identity);
      const sourceSigned = se.payeeStatus === "signed" || se.endorsementStatus === "signed";
      const targetSigned = te.payeeStatus === "signed" || te.endorsementStatus === "signed";
      if (sourceSigned && !targetSigned) {
        findings.push({
          severity: "critical",
          classification: "signed_status_regression",
          check_id: checkId,
          check_number: targetChecks.get(checkId)?.check_number ?? "",
          claim_number: targetChecks.get(checkId)?.detected_claim_number ?? "",
          payee_name: sp.payee_name,
          payee_type: sp.payee_type,
          source_status: "signed",
          target_status: te.payeeStatus,
          evidence: `source endorsements: ${se.endorsementIds.join(",") || "signed payee"}`,
        });
      }
    }

    for (const tp of tPayees.filter((p) => !usedTarget.has(p.id))) {
      const te = evidenceStatus(targetSnap, tp);
      findings.push({
        severity: "medium",
        classification: "target_only_payee",
        check_id: checkId,
        check_number: targetChecks.get(checkId)?.check_number ?? "",
        claim_number: targetChecks.get(checkId)?.detected_claim_number ?? "",
        payee_name: tp.payee_name,
        payee_type: tp.payee_type,
        source_status: "missing",
        target_status: te.payeeStatus,
        evidence: te.endorsementIds.length ? `target endorsements: ${te.endorsementIds.join(",")}` : "target payee record",
      });
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    mode: "READ_ONLY",
    target_endorsing_checks: targetSnap.checks.length,
    source_checks_found: sourceSnap.checks.length,
    source_payees: sourceSnap.payees.length,
    target_payees: targetSnap.payees.length,
    source_endorsements: sourceSnap.endorsements.length,
    target_endorsements: targetSnap.endorsements.length,
    findings: findings.reduce((m, f) => ({ ...m, [f.classification]: (m[f.classification] || 0) + 1 }), {}),
  };

  fs.writeFileSync(`${outPrefix}.json`, JSON.stringify({ summary, findings }, null, 2));
  const headers = ["severity","classification","check_id","check_number","claim_number","payee_name","payee_type","source_status","target_status","evidence"];
  fs.writeFileSync(
    `${outPrefix}.csv`,
    [headers.map(csv).join(","), ...findings.map((f) => headers.map((h) => csv(f[h])).join(","))].join("\n") + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outPrefix}.json and ${outPrefix}.csv`);
} finally {
  for (const client of [source, target]) {
    if (!client) continue;
    try { await client.query("ROLLBACK"); } catch {}
    try { await client.end(); } catch {}
  }
}
