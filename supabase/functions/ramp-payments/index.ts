const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type JsonRecord = Record<string, unknown>;

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[RAMP-PAYMENTS] ${step}${detailsStr}`);
};

const jsonResponse = (status: number, payload: JsonRecord) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Unknown error");

const asArray = <T = JsonRecord>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const cleanObject = <T extends JsonRecord>(obj: T): Partial<T> => {
  const cleaned: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") {
      cleaned[key as keyof T] = value as T[keyof T];
    }
  }
  return cleaned;
};

const getTodayDate = () => new Date().toISOString().slice(0, 10);

const getReceivablesTemplateMeta = () => {
  const template =
    Deno.env.get("RAMP_RECEIVABLES_URL_TEMPLATE") || Deno.env.get("RAMP_PAYMENT_LINK_TEMPLATE") || null;
  const hasTemplate = Boolean(template);
  const hasPlaceholders = hasTemplate ? /\{[a-zA-Z0-9_]+\}/.test(template as string) : false;
  const mode: "missing" | "placeholders" | "query-append" = hasTemplate
    ? hasPlaceholders
      ? "placeholders"
      : "query-append"
    : "missing";

  let host: string | null = null;
  let pathname: string | null = null;
  if (template) {
    try {
      const parsed = new URL(template);
      host = parsed.host;
      pathname = parsed.pathname;
    } catch {
      host = null;
      pathname = null;
    }
  }

  return {
    configured: hasTemplate,
    hasPlaceholders,
    mode,
    host,
    pathname,
  };
};

const getRampToken = async () => {
  const clientId = Deno.env.get("RAMP_CLIENT_ID");
  const clientSecret = Deno.env.get("RAMP_CLIENT_SECRET");
  const scope =
    Deno.env.get("RAMP_SCOPES") || "vendors:read vendors:write bills:write entities:read users:read transfers:read";
  const tokenUrl = Deno.env.get("RAMP_TOKEN_URL") || "https://api.ramp.com/developer/v1/token";

  if (!clientId || !clientSecret) {
    throw new Error("Ramp credentials are missing. Set RAMP_CLIENT_ID and RAMP_CLIENT_SECRET.");
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  if (scope) params.set("scope", scope);

  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to authenticate with Ramp: ${response.status} ${body}`);
  }

  const data = (await response.json()) as JsonRecord;
  const accessToken = typeof data.access_token === "string" ? data.access_token : null;
  if (!accessToken) {
    throw new Error("Ramp token response did not include access_token.");
  }

  return accessToken;
};

const rampRequest = async (
  token: string,
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: Record<string, string | number | boolean | null | undefined>; body?: unknown } = {}
) => {
  const { method = "GET", query, body } = options;
  const url = new URL(`https://api.ramp.com${path}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ramp API ${method} ${path} failed: ${response.status} ${errorText}`);
  }

  if (response.status === 204) return {};
  return await response.json();
};

const getDefaultVendorOwnerId = async (token: string, entityId: string | null) => {
  try {
    const adminUsers = (await rampRequest(token, "/developer/v1/users", {
      query: {
        status: "USER_ACTIVE",
        role: "BUSINESS_ADMIN",
        entity_id: entityId || undefined,
        page_size: 2,
      },
    })) as JsonRecord;

    const adminUser = asArray<JsonRecord>(adminUsers.data)[0];
    if (adminUser && typeof adminUser.id === "string") return adminUser.id;

    const activeUsers = (await rampRequest(token, "/developer/v1/users", {
      query: {
        status: "USER_ACTIVE",
        entity_id: entityId || undefined,
        page_size: 2,
      },
    })) as JsonRecord;

    const activeUser = asArray<JsonRecord>(activeUsers.data)[0];
    return activeUser && typeof activeUser.id === "string" ? activeUser.id : null;
  } catch (error) {
    logStep("Unable to auto-discover Ramp vendor owner", { message: toErrorMessage(error) });
    return null;
  }
};

const getRampDefaults = async (token: string) => {
  const entitiesResponse = (await rampRequest(token, "/developer/v1/entities", {
    query: { page_size: 100 },
  })) as JsonRecord;

  const entities = asArray<JsonRecord>(entitiesResponse.data);
  const configuredEntityId = Deno.env.get("RAMP_ENTITY_ID");
  const configuredBankAccountId = Deno.env.get("RAMP_SOURCE_BANK_ACCOUNT_ID");
  const rawVendorOwnerId = Deno.env.get("RAMP_VENDOR_OWNER_ID") || "";
  // Extract UUID if the value is a full Ramp URL (e.g. https://app.ramp.com/people/all#/d/user/<uuid>)
  const uuidMatch = rawVendorOwnerId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const configuredVendorOwnerId = uuidMatch ? uuidMatch[0] : (rawVendorOwnerId || undefined);

  const selectedEntity =
    entities.find((entity) => entity.id === configuredEntityId) ||
    entities.find((entity) => entity.is_primary === true) ||
    entities[0] ||
    null;

  const entityPaymentAccounts = asArray<JsonRecord>(selectedEntity?.payment_accounts);
  const selectedPaymentAccount =
    entityPaymentAccounts.find((account) => account.id === configuredBankAccountId) || entityPaymentAccounts[0] || null;

  const sourceBankAccountId =
    (typeof selectedPaymentAccount?.id === "string" ? selectedPaymentAccount.id : null) || configuredBankAccountId || null;
  const sourceBankAccountName = typeof selectedPaymentAccount?.account_name === "string" ? selectedPaymentAccount.account_name : null;
  const entityId = typeof selectedEntity?.id === "string" ? selectedEntity.id : configuredEntityId || null;
  const entityName = typeof selectedEntity?.entity_name === "string" ? selectedEntity.entity_name : null;
  const vendorOwnerId = configuredVendorOwnerId || (await getDefaultVendorOwnerId(token, entityId));

  return {
    entityId,
    entityName,
    sourceBankAccountId,
    sourceBankAccountName,
    vendorOwnerId,
    hasBillPayAccount: Boolean(sourceBankAccountId),
  };
};

const createReceivableLink = (params: Record<string, string | number | null | undefined>) => {
  const template =
    Deno.env.get("RAMP_RECEIVABLES_URL_TEMPLATE") || Deno.env.get("RAMP_PAYMENT_LINK_TEMPLATE");

  if (!template) {
    throw new Error(
      "Ramp receivable links are not configured. Set RAMP_RECEIVABLES_URL_TEMPLATE or RAMP_PAYMENT_LINK_TEMPLATE."
    );
  }

  const replacements = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, value === null || value === undefined ? "" : String(value)])
  );

  let url = template;
  let replacedAny = false;

  for (const [key, value] of Object.entries(replacements)) {
    const token = `{${key}}`;
    const encodedValue = encodeURIComponent(value);
    if (url.includes(token)) {
      url = url.split(token).join(encodedValue);
      replacedAny = true;
    }
  }

  if (!replacedAny) {
    const parsed = new URL(template);
    for (const [key, value] of Object.entries(replacements)) {
      if (!value) continue;
      parsed.searchParams.set(key, value);
    }
    url = parsed.toString();
  }

  return url;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const body = (await req.json()) as JsonRecord;
    const action = typeof body.action === "string" ? body.action : "";
    logStep("Action received", { action });

    if (action === "create-receivable-link") {
      const amount = Number(body.amount || 0);
      const link = createReceivableLink({
        amount: amount.toFixed(2),
        invoiceNumber: typeof body.invoiceNumber === "string" ? body.invoiceNumber : "",
        claimNumber: typeof body.claimNumber === "string" ? body.claimNumber : "",
        customerEmail: typeof body.customerEmail === "string" ? body.customerEmail : "",
        customerName: typeof body.customerName === "string" ? body.customerName : "",
        description: typeof body.description === "string" ? body.description : "",
      });

      return jsonResponse(200, { success: true, url: link });
    }

    if (action === "get-integration-status") {
      const hasClientId = Boolean(Deno.env.get("RAMP_CLIENT_ID"));
      const hasClientSecret = Boolean(Deno.env.get("RAMP_CLIENT_SECRET"));
      const configuredEntityId = Deno.env.get("RAMP_ENTITY_ID") || null;
      const configuredSourceBankAccountId = Deno.env.get("RAMP_SOURCE_BANK_ACCOUNT_ID") || null;
      const configuredVendorOwnerId = Deno.env.get("RAMP_VENDOR_OWNER_ID") || null;
      const configuredScopes = Deno.env.get("RAMP_SCOPES") || null;
      const linkTemplate = getReceivablesTemplateMeta();
      const issues: string[] = [];

      if (!hasClientId) issues.push("RAMP_CLIENT_ID is missing");
      if (!hasClientSecret) issues.push("RAMP_CLIENT_SECRET is missing");
      if (!linkTemplate.configured) issues.push("RAMP_RECEIVABLES_URL_TEMPLATE (or fallback template) is missing");

      if (!hasClientId || !hasClientSecret) {
        return jsonResponse(200, {
          success: true,
          healthy: false,
          credentials: {
            clientId: hasClientId,
            clientSecret: hasClientSecret,
          },
          apiAuth: false,
          apiAuthError: "Ramp credentials are incomplete.",
          linkTemplate,
          configuredOverrides: {
            entityId: configuredEntityId,
            sourceBankAccountId: configuredSourceBankAccountId,
            vendorOwnerId: configuredVendorOwnerId,
            scopes: configuredScopes,
          },
          resolvedDefaults: null,
          issues,
        });
      }

      try {
        const token = await getRampToken();
        const defaults = await getRampDefaults(token);

        if (!defaults.entityId) issues.push("No Ramp entity available/resolved");
        if (!defaults.hasBillPayAccount) issues.push("No Ramp bill-pay source bank account resolved");
        if (!defaults.vendorOwnerId) issues.push("No Ramp vendor owner resolved");

        return jsonResponse(200, {
          success: true,
          healthy: issues.length === 0,
          credentials: {
            clientId: hasClientId,
            clientSecret: hasClientSecret,
          },
          apiAuth: true,
          apiAuthError: null,
          linkTemplate,
          configuredOverrides: {
            entityId: configuredEntityId,
            sourceBankAccountId: configuredSourceBankAccountId,
            vendorOwnerId: configuredVendorOwnerId,
            scopes: configuredScopes,
          },
          resolvedDefaults: defaults,
          issues,
        });
      } catch (error) {
        issues.push("Ramp API authentication failed");
        const message = toErrorMessage(error);
        return jsonResponse(200, {
          success: true,
          healthy: false,
          credentials: {
            clientId: hasClientId,
            clientSecret: hasClientSecret,
          },
          apiAuth: false,
          apiAuthError: message,
          linkTemplate,
          configuredOverrides: {
            entityId: configuredEntityId,
            sourceBankAccountId: configuredSourceBankAccountId,
            vendorOwnerId: configuredVendorOwnerId,
            scopes: configuredScopes,
          },
          resolvedDefaults: null,
          issues,
        });
      }
    }

    const token = await getRampToken();

    if (action === "get-default-config") {
      const defaults = await getRampDefaults(token);
      return jsonResponse(200, { success: true, ...defaults });
    }

    if (action === "lookup-user") {
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!email) throw new Error("email is required for user lookup.");
      const usersRes = await rampRequest(token, "/developer/v1/users", { query: {} });
      const users = asArray((usersRes as JsonRecord).data);
      const match = users.find((u: JsonRecord) => (u.email as string)?.toLowerCase() === email.toLowerCase());
      if (match) {
        return jsonResponse(200, { success: true, user: { id: match.id, email: match.email, first_name: match.first_name, last_name: match.last_name, role: match.role } });
      }
      return jsonResponse(200, { success: false, error: `No Ramp user found with email ${email}`, available_users: users.map((u: JsonRecord) => ({ id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name })) });
    }

    if (action === "upsert-vendor") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      const externalVendorId = typeof body.externalVendorId === "string" ? body.externalVendorId.trim() : "";
      const country = typeof body.country === "string" ? body.country.trim() : "US";
      const state = typeof body.state === "string" ? body.state.trim() : "";

      if (!name) throw new Error("Vendor name is required.");
      if (!email) throw new Error("Vendor email is required.");

      if (externalVendorId) {
        const existingVendorsResponse = (await rampRequest(token, "/developer/v1/vendors", {
          query: { external_vendor_id: externalVendorId, page_size: 2 },
        })) as JsonRecord;

        const existingVendor = asArray<JsonRecord>(existingVendorsResponse.data)[0];
        if (existingVendor && typeof existingVendor.id === "string") {
          return jsonResponse(200, {
            success: true,
            existing: true,
            vendorId: existingVendor.id,
            vendor: existingVendor,
          });
        }
      }

      const defaults = await getRampDefaults(token);
      const vendorOwnerId =
        (typeof body.vendorOwnerId === "string" && body.vendorOwnerId) || defaults.vendorOwnerId;

      if (!vendorOwnerId) {
        throw new Error(
          "Could not determine Ramp vendor owner. Set RAMP_VENDOR_OWNER_ID or grant users:read scope."
        );
      }

      const [firstName, ...rest] = name.split(/\s+/);
      const lastName = rest.join(" ");

      const vendorPayload = cleanObject({
        name,
        country,
        state,
        vendor_owner_id: vendorOwnerId,
        external_vendor_id: externalVendorId || undefined,
        request_payment_details: true,
        business_vendor_contacts: [
          cleanObject({
            email,
            phone: phone || undefined,
            first_name: firstName || undefined,
            last_name: lastName || undefined,
          }),
        ],
      });

      const vendor = (await rampRequest(token, "/developer/v1/vendors", {
        method: "POST",
        body: vendorPayload,
      })) as JsonRecord;

      return jsonResponse(200, {
        success: true,
        existing: false,
        vendorId: vendor.id,
        vendor,
      });
    }

    if (action === "get-vendor-accounts") {
      const vendorId = typeof body.vendorId === "string" ? body.vendorId : "";
      if (!vendorId) throw new Error("vendorId is required.");

      const response = (await rampRequest(token, `/developer/v1/vendors/${vendorId}/accounts`, {
        query: { page_size: 100 },
      })) as JsonRecord;
      return jsonResponse(200, { success: true, accounts: asArray(response.data) });
    }

    if (action === "create-bill-payment") {
      const vendorId = typeof body.vendorId === "string" ? body.vendorId : "";
      const amount = Number(body.amount || 0);
      const description = typeof body.description === "string" ? body.description : "";
      const dueDate = typeof body.dueDate === "string" ? body.dueDate : getTodayDate();
      const issuedDate = typeof body.issuedDate === "string" ? body.issuedDate : getTodayDate();
      const invoiceNumber =
        typeof body.invoiceNumber === "string" && body.invoiceNumber
          ? body.invoiceNumber
          : `PAY-${Date.now()}`;
      const requestedPaymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod.toUpperCase() : "";
      const vendorAccountIdInput = typeof body.vendorAccountId === "string" ? body.vendorAccountId : "";

      if (!vendorId) throw new Error("vendorId is required.");
      if (!amount || amount <= 0) throw new Error("amount must be greater than 0.");

      const defaults = await getRampDefaults(token);
      const entityId = (typeof body.entityId === "string" && body.entityId) || defaults.entityId;
      const sourceBankAccountId =
        (typeof body.sourceBankAccountId === "string" && body.sourceBankAccountId) || defaults.sourceBankAccountId;

      if (!entityId) throw new Error("No Ramp entity configured. Set RAMP_ENTITY_ID or enable entities:read.");
      if (!sourceBankAccountId) {
        throw new Error("No Ramp bill-pay bank account configured. Set RAMP_SOURCE_BANK_ACCOUNT_ID.");
      }

      let paymentMethod: "ACH" | "CHECK";
      if (requestedPaymentMethod === "ACH" || requestedPaymentMethod === "CHECK") {
        paymentMethod = requestedPaymentMethod;
      } else {
        paymentMethod = vendorAccountIdInput ? "ACH" : "CHECK";
      }

      let vendorAccountId = vendorAccountIdInput;
      if (paymentMethod === "ACH" && !vendorAccountId) {
        const accountsResponse = (await rampRequest(token, `/developer/v1/vendors/${vendorId}/accounts`, {
          query: { page_size: 100 },
        })) as JsonRecord;
        const firstAccount = asArray<JsonRecord>(accountsResponse.data)[0];
        vendorAccountId = typeof firstAccount?.id === "string" ? firstAccount.id : "";
      }

      if (paymentMethod === "ACH" && !vendorAccountId) {
        throw new Error("Vendor does not have a Ramp bank account. Add one in Ramp or use CHECK.");
      }

      const paymentDetails =
        paymentMethod === "ACH"
          ? {
              payment_arrival_date: dueDate,
              source_bank_account_id: sourceBankAccountId,
              vendor_account_id: vendorAccountId,
            }
          : {
              payment_arrival_date: dueDate,
              source_bank_account_id: sourceBankAccountId,
            };

      const billPayload = cleanObject({
        due_at: dueDate,
        issued_at: issuedDate,
        entity_id: entityId,
        vendor_id: vendorId,
        invoice_currency: "USD",
        invoice_number: invoiceNumber,
        payment_method: paymentMethod,
        payment_details: paymentDetails,
        memo: description || undefined,
        line_items: [
          cleanObject({
            amount,
            memo: description || undefined,
          }),
        ],
        use_default_vendor_contact: true,
      });

      const bill = (await rampRequest(token, "/developer/v1/bills", {
        method: "POST",
        body: billPayload,
      })) as JsonRecord;

      return jsonResponse(200, {
        success: true,
        billId: bill.id,
        bill,
        status: bill.status,
        deepLinkUrl: bill.deep_link_url,
        paymentMethod,
      });
    }

    if (action === "list-transfers") {
      const transfersResponse = (await rampRequest(token, "/developer/v1/transfers", {
        query: {
          entity_id: typeof body.entityId === "string" ? body.entityId : undefined,
          status: typeof body.status === "string" ? body.status : undefined,
          from_date: typeof body.fromDate === "string" ? body.fromDate : undefined,
          to_date: typeof body.toDate === "string" ? body.toDate : undefined,
          page_size: typeof body.pageSize === "number" ? body.pageSize : 50,
        },
      })) as JsonRecord;

      return jsonResponse(200, {
        success: true,
        transfers: asArray(transfersResponse.data),
        page: transfersResponse.page || null,
      });
    }

    throw new Error("Invalid action");
  } catch (error: unknown) {
    const message = toErrorMessage(error);
    logStep("ERROR", { message });
    return jsonResponse(500, { success: false, error: message });
  }
});
