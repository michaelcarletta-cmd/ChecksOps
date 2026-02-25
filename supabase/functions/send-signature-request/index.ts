import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendMailjetEmail(to: string, subject: string, htmlContent: string) {
  const apiKey = Deno.env.get("MAILJET_API_KEY");
  const secretKey = Deno.env.get("MAILJET_SECRET_KEY");
  
  const response = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${btoa(`${apiKey}:${secretKey}`)}`,
    },
    body: JSON.stringify({
      Messages: [
        {
          From: {
            Email: "claims@freedomclaims.work",
            Name: "Freedom Claims"
          },
          To: [
            {
              Email: to
            }
          ],
          Subject: subject,
          HTMLPart: htmlContent
        }
      ]
    }),
  });

  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(`Mailjet error: ${JSON.stringify(result)}`);
  }
  
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { requestId } = await req.json();

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Fetch signature request with signers
    const { data: request, error: requestError } = await supabaseClient
      .from("signature_requests")
      .select(`
        *,
        signature_signers(*),
        claims(claim_number, policyholder_name)
      `)
      .eq("id", requestId)
      .single();

    if (requestError) throw requestError;

    // Send email to each signer
    const appUrl = Deno.env.get("SUPABASE_URL")?.replace("supabase.co", "lovable.app") || "http://localhost:5173";
    
    for (const signer of request.signature_signers) {
      const signUrl = `${appUrl}/sign?token=${signer.access_token}`;
      
      console.log(`Sending signature request to ${signer.signer_email}`);
      console.log(`Sign URL: ${signUrl}`);
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">📝 Signature Required</h1>
          </div>
          
          <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
            <p style="font-size: 16px; color: #333; margin-bottom: 20px;">Hello <strong>${signer.signer_name}</strong>,</p>
            
            <p style="font-size: 16px; color: #333; margin-bottom: 25px;">
              You have been requested to electronically sign a document. This will only take a moment.
            </p>
            
            <div style="background: white; border-left: 4px solid #667eea; padding: 20px; margin: 25px 0; border-radius: 5px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
              <p style="margin: 8px 0; color: #555;"><strong style="color: #333;">📋 Claim Number:</strong> ${request.claims.claim_number}</p>
              <p style="margin: 8px 0; color: #555;"><strong style="color: #333;">📄 Document:</strong> ${request.document_name}</p>
              <p style="margin: 8px 0; color: #555;"><strong style="color: #333;">👤 Policyholder:</strong> ${request.claims.policyholder_name}</p>
            </div>
            
            <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 15px; margin: 25px 0;">
              <p style="margin: 0; color: #856404; font-weight: bold;">⚠️ What You Need to Do:</p>
              <p style="margin: 10px 0 0 0; color: #856404;">Click the button below to review the document and add your signature using your mouse or touchscreen.</p>
            </div>

            <div style="text-align: center; margin: 35px 0;">
              <a href="${signUrl}" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; 
                        padding: 16px 40px; 
                        text-decoration: none; 
                        border-radius: 50px; 
                        display: inline-block; 
                        font-size: 18px; 
                        font-weight: bold;
                        box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
                        transition: transform 0.2s;">
                ✍️ Click Here to Sign Document
              </a>
            </div>
            
            <div style="background: #e9ecef; padding: 15px; border-radius: 5px; margin: 25px 0;">
              <p style="margin: 0; font-size: 13px; color: #666;">
                <strong>Can't click the button?</strong> Copy and paste this link into your browser:
              </p>
              <p style="margin: 10px 0 0 0;">
                <a href="${signUrl}" style="color: #667eea; word-break: break-all; font-size: 12px;">${signUrl}</a>
              </p>
            </div>
            
            <div style="border-top: 2px solid #dee2e6; margin-top: 30px; padding-top: 20px;">
              <p style="color: #6c757d; font-size: 13px; margin: 5px 0;">
                📧 Questions? Contact Freedom Claims support
              </p>
              <p style="color: #adb5bd; font-size: 11px; margin: 15px 0 0 0;">
                This is an automated message from Freedom Claims. Please do not reply to this email.
              </p>
            </div>
          </div>
        </div>
      `;

      const emailResponse = await sendMailjetEmail(
        signer.signer_email,
        `🔔 Action Required: Sign ${request.document_name}`,
        htmlContent
      );

      console.log(`Email sent to ${signer.signer_email}:`, emailResponse);
    }

    return new Response(
      JSON.stringify({ success: true, signersNotified: request.signature_signers.length }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error sending signature request:", error);
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
