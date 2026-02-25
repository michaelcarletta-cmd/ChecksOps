
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const API_KEY = Deno.env.get('ONLINE_CHECK_WRITER_API_KEY');
// Production: https://app.onlinecheckwriter.com/api/v3
// Sandbox: https://test.onlinecheckwriter.com/api/v3
const API_BASE_URL = 'https://app.onlinecheckwriter.com/api/v3';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, checkData } = await req.json();
    console.log('Online Check Writer action:', action);

    if (!API_KEY) {
      throw new Error('Online Check Writer API key not configured');
    }

    const headers = {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (action === 'create-check') {
      // Create a check using QuickPay API
      const response = await fetch(`${API_BASE_URL}/quickpay/check`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: {
            accountType: 'bankaccount',
            accountId: checkData.bankAccountId,
          },
          destination: {
            name: checkData.payeeName,
            company: checkData.company || '',
            email: checkData.email || '',
            phone: checkData.phone || '',
            address1: checkData.address1 || '',
            address2: checkData.address2 || '',
            city: checkData.city || '',
            state: checkData.state || '',
            zip: checkData.zip || '',
          },
          payment_details: {
            amount: checkData.amount,
            memo: checkData.memo || '',
            note: checkData.note || '',
            issueDate: checkData.date || new Date().toISOString().split('T')[0],
            referenceID: checkData.referenceId || '',
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Create check error:', errorText);
        throw new Error(`Failed to create check: ${errorText}`);
      }

      const result = await response.json();
      console.log('Check created:', result);

      return new Response(JSON.stringify({ 
        success: true, 
        checkId: result.data?.checkId || result.checkId,
        data: result 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'mail-check') {
      // Mail a physical check using QuickPay Mail Check API
      const response = await fetch(`${API_BASE_URL}/quickpay/mailcheck`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: {
            accountType: 'bankaccount',
            accountId: checkData.bankAccountId,
          },
          destination: {
            name: checkData.payeeName,
            company: checkData.company || '',
            address1: checkData.address1,
            address2: checkData.address2 || '',
            city: checkData.city,
            state: checkData.state,
            zip: checkData.zip,
          },
          payment_details: {
            amount: checkData.amount,
            memo: checkData.memo || '',
            note: checkData.note || '',
            issueDate: checkData.date || new Date().toISOString().split('T')[0],
          },
          shipping: {
            method: checkData.shippingMethod || 'usps_first_class',
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Mail check error:', errorText);
        throw new Error(`Failed to mail check: ${errorText}`);
      }

      const result = await response.json();
      console.log('Check mailed:', result);

      return new Response(JSON.stringify({ 
        success: true, 
        data: result 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'email-check') {
      // Email check: First create the check, then send it via email
      // Step 1: Create the check
      console.log('Creating check for email delivery...');
      const createResponse = await fetch(`${API_BASE_URL}/quickpay/check`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: {
            accountType: 'bankaccount',
            accountId: checkData.bankAccountId,
          },
          destination: {
            name: checkData.payeeName,
            company: checkData.company || '',
            email: checkData.email,
            phone: checkData.phone || '',
            address1: checkData.address1 || '',
            address2: checkData.address2 || '',
            city: checkData.city || '',
            state: checkData.state || '',
            zip: checkData.zip || '',
          },
          payment_details: {
            amount: checkData.amount,
            memo: checkData.memo || '',
            note: checkData.note || '',
            issueDate: checkData.date || new Date().toISOString().split('T')[0],
          },
        }),
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        console.error('Create check for email error:', errorText);
        throw new Error(`Failed to create check: ${errorText}`);
      }

      const createResult = await createResponse.json();
      const checkId = createResult.data?.checkId || createResult.checkId;
      console.log('Check created with ID:', checkId);

      // Step 2: Send the check via email using the check's email endpoint
      const emailResponse = await fetch(`${API_BASE_URL}/check/${checkId}/email`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: checkData.email,
          message: checkData.message || 'Please find your check attached.',
        }),
      });

      if (!emailResponse.ok) {
        const errorText = await emailResponse.text();
        console.error('Email check delivery error:', errorText);
        // Check was created but email failed - return partial success
        return new Response(JSON.stringify({ 
          success: true,
          partial: true,
          checkId: checkId,
          message: `Check created (ID: ${checkId}) but email delivery failed. Please send manually from Online Check Writer dashboard.`,
          data: createResult 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const emailResult = await emailResponse.json();
      console.log('Check emailed successfully:', emailResult);

      return new Response(JSON.stringify({ 
        success: true, 
        checkId: checkId,
        data: emailResult 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'print-check') {
      // Create a printable check (same as create-check, returns check data for printing)
      const response = await fetch(`${API_BASE_URL}/quickpay/check`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: {
            accountType: 'bankaccount',
            accountId: checkData.bankAccountId,
          },
          destination: {
            name: checkData.payeeName,
            company: checkData.company || '',
          },
          payment_details: {
            amount: checkData.amount,
            memo: checkData.memo || '',
            issueDate: checkData.date || new Date().toISOString().split('T')[0],
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Print check error:', errorText);
        throw new Error(`Failed to create printable check: ${errorText}`);
      }

      const result = await response.json();
      console.log('Printable check created:', result);

      return new Response(JSON.stringify({ 
        success: true, 
        checkId: result.data?.checkId || result.checkId,
        data: result
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    throw new Error('Invalid action. Supported actions: create-check, mail-check, email-check, print-check');
  } catch (error: unknown) {
    console.error('Online Check Writer error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
