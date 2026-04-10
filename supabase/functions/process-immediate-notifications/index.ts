import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ImmediateTask {
  id: string;
  assigned_to: string;
  immediate_enabled: boolean;
  status: string;
  snoozed_until: string | null;
  next_notification_at: string | null;
  last_notified_at: string | null;
  escalation_level: number;
  escalation_enabled: boolean;
  notification_channels: string[];
  notification_strategy: string;
  push_enabled: boolean;
  sms_enabled: boolean;
  email_enabled: boolean;
  snooze_count: number;
  requires_acknowledgement: boolean;
  due_at: string | null;
  title: string;
  urgent_reason: string | null;
  claim_id: string | null;
}

function computeEscalationLevel(task: ImmediateTask): number {
  const now = Date.now();
  const lastNotified = task.last_notified_at
    ? new Date(task.last_notified_at).getTime()
    : 0;
  const minutesSinceNotified = lastNotified
    ? (now - lastNotified) / (1000 * 60)
    : Infinity;

  if (task.snooze_count >= 2 || minutesSinceNotified >= 30) return 3;
  if (task.snooze_count >= 1 || minutesSinceNotified >= 15) return 2;
  return 1;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const now = new Date();

    // Find all immediate tasks that need notification processing
    const { data: tasks, error: fetchError } = await supabase
      .from("tasks")
      .select("*")
      .eq("immediate_enabled", true)
      .not("status", "in", '("completed","dropped")')
      .not("next_notification_at", "is", null)
      .lte("next_notification_at", now.toISOString());

    if (fetchError) {
      console.error("Error fetching immediate tasks:", fetchError);
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!tasks || tasks.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, message: "No tasks need notification" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalProcessed = 0;
    let totalSent = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const task of tasks as ImmediateTask[]) {
      // Skip if snoozed into the future
      if (task.snoozed_until && new Date(task.snoozed_until).getTime() > now.getTime()) {
        continue;
      }

      totalProcessed++;
      const newEscalation = computeEscalationLevel(task);

      // Resolve user profile for notification capabilities
      let profile: { phone?: string; email?: string } | null = null;
      if (task.assigned_to) {
        const { data: p } = await supabase
          .from("profiles")
          .select("phone, email")
          .eq("id", task.assigned_to)
          .single();
        profile = p;
      }

      const channels: string[] = ["in_app"];
      const skippedChannels: { channel: string; reason: string }[] = [];

      // Push
      if (task.push_enabled && task.notification_channels.includes("push")) {
        // Push provider not yet configured - log as skipped
        skippedChannels.push({ channel: "push", reason: "Push provider not configured" });
      }

      // SMS (only at escalation level 3 or if explicitly enabled)
      if (task.sms_enabled && task.notification_channels.includes("sms") && newEscalation >= 3) {
        if (profile?.phone) {
          try {
            await supabase.functions.invoke("send-sms-notification", {
              body: {
                to: profile.phone,
                message: `URGENT: ${task.title}${task.urgent_reason ? ` — ${task.urgent_reason}` : ""}`,
                task_id: task.id,
              },
            });
            channels.push("sms");
            totalSent++;
          } catch {
            skippedChannels.push({ channel: "sms", reason: "SMS delivery failed" });
            totalErrors++;
          }
        } else {
          skippedChannels.push({ channel: "sms", reason: "No phone number" });
        }
      }

      // Email (escalation level 2+ or explicitly enabled)
      if (task.email_enabled && task.notification_channels.includes("email") && newEscalation >= 2) {
        if (profile?.email) {
          try {
            await supabase.functions.invoke("send-transactional-email", {
              body: {
                templateName: "urgent-task-notification",
                recipientEmail: profile.email,
                idempotencyKey: `urgent-task-${task.id}-esc${newEscalation}`,
                templateData: {
                  title: task.title,
                  urgent_reason: task.urgent_reason || "",
                  escalation_level: newEscalation,
                },
              },
            });
            channels.push("email");
            totalSent++;
          } catch {
            skippedChannels.push({ channel: "email", reason: "Email delivery failed" });
            totalErrors++;
          }
        } else {
          skippedChannels.push({ channel: "email", reason: "No email address" });
        }
      }

      // Log in_app as always sent
      totalSent++;

      // Log delivery for each channel
      for (const ch of channels) {
        await supabase.from("notification_delivery_logs").insert({
          task_id: task.id,
          user_id: task.assigned_to,
          channel: ch,
          notification_type: task.notification_strategy,
          escalation_level: newEscalation,
          delivery_status: "sent",
        });
      }

      for (const skip of skippedChannels) {
        totalSkipped++;
        await supabase.from("notification_delivery_logs").insert({
          task_id: task.id,
          user_id: task.assigned_to,
          channel: skip.channel,
          notification_type: task.notification_strategy,
          escalation_level: newEscalation,
          delivery_status: "skipped_fallback",
          provider_response: { reason: skip.reason },
        });
      }

      // Update task escalation and next notification time
      const nextMinutes = newEscalation >= 3 ? 10 : newEscalation >= 2 ? 15 : 20;
      const nextNotificationAt = new Date(
        now.getTime() + nextMinutes * 60 * 1000
      ).toISOString();

      await supabase
        .from("tasks")
        .update({
          last_notified_at: now.toISOString(),
          next_notification_at: nextNotificationAt,
          escalation_level: newEscalation,
        })
        .eq("id", task.id);

      // Log escalation event if level increased
      if (newEscalation > task.escalation_level) {
        await supabase.from("task_activity_events").insert({
          task_id: task.id,
          user_id: task.assigned_to,
          event_type: "escalation_sent",
          metadata_json: {
            from_level: task.escalation_level,
            to_level: newEscalation,
            channels,
          },
        });
      }

      // Deadline breach detection (log once per breach)
      if (task.due_at) {
        const dueTime = new Date(task.due_at).getTime();
        if (dueTime < now.getTime() && task.escalation_level < 3) {
          await supabase.from("task_activity_events").insert({
            task_id: task.id,
            user_id: task.assigned_to,
            event_type: "deadline_breached",
            metadata_json: {
              due_at: task.due_at,
              detected_at: now.toISOString(),
            },
          });
        }
      }
    }

    return new Response(
      JSON.stringify({
        processed: totalProcessed,
        sent: totalSent,
        skipped: totalSkipped,
        errors: totalErrors,
        timestamp: now.toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Notification processing error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
