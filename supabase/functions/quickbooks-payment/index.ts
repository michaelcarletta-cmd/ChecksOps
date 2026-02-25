
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, accessToken, realmId, paymentData, vendorData, isSandbox = true } = await req.json();
    console.log('QuickBooks payment action:', action, 'sandbox:', isSandbox);

    // Use sandbox URL for testing, production URL for live
    const apiHost = isSandbox 
      ? 'https://sandbox-quickbooks.api.intuit.com' 
      : 'https://quickbooks.api.intuit.com';
    const baseUrl = `${apiHost}/v3/company/${realmId}`;

    if (action === 'create-vendor') {
      // Create a vendor in QuickBooks
      const response = await fetch(`${baseUrl}/vendor`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          DisplayName: vendorData.name,
          PrimaryEmailAddr: vendorData.email ? { Address: vendorData.email } : undefined,
          PrimaryPhone: vendorData.phone ? { FreeFormNumber: vendorData.phone } : undefined,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Create vendor error:', errorText);
        throw new Error(`Failed to create vendor: ${errorText}`);
      }

      const result = await response.json();
      console.log('Vendor created:', result.Vendor?.Id);

      return new Response(JSON.stringify({ 
        success: true, 
        vendor: result.Vendor 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'search-vendor') {
      // Search for existing vendor
      const query = `SELECT * FROM Vendor WHERE DisplayName = '${vendorData.name.replace(/'/g, "\\'")}'`;
      const response = await fetch(`${baseUrl}/query?query=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Search vendor error:', errorText);
        throw new Error(`Failed to search vendor: ${errorText}`);
      }

      const result = await response.json();
      const vendors = result.QueryResponse?.Vendor || [];

      return new Response(JSON.stringify({ 
        success: true, 
        vendors 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'create-bill-payment') {
      // Create a bill payment (pay a vendor)
      const response = await fetch(`${baseUrl}/billpayment`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          VendorRef: {
            value: paymentData.vendorId,
          },
          PayType: paymentData.paymentType || 'Check',
          TotalAmt: paymentData.amount,
          PrivateNote: paymentData.notes || '',
          CheckPayment: paymentData.paymentType === 'Check' ? {
            BankAccountRef: {
              value: paymentData.bankAccountId,
            },
          } : undefined,
          Line: [{
            Amount: paymentData.amount,
            LinkedTxn: paymentData.billId ? [{
              TxnId: paymentData.billId,
              TxnType: 'Bill',
            }] : [],
          }],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Create bill payment error:', errorText);
        throw new Error(`Failed to create bill payment: ${errorText}`);
      }

      const result = await response.json();
      console.log('Bill payment created:', result.BillPayment?.Id);

      return new Response(JSON.stringify({ 
        success: true, 
        payment: result.BillPayment 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'create-check') {
      // Create a check payment directly
      const response = await fetch(`${baseUrl}/purchase`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          PaymentType: 'Check',
          AccountRef: {
            value: paymentData.bankAccountId,
          },
          EntityRef: {
            value: paymentData.vendorId,
            type: 'Vendor',
          },
          TotalAmt: paymentData.amount,
          PrivateNote: paymentData.notes || '',
          Line: [{
            Amount: paymentData.amount,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: {
              AccountRef: {
                value: paymentData.expenseAccountId || '1',
              },
            },
          }],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Create check error:', errorText);
        throw new Error(`Failed to create check: ${errorText}`);
      }

      const result = await response.json();
      console.log('Check created:', result.Purchase?.Id);

      return new Response(JSON.stringify({ 
        success: true, 
        purchase: result.Purchase 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'get-accounts') {
      // Get bank accounts for payment
      const query = "SELECT * FROM Account WHERE AccountType = 'Bank'";
      const response = await fetch(`${baseUrl}/query?query=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Get accounts error:', errorText);
        throw new Error(`Failed to get accounts: ${errorText}`);
      }

      const result = await response.json();
      const accounts = result.QueryResponse?.Account || [];

      return new Response(JSON.stringify({ 
        success: true, 
        accounts 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    throw new Error('Invalid action');
  } catch (error: unknown) {
    console.error('QuickBooks payment error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
