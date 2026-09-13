import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller } from "../_shared/moovGuard.ts";
import { capabilitiesStillNeeded } from "../_shared/moovReadiness.ts";

// In-app onboarding for a tenant's own connected payment account.
//
// The provider's hosted onboarding page always tries to register a BRAND NEW
// login, which fails ("Failed to register user") for accounts ChecksOps already
// created by API. So every onboarding detail — business profile, controller and
// owners — is collected in ChecksOps and written straight to the provider.

const BUSINESS_TYPES = [
  "soleProprietorship",
  "unincorporatedAssociation",
  "trust",
  "llc",
  "publicCorporation",
  "privateCorporation",
  "partnership",
  "unincorporatedNonProfit",
  "incorporatedNonProfit",
];

const str = (v: unknown, max = 200) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const digits = (v: unknown, max = 20) =>
  typeof v === "string" || typeof v === "number"
    ? String(v).replace(/\D/g, "").slice(0, max) || null
    : null;

interface AddressInput {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
}

function normalizeAddress(a: AddressInput | undefined | null) {
  if (!a) return null;
  const line1 = str(a.addressLine1, 100);
  const city = str(a.city, 60);
  const state = str(a.stateOrProvince, 2);
  const postal = digits(a.postalCode, 5);
  if (!line1 || !city || !state || !postal) return null;
  return {
    addressLine1: line1,
    ...(str(a.addressLine2, 100) ? { addressLine2: str(a.addressLine2, 100) } : {}),
    city,
    stateOrProvince: state.toUpperCase(),
    postalCode: postal,
    country: "US",
  };
}

interface RepresentativeInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  ssn?: string;
  birthDate?: string; // YYYY-MM-DD
  address?: AddressInput;
  isController?: boolean;
  isOwner?: boolean;
  ownershipPercentage?: number;
}

function buildRepresentative(rep: RepresentativeInput) {
  const firstName = str(rep.firstName, 60);
  const lastName = str(rep.lastName, 60);
  if (!firstName || !lastName) throw new Error("Each person needs a first and last name.");

  const address = normalizeAddress(rep.address);
  if (!address) throw new Error(`Provide a full home address for ${firstName} ${lastName}.`);

  const ssn = digits(rep.ssn, 9);
  if (!ssn || ssn.length !== 9) {
    throw new Error(`Provide a valid 9-digit SSN for ${firstName} ${lastName}.`);
  }

  const dob = str(rep.birthDate, 10);
  const m = dob?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Provide a date of birth for ${firstName} ${lastName}.`);

  const phone = digits(rep.phone, 10);
  const pct = Number(rep.ownershipPercentage ?? 0);

  return {
    name: { firstName, lastName },
    email: str(rep.email, 120) ?? undefined,
    ...(phone ? { phone: { number: phone, countryCode: "1" } } : {}),
    address,
    birthDate: { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
    governmentID: { ssn: { full: ssn } },
    responsibilities: {
      isController: !!rep.isController,
      isOwner: !!rep.isOwner,
      ...(rep.isOwner && pct > 0 ? { ownershipPercentage: Math.min(100, Math.round(pct)) } : {}),
      jobTitle: str(rep.jobTitle, 60) ?? "Owner",
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const payload = await req.json();
    const tenant_id = str(payload?.tenant_id, 64);
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("id, provider_account_id")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const accountId = account?.provider_account_id as string | undefined;
    if (!accountId) return json({ error: "Create the payment account first." }, 409);

    /* ---------- business profile ---------- */
    const b = payload?.business ?? {};
    const legalBusinessName = str(b.legalBusinessName, 120);
    if (!legalBusinessName) return json({ error: "Legal business name is required." }, 400);

    const businessType = str(b.businessType, 40);
    if (!businessType || !BUSINESS_TYPES.includes(businessType)) {
      return json({ error: "Choose a valid business type." }, 400);
    }

    const address = normalizeAddress(b.address);
    if (!address) return json({ error: "Provide a complete business address." }, 400);

    const phone = digits(b.phone, 10);
    if (!phone || phone.length !== 10) return json({ error: "Provide a 10-digit business phone." }, 400);

    const email = str(b.email, 120);
    if (!email || !email.includes("@")) return json({ error: "Provide a business email." }, 400);

    const ein = digits(b.ein, 9);
    if (businessType !== "soleProprietorship" && (!ein || ein.length !== 9)) {
      return json({ error: "Provide a valid 9-digit EIN." }, 400);
    }

    const website = str(b.website, 200);
    const description = str(b.description, 300);
    if (!website && !description) {
      return json({ error: "Provide a website or a short business description." }, 400);
    }

    const businessProfile: Record<string, unknown> = {
      legalBusinessName,
      ...(str(b.doingBusinessAs, 120) ? { doingBusinessAs: str(b.doingBusinessAs, 120) } : {}),
      businessType,
      address,
      phone: { number: phone, countryCode: "1" },
      email,
      ...(website ? { website: website.startsWith("http") ? website : `https://${website}` } : {}),
      ...(description ? { description } : {}),
      ...(ein && ein.length === 9 ? { taxID: { ein: { number: ein } } } : {}),
    };

    /* ---------- validate controller + owners BEFORE any provider write ---------- */
    const repsInput: RepresentativeInput[] = Array.isArray(payload?.representatives)
      ? payload.representatives.slice(0, 6)
      : [];

    if (repsInput.length > 0 && !repsInput.some((r) => r.isController)) {
      return json({ error: "One person must be marked as the controller." }, 400);
    }
    const repBodies = repsInput.map((rep) => buildRepresentative(rep));

    /* ---------- write business profile ---------- */
    await moovFetch(`/accounts/${accountId}`, {
      method: "PATCH",
      scopes: scopes.accountWrite(accountId),
      body: { profile: { business: businessProfile } },
    });

    let repsCreated = 0;
    if (repBodies.length > 0) {
      const existing = await moovFetch<any[]>(`/accounts/${accountId}/representatives`, {
        scopes: scopes.representativesRead(accountId),
      }).catch(() => [] as any[]);
      const known = new Set(
        (existing ?? []).map((r: any) =>
          `${r?.name?.firstName ?? ""} ${r?.name?.lastName ?? ""}`.trim().toLowerCase()
        ),
      );

      for (const body of repBodies) {
        const key = `${body.name.firstName} ${body.name.lastName}`.toLowerCase();
        if (known.has(key)) continue;

        await moovFetch(`/accounts/${accountId}/representatives`, {
          method: "POST",
          scopes: scopes.representativesWrite(accountId),
          body,
        });
        repsCreated += 1;
      }

      // Tells the provider the ownership disclosure is complete, which is what
      // clears the "business.owners" requirement.
      if (payload?.ownersProvided !== false) {
        await moovFetch(`/accounts/${accountId}`, {
          method: "PATCH",
          scopes: scopes.accountWrite(accountId),
          body: { profile: { business: { ownersProvided: true } } },
        }).catch((e) => console.error("[moov-account-onboard] ownersProvided", (e as Error).message));
      }
    }

    /* ---------- request only capabilities that are truly absent ---------- */
    // Family match (`send-funds` satisfies `send-funds.ach`) must never re-POST.
    // Re-requesting an already-approved family re-opens billed KYC/KYB.
    const existingCaps = await moovFetch<any[]>(`/accounts/${accountId}/capabilities`, {
      scopes: scopes.capabilitiesRead(accountId),
    }).catch(() => null);
    if (!existingCaps) {
      console.warn("[moov-account-onboard] skip capability POST; capability GET failed (fail closed, no re-KYC)");
    } else {
      const wantedCaps = ["transfers", "send-funds", "wallet", "send-funds.ach"];
      const missingCaps = capabilitiesStillNeeded(existingCaps, wantedCaps);
      if (missingCaps.length > 0) {
        await moovFetch(`/accounts/${accountId}/capabilities`, {
          method: "POST",
          scopes: scopes.capabilitiesWrite(accountId),
          body: { capabilities: missingCaps },
        }).catch((e) => console.error("[moov-account-onboard] capabilities", (e as Error).message));
      } else {
        console.log("[moov-account-onboard] skip capability POST; families already present");
      }
    }

    await supabase
      .from("payment_provider_accounts")
      .update({ onboarding_status: "verification_pending", last_synced_at: new Date().toISOString() })
      .eq("id", account.id);

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "payment_account.onboarding_submitted",
      environment,
      provider_metadata: { account_id: accountId, representatives_added: repsCreated, by: userId },
    });

    return json({ success: true, representatives_added: repsCreated });
  } catch (e) {
    const message = (e as Error).message ?? "Onboarding failed";
    console.error("[moov-account-onboard]", message);
    return json({ error: message }, 400);
  }
});
