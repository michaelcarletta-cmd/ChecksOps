/**
 * Acceptance tests for loss_draft_action RPC, dashboard counts,
 * document checklist, and holdback math.
 *
 * Run: node scripts/test-loss-draft-rpc.mjs
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false } });

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail ?? ""); }
}

async function cleanup(ids) {
  for (const id of ids) {
    await sb.from("loss_draft_audit_log").delete().eq("loss_draft_id", id);
    await sb.from("loss_draft_documents").delete().eq("loss_draft_id", id);
    await sb.from("loss_draft_releases").delete().eq("loss_draft_id", id);
    await sb.from("loss_draft_tracking").delete().eq("id", id);
  }
}

async function run() {
  console.log("\n🧪 Loss Draft RPC Acceptance Tests\n");

  // We need a staff user id and a claim id for testing
  const { data: staffRoles } = await sb.from("user_roles").select("user_id").eq("role", "staff").limit(1);
  const { data: adminRoles } = await sb.from("user_roles").select("user_id").eq("role", "admin").limit(1);
  const actorId = staffRoles?.[0]?.user_id || adminRoles?.[0]?.user_id;
  if (!actorId) { console.error("No staff/admin user found for testing"); process.exit(1); }

  const { data: claims } = await sb.from("claims").select("id").limit(1);
  const claimId = claims?.[0]?.id;
  if (!claimId) { console.error("No claim found for testing"); process.exit(1); }

  const idsToClean = [];

  try {
    // --- Test 1: Create loss draft ---
    console.log("1️⃣  Create loss draft");
    const { data: created, error: createErr } = await sb
      .from("loss_draft_tracking")
      .insert({ claim_id: claimId, mortgage_servicer: "Test Bank Corp", created_by: actorId, total_escrowed: 0 })
      .select("id")
      .single();
    assert("Loss draft created", !createErr && created?.id, createErr?.message);
    const ldId = created.id;
    idsToClean.push(ldId);

    // --- Test 2: Init document checklist ---
    console.log("2️⃣  Document checklist init");
    const { error: initErr } = await sb.rpc("init_loss_draft_documents", { p_loss_draft_id: ldId });
    assert("init_loss_draft_documents succeeds", !initErr, initErr?.message);
    const { data: docs } = await sb.from("loss_draft_documents").select("*").eq("loss_draft_id", ldId);
    assert("Creates 11 checklist items", docs?.length === 11, `got ${docs?.length}`);
    const required = docs?.filter(d => d.is_required) ?? [];
    assert("7+ required docs", required.length >= 7, `got ${required.length}`);

    // --- Test 3: Transition validation — reject invalid ---
    console.log("3️⃣  Transition validation");
    const { error: badRelease } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "record_release", p_actor_id: actorId, p_amount: 100,
    });
    assert("Rejects record_release from pending_send", !!badRelease, badRelease?.message);

    const { error: badDraw } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "request_draw", p_actor_id: actorId, p_amount: 100,
    });
    assert("Rejects request_draw from pending_send", !!badDraw, badDraw?.message);

    const { error: badFinal } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "mark_final_release", p_actor_id: actorId,
    });
    assert("Rejects mark_final_release from pending_send", !!badFinal, badFinal?.message);

    // --- Test 4: Valid transitions: send → escrow → draw → release → final ---
    console.log("4️⃣  Valid transition chain");
    const { error: sendErr } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "mark_sent", p_actor_id: actorId,
    });
    assert("mark_sent succeeds", !sendErr, sendErr?.message);

    const { error: escrowErr } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "mark_escrowed", p_actor_id: actorId, p_amount: 25000,
    });
    assert("mark_escrowed succeeds", !escrowErr, escrowErr?.message);

    // Verify holdback initialized to escrowed amount
    const { data: afterEscrow } = await sb.from("loss_draft_tracking").select("*").eq("id", ldId).single();
    assert("Holdback set to escrowed amount on escrow", afterEscrow.holdback_amount === 25000,
      `holdback=${afterEscrow.holdback_amount}`);

    const { error: drawErr } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "request_draw", p_actor_id: actorId, p_amount: 10000,
    });
    assert("request_draw succeeds", !drawErr, drawErr?.message);

    const { data: afterDraw } = await sb.from("loss_draft_tracking").select("*").eq("id", ldId).single();
    assert("Draw stage incremented to 1", afterDraw.draw_stage === 1, `stage=${afterDraw.draw_stage}`);
    assert("Status is first_draw_requested", afterDraw.escrow_status === "first_draw_requested");

    // Release $8000 of the $10000 draw
    const { error: relErr } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "record_release", p_actor_id: actorId, p_amount: 8000,
    });
    assert("record_release succeeds", !relErr, relErr?.message);

    const { data: afterRel } = await sb.from("loss_draft_tracking").select("*").eq("id", ldId).single();
    assert("Released amount = 8000", afterRel.draw_amount_released === 8000, `released=${afterRel.draw_amount_released}`);
    assert("Holdback = 25000 - 0 - 8000 = 17000", afterRel.holdback_amount === 17000,
      `holdback=${afterRel.holdback_amount}`);
    assert("Status is partial_release", afterRel.escrow_status === "partial_release");

    // Release without open release row (should append new row)
    const { error: rel2Err } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "record_release", p_actor_id: actorId, p_amount: 5000,
    });
    assert("record_release appends when no open row", !rel2Err, rel2Err?.message);
    const { data: releases } = await sb.from("loss_draft_releases").select("*").eq("loss_draft_id", ldId).order("draw_number");
    assert("Two release rows exist", releases?.length === 2, `count=${releases?.length}`);

    // Final release
    const { error: finalErr } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "mark_final_release", p_actor_id: actorId,
    });
    assert("mark_final_release succeeds", !finalErr, finalErr?.message);

    const { data: afterFinal } = await sb.from("loss_draft_tracking").select("*").eq("id", ldId).single();
    assert("Final status = final_release_complete", afterFinal.escrow_status === "final_release_complete");
    assert("Released = escrowed after final", afterFinal.draw_amount_released === 25000);
    assert("Holdback = 0 after final", afterFinal.holdback_amount === 0);

    // --- Test 5: Reject actions from final ---
    console.log("5️⃣  Reject actions from final_release_complete");
    const { error: postFinalDraw } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "request_draw", p_actor_id: actorId, p_amount: 1000,
    });
    assert("Rejects request_draw from final", !!postFinalDraw);

    const { error: postFinalSend } = await sb.rpc("loss_draft_action", {
      p_loss_draft_id: ldId, p_action: "mark_sent", p_actor_id: actorId,
    });
    assert("Rejects mark_sent from final", !!postFinalSend);

    // --- Test 6: Audited doc toggle ---
    console.log("6️⃣  Audited document toggle");
    const docId = docs[0].id;
    const { error: toggleErr } = await sb.rpc("loss_draft_toggle_document", {
      p_doc_id: docId, p_is_submitted: true, p_actor_id: actorId,
    });
    assert("Toggle doc submitted", !toggleErr, toggleErr?.message);
    const { data: toggled } = await sb.from("loss_draft_documents").select("*").eq("id", docId).single();
    assert("Doc is_submitted = true", toggled.is_submitted === true);
    assert("submitted_at is set", toggled.submitted_at != null);

    // Check audit row was created
    const { data: docAudit } = await sb.from("loss_draft_audit_log")
      .select("action").eq("loss_draft_id", ldId).eq("action", "document_submitted");
    assert("Audit row for doc submit exists", (docAudit?.length ?? 0) > 0);

    // Toggle back
    const { error: untoggleErr } = await sb.rpc("loss_draft_toggle_document", {
      p_doc_id: docId, p_is_submitted: false, p_actor_id: actorId,
    });
    assert("Toggle doc unsubmitted", !untoggleErr, untoggleErr?.message);

    // --- Test 7: Idempotent creation ---
    console.log("7️⃣  Idempotent creation guard");
    // The unique index should prevent duplicate active drafts for same claim+servicer
    const { error: dupeErr } = await sb
      .from("loss_draft_tracking")
      .insert({ claim_id: claimId, mortgage_servicer: "Test Bank Corp", created_by: actorId, total_escrowed: 0 });
    // The first one is final_release_complete so this should succeed (index excludes final)
    // Let's create a second active one to test the guard
    if (!dupeErr) {
      const { data: dup2 } = await sb.from("loss_draft_tracking")
        .select("id").eq("claim_id", claimId).neq("escrow_status", "final_release_complete")
        .order("created_at", { ascending: false }).limit(1).single();
      if (dup2) idsToClean.push(dup2.id);
      // Now try again — should fail
      const { error: dupeErr2 } = await sb
        .from("loss_draft_tracking")
        .insert({ claim_id: claimId, mortgage_servicer: "Test Bank Corp", created_by: actorId, total_escrowed: 0 });
      assert("Duplicate active draft rejected", !!dupeErr2, dupeErr2?.message);
    } else {
      assert("Second draft allowed (first is final)", false, dupeErr.message);
    }

    // --- Test 8: Dashboard counts RPC ---
    console.log("8️⃣  Dashboard counts");
    // Need to impersonate staff for RPC — use service role which bypasses
    const { data: counts, error: countsErr } = await sb.rpc("get_loss_draft_dashboard_counts");
    assert("get_loss_draft_dashboard_counts succeeds", !countsErr, countsErr?.message);
    assert("Counts has total_active key", counts?.total_active !== undefined);
    assert("Counts has total_unreleased key", counts?.total_unreleased !== undefined);
    assert("Counts has stale_count key", counts?.stale_count !== undefined);
    assert("Counts has overdue_followup key", counts?.overdue_followup !== undefined);

    // --- Test 9: Audit trail completeness ---
    console.log("9️⃣  Audit trail");
    const { data: allAudit } = await sb.from("loss_draft_audit_log").select("action").eq("loss_draft_id", ldId);
    const actions = (allAudit ?? []).map(a => a.action);
    assert("Audit has mark_sent", actions.includes("mark_sent"));
    assert("Audit has mark_escrowed", actions.includes("mark_escrowed"));
    assert("Audit has request_draw", actions.includes("request_draw"));
    assert("Audit has record_release", actions.includes("record_release"));
    assert("Audit has mark_final_release", actions.includes("mark_final_release"));

  } finally {
    await cleanup(idsToClean);
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
