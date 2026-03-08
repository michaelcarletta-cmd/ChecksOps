import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "send_endorsement_request": {
        // Requires auth
        const token = req.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) return unauthorized();
        const { data: { user } } = await supabase.auth.getUser(token);
        if (!user) return unauthorized();

        const { payeeId, method } = body; // method: email | sms | both
        const { data: payee } = await supabase.from("check_payees").select("*, check_intake_items(*)").eq("id", payeeId).single();
        if (!payee) {
          return jsonResponse({ error: "Payee not found" }, 404);
        }

        const endorsementUrl = `${supabaseUrl.replace('.supabase.co', '.supabase.co')}/functions/v1/check-endorsement?action=view_endorsement&token=${payee.endorsement_token}`;

        // Send notification based on method
        if ((method === "email" || method === "both") && payee.contact_email) {
          // Queue email via send-email function
          try {
            await supabase.functions.invoke("send-email", {
              body: {
                to: payee.contact_email,
                subject: `Endorsement Required - Check #${payee.check_intake_items?.check_number || "N/A"}`,
                html: `<p>Hello ${payee.payee_name},</p>
                  <p>An insurance check requires your endorsement. Please click the link below to review and endorse:</p>
                  <p><a href="${endorsementUrl}" style="background:#2563eb;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;">Review & Endorse</a></p>
                  <p>This link expires in 30 days.</p>`,
              },
            });
          } catch (e) {
            console.error("Email send failed:", e);
          }
        }

        if ((method === "sms" || method === "both") && payee.contact_phone) {
          try {
            await supabase.functions.invoke("send-sms", {
              body: {
                to: payee.contact_phone,
                message: `Endorsement needed for insurance check #${payee.check_intake_items?.check_number || "N/A"}. Review: ${endorsementUrl}`,
              },
            });
          } catch (e) {
            console.error("SMS send failed:", e);
          }
        }

        await supabase.from("check_payees").update({
          notification_sent_via: method,
          notification_sent_at: new Date().toISOString(),
        }).eq("id", payeeId);

        await supabase.from("check_endorsement_events").insert({
          check_id: payee.check_id,
          payee_id: payeeId,
          event_type: "endorsement_request_sent",
          event_data: { method, contact_email: payee.contact_email, contact_phone: payee.contact_phone },
          actor_id: user.id,
        });

        await supabase.from("check_audit_log").insert({
          check_id: payee.check_id,
          event_type: "endorsement_request_sent",
          event_description: `Endorsement request sent to ${payee.payee_name} via ${method}`,
          event_data: { payee_id: payeeId, method },
          actor_id: user.id,
        });

        return jsonResponse({ success: true, endorsementUrl });
      }

      case "view_endorsement": {
        // Public access by token
        const endorsementToken = new URL(req.url).searchParams.get("token") || body.token;
        if (!endorsementToken) return jsonResponse({ error: "Token required" }, 400);

        const { data: payee } = await supabase
          .from("check_payees")
          .select("*, check_intake_items(carrier_name, check_number, amount)")
          .eq("endorsement_token", endorsementToken)
          .single();

        if (!payee) return jsonResponse({ error: "Invalid or expired endorsement link" }, 404);
        if (payee.endorsement_token_expires_at && new Date(payee.endorsement_token_expires_at) < new Date()) {
          await supabase.from("check_payees").update({ endorsement_status: "expired" }).eq("id", payee.id);
          return jsonResponse({ error: "Endorsement link has expired" }, 410);
        }

        // Mark as viewed
        if (payee.endorsement_status === "pending") {
          await supabase.from("check_payees").update({ endorsement_status: "viewed" }).eq("id", payee.id);
          await supabase.from("check_endorsement_events").insert({
            check_id: payee.check_id,
            payee_id: payee.id,
            event_type: "endorsement_viewed",
          });
        }

        return jsonResponse({
          payee_name: payee.payee_name,
          carrier: payee.check_intake_items?.carrier_name,
          check_number: payee.check_intake_items?.check_number,
          amount: payee.check_intake_items?.amount,
          status: payee.endorsement_status,
        });
      }

      case "submit_endorsement": {
        const { token: eToken, endorsementImagePath } = body;
        if (!eToken) return jsonResponse({ error: "Token required" }, 400);

        const { data: payee } = await supabase.from("check_payees")
          .select("*").eq("endorsement_token", eToken).single();
        if (!payee) return jsonResponse({ error: "Invalid token" }, 404);

        await supabase.from("check_payees").update({
          endorsement_status: "signed",
          endorsement_image_path: endorsementImagePath || null,
          endorsed_at: new Date().toISOString(),
        }).eq("id", payee.id);

        await supabase.from("check_endorsement_events").insert({
          check_id: payee.check_id,
          payee_id: payee.id,
          event_type: "endorsement_signed",
          event_data: { has_image: !!endorsementImagePath },
        });

        await supabase.from("check_audit_log").insert({
          check_id: payee.check_id,
          event_type: "endorsement_completed",
          event_description: `${payee.payee_name} endorsed the check`,
          event_data: { payee_id: payee.id },
        });

        // Check if all payees have endorsed — re-evaluate eligibility
        const { data: allPayees } = await supabase.from("check_payees").select("endorsement_status").eq("check_id", payee.check_id);
        const allSigned = allPayees?.every((p: any) => p.endorsement_status === "signed");

        if (allSigned) {
          await supabase.from("check_intake_items").update({
            status: "ready",
            deposit_recommendation: "ready_for_deposit",
          }).eq("id", payee.check_id);

          await supabase.from("check_audit_log").insert({
            check_id: payee.check_id,
            event_type: "all_endorsements_complete",
            event_description: "All payees have endorsed — check is ready for deposit",
          });
        }

        return jsonResponse({ success: true, allSigned });
      }

      case "reject_endorsement": {
        const { token: rToken, reason } = body;
        if (!rToken) return jsonResponse({ error: "Token required" }, 400);

        const { data: payee } = await supabase.from("check_payees")
          .select("*").eq("endorsement_token", rToken).single();
        if (!payee) return jsonResponse({ error: "Invalid token" }, 404);

        await supabase.from("check_payees").update({ endorsement_status: "rejected" }).eq("id", payee.id);

        await supabase.from("check_endorsement_events").insert({
          check_id: payee.check_id,
          payee_id: payee.id,
          event_type: "endorsement_rejected",
          event_data: { reason },
        });

        await supabase.from("check_audit_log").insert({
          check_id: payee.check_id,
          event_type: "endorsement_rejected",
          event_description: `${payee.payee_name} rejected endorsement: ${reason || "No reason given"}`,
          event_data: { payee_id: payee.id, reason },
        });

        return jsonResponse({ success: true });
      }

      default:
        return jsonResponse({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error("check-endorsement error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function unauthorized() {
  return jsonResponse({ error: "Unauthorized" }, 401);
}
