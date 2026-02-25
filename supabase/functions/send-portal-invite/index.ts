import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface PortalInviteRequest {
  email: string;
  password: string;
  userType: string;
  userName?: string;
  appUrl?: string;
}

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, password, userType, userName, appUrl }: PortalInviteRequest = await req.json();

    console.log(`Sending portal invite to ${email} for ${userType}`);

    // Use the app URL passed from frontend, or fall back to a default
    const loginUrl = appUrl ? `${appUrl}/auth` : "https://freedomclaims.work/auth";
    
    console.log(`Using login URL: ${loginUrl}`);

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #1e3a5f 0%, #2d4a6f 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Freedom Claims</h1>
          <p style="color: rgba(255,255,255,0.8); margin: 10px 0 0 0;">${userType} Portal Access</p>
        </div>
        
        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
          <p style="margin-top: 0;">Hello${userName ? ` ${userName}` : ''},</p>
          
          <p>Your ${userType.toLowerCase()} portal account has been created. You can now access your claims and documents through our secure portal.</p>
          
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 20px; margin: 24px 0;">
            <h3 style="margin: 0 0 15px 0; color: #1e3a5f; font-size: 16px;">Your Login Credentials</h3>
            
            <div style="margin-bottom: 12px;">
              <span style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Email</span>
              <div style="background: white; border: 1px solid #e2e8f0; border-radius: 4px; padding: 10px 12px; margin-top: 4px; font-family: monospace; font-size: 14px;">${email}</div>
            </div>
            
            <div>
              <span style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Temporary Password</span>
              <div style="background: white; border: 1px solid #e2e8f0; border-radius: 4px; padding: 10px 12px; margin-top: 4px; font-family: monospace; font-size: 14px; letter-spacing: 1px;">${password}</div>
            </div>
          </div>
          
          <p style="color: #dc2626; font-size: 14px; margin: 16px 0;">
            <strong>Important:</strong> Please save your password securely. For security reasons, we recommend changing your password after your first login.
          </p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${loginUrl}" style="background: #1e3a5f; color: white; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Access Your Portal</a>
          </div>
          
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
          
          <p style="color: #64748b; font-size: 13px; margin-bottom: 0;">
            If you have any questions or need assistance, please contact your claims representative.
          </p>
        </div>
        
        <div style="text-align: center; padding: 20px; color: #94a3b8; font-size: 12px;">
          <p style="margin: 0;">© ${new Date().getFullYear()} Freedom Claims. All rights reserved.</p>
        </div>
      </body>
      </html>
    `;

    const emailResponse = await resend.emails.send({
      from: "Freedom Claims <claims@freedomclaims.work>",
      to: [email],
      subject: `Your Freedom Claims ${userType} Portal Access`,
      html: htmlContent,
    });

    console.log("Portal invite email sent:", emailResponse);

    return new Response(JSON.stringify({ success: true, data: emailResponse }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  } catch (error: any) {
    console.error("Error sending portal invite:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

Deno.serve(handler);
