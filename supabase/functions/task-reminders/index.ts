import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

interface Task {
  id: string;
  title: string;
  description: string | null;
  due_date: string;
  priority: string | null;
  status: string;
  assigned_to: string | null;
  claim_id: string;
  claims?: {
    claim_number: string | null;
    policyholder_name: string | null;
  } | null;
}

interface NotificationPreferences {
  in_app_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
}

interface Profile {
  id: string;
  email: string;
  phone: string | null;
  full_name: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Validate CRON_SECRET for security
  const cronSecret = Deno.env.get('CRON_SECRET');
  const providedSecret = req.headers.get('x-cron-secret');
  
  if (cronSecret && providedSecret !== cronSecret) {
    console.error('Invalid or missing cron secret');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const twilioAccountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const twilioPhoneNumber = Deno.env.get("TWILIO_PHONE_NUMBER");

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    console.log("Checking for tasks due on or before:", tomorrowStr);

    // Fetch tasks that are due soon (within 24 hours) or overdue, and not completed
    const { data: tasks, error: tasksError } = await supabaseAdmin
      .from("tasks")
      .select(`
        id, title, description, due_date, priority, status, assigned_to, claim_id,
        claims(claim_number, policyholder_name)
      `)
      .neq("status", "completed")
      .lte("due_date", tomorrowStr)
      .not("assigned_to", "is", null);

    if (tasksError) {
      console.error("Error fetching tasks:", tasksError);
      throw tasksError;
    }

    console.log(`Found ${tasks?.length || 0} tasks due soon or overdue`);

    if (!tasks || tasks.length === 0) {
      return new Response(JSON.stringify({ message: "No tasks due", sent: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Group tasks by assigned user
    const tasksByUser: Record<string, Task[]> = {};
    for (const task of tasks) {
      if (task.assigned_to) {
        if (!tasksByUser[task.assigned_to]) {
          tasksByUser[task.assigned_to] = [];
        }
        // Map the Supabase response to our Task interface
        const mappedTask: Task = {
          ...task,
          claims: Array.isArray(task.claims) ? task.claims[0] : task.claims,
        };
        tasksByUser[task.assigned_to].push(mappedTask);
      }
    }

    let notificationsSent = 0;

    for (const [userId, userTasks] of Object.entries(tasksByUser)) {
      console.log(`Processing ${userTasks.length} tasks for user ${userId}`);

      // Get user's notification preferences
      const { data: prefs } = await supabaseAdmin
        .rpc("get_or_create_notification_preferences", { p_user_id: userId });

      const preferences: NotificationPreferences = prefs || {
        in_app_enabled: true,
        email_enabled: true,
        sms_enabled: false,
      };

      console.log(`User ${userId} preferences:`, preferences);

      // Get user profile for email/phone
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("id, email, phone, full_name")
        .eq("id", userId)
        .single();

      if (!profile) {
        console.log(`No profile found for user ${userId}`);
        continue;
      }

      // Categorize tasks
      const overdueTasks = userTasks.filter((t) => {
        const dueDate = new Date(t.due_date);
        return dueDate < now;
      });
      const dueTodayTasks = userTasks.filter((t) => {
        const dueDate = new Date(t.due_date);
        return dueDate.toDateString() === now.toDateString();
      });
      const dueTomorrowTasks = userTasks.filter((t) => {
        const dueDate = new Date(t.due_date);
        return dueDate.toDateString() === tomorrow.toDateString();
      });

      // Build notification message
      const buildMessage = (format: "html" | "text" | "short") => {
        if (format === "short") {
          // SMS format - concise
          let msg = "Task Reminders: ";
          if (overdueTasks.length > 0) msg += `${overdueTasks.length} overdue. `;
          if (dueTodayTasks.length > 0) msg += `${dueTodayTasks.length} due today. `;
          if (dueTomorrowTasks.length > 0) msg += `${dueTomorrowTasks.length} due tomorrow.`;
          return msg.trim();
        }

        const formatTaskList = (taskList: Task[], html: boolean) => {
          return taskList
            .map((t) => {
              const claimInfo = t.claims?.claim_number
                ? ` (Claim: ${t.claims.claim_number})`
                : "";
              if (html) {
                return `<li><strong>${t.title}</strong>${claimInfo}</li>`;
              }
              return `- ${t.title}${claimInfo}`;
            })
            .join(html ? "" : "\n");
        };

        let content = "";

        if (overdueTasks.length > 0) {
          if (format === "html") {
            content += `<h3 style="color: #ef4444;">⚠️ Overdue Tasks (${overdueTasks.length})</h3><ul>${formatTaskList(overdueTasks, true)}</ul>`;
          } else {
            content += `OVERDUE (${overdueTasks.length}):\n${formatTaskList(overdueTasks, false)}\n\n`;
          }
        }

        if (dueTodayTasks.length > 0) {
          if (format === "html") {
            content += `<h3 style="color: #f59e0b;">📅 Due Today (${dueTodayTasks.length})</h3><ul>${formatTaskList(dueTodayTasks, true)}</ul>`;
          } else {
            content += `DUE TODAY (${dueTodayTasks.length}):\n${formatTaskList(dueTodayTasks, false)}\n\n`;
          }
        }

        if (dueTomorrowTasks.length > 0) {
          if (format === "html") {
            content += `<h3 style="color: #3b82f6;">📆 Due Tomorrow (${dueTomorrowTasks.length})</h3><ul>${formatTaskList(dueTomorrowTasks, true)}</ul>`;
          } else {
            content += `DUE TOMORROW (${dueTomorrowTasks.length}):\n${formatTaskList(dueTomorrowTasks, false)}`;
          }
        }

        return content;
      };

      // In-app notifications are no longer created for task reminders.
      // Bell icon notifications are reserved for explicit user-initiated "Notify" actions only.
      // Task reminders are delivered via email and SMS only.

      // Send email notification
      if (preferences.email_enabled && resendApiKey && profile.email) {
        console.log(`Sending email notification to ${profile.email}`);
        
        const resend = new Resend(resendApiKey);
        const htmlContent = buildMessage("html");
        
        try {
          await resend.emails.send({
            from: "Freedom Claims <noreply@claims.freedomclaims.work>",
            to: [profile.email],
            subject: `Task Reminders: ${userTasks.length} task(s) need attention`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #1e293b;">Task Reminders</h2>
                <p>Hi ${profile.full_name || "there"},</p>
                <p>You have tasks that need your attention:</p>
                ${htmlContent}
                <hr style="margin: 20px 0; border: none; border-top: 1px solid #e2e8f0;" />
                <p style="color: #64748b; font-size: 12px;">
                  You can manage your notification preferences in Settings > Notifications.
                </p>
              </div>
            `,
          });
          notificationsSent++;
          console.log(`Email sent to ${profile.email}`);
        } catch (emailError) {
          console.error("Error sending email:", emailError);
        }
      }

      // Send SMS notification
      if (preferences.sms_enabled && twilioAccountSid && twilioAuthToken && twilioPhoneNumber && profile.phone) {
        console.log(`Sending SMS notification to ${profile.phone}`);
        
        const smsMessage = buildMessage("short");
        
        try {
          const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
          const auth = btoa(`${twilioAccountSid}:${twilioAuthToken}`);
          
          const response = await fetch(twilioUrl, {
            method: "POST",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: profile.phone,
              From: twilioPhoneNumber,
              Body: smsMessage,
            }),
          });

          if (response.ok) {
            notificationsSent++;
            console.log(`SMS sent to ${profile.phone}`);
          } else {
            const errorText = await response.text();
            console.error("Twilio error:", errorText);
          }
        } catch (smsError) {
          console.error("Error sending SMS:", smsError);
        }
      }
    }

    console.log(`Task reminders complete. Sent ${notificationsSent} notifications.`);

    return new Response(
      JSON.stringify({
        message: "Task reminders processed",
        tasksProcessed: tasks.length,
        notificationsSent,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: unknown) {
    console.error("Error in task-reminders function:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
