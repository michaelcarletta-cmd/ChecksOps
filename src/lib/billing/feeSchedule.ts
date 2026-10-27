/**
 * The fees a tenant may be charged, for the Usage settings page. The rates come
 * from the tenant row (set by the platform owner in Tenant Management; a blank
 * rate means the default applies) and match what the billing engine and SQL 120
 * charge. Labels never name a payment or deposit provider.
 */

export interface TenantFeeRates {
  monthly_rate_cents?: number | null;
  referral_discount_cents?: number | null;
  per_check_billing_enabled?: boolean | null;
  per_check_rate_cents?: number | null;
  next_day_rate_cents?: number | null;
  same_day_rate_cents?: number | null;
  mortgage_ops_initial_rate_cents?: number | null;
  mortgage_ops_additional_rate_cents?: number | null;
}

export interface FeeScheduleRow {
  key: string;
  fee: string;
  when: string;
  amount_cents: number | null;
}

// The billing engine's defaults (tenant-billing-engine.mjs, SQL 120 aws_send_speed_fee_cents).
export const DEFAULT_NEXT_DAY_RATE_CENTS = 75;
export const DEFAULT_SAME_DAY_RATE_CENTS = 100;
export const DEFAULT_MORTGAGE_INITIAL_RATE_CENTS = 1000;
export const DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS = 500;

const rate = (value: number | null | undefined, fallback: number): number => {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? fallback : Math.max(0, Math.round(n));
};

/**
 * The per-check price: the tenant's own rate when per-check billing is on, else
 * the platform default, which a tenant cannot read directly; `chargedCheckCents`
 * is the price on the tenant's latest check processing charge, when there is one.
 */
export function checkProcessingCents(rates: TenantFeeRates | null | undefined, chargedCheckCents?: number | null): number | null {
  if (rates?.per_check_billing_enabled && rates.per_check_rate_cents !== null && rates.per_check_rate_cents !== undefined) {
    return rate(rates.per_check_rate_cents, 0);
  }
  return chargedCheckCents === null || chargedCheckCents === undefined ? null : rate(chargedCheckCents, 0);
}

export function feeScheduleRows(rates: TenantFeeRates | null | undefined, chargedCheckCents?: number | null): FeeScheduleRow[] {
  const monthly = rates?.monthly_rate_cents;
  const discount = rate(rates?.referral_discount_cents, 0);
  const rows: FeeScheduleRow[] = [];
  if (monthly !== null && monthly !== undefined) {
    rows.push({
      key: "monthly",
      fee: "Monthly maintenance",
      when: discount > 0 ? "Once a month, less your discount" : "Once a month",
      amount_cents: Math.max(0, rate(monthly, 0) - discount),
    });
  }
  rows.push(
    {
      key: "check_processing",
      fee: "Check processing",
      when: "Each check approved for deposit",
      amount_cents: checkProcessingCents(rates, chargedCheckCents),
    },
    {
      key: "next_day",
      fee: "Next-day payment",
      when: "Each payee paid next day, per claim check (not charged if the payment fails)",
      amount_cents: rate(rates?.next_day_rate_cents, DEFAULT_NEXT_DAY_RATE_CENTS),
    },
    {
      key: "same_day",
      fee: "Same-day payment",
      when: "Each payee paid same day, per claim check (not charged if the payment fails)",
      amount_cents: rate(rates?.same_day_rate_cents, DEFAULT_SAME_DAY_RATE_CENTS),
    },
    {
      key: "mortgage_initial",
      fee: "Mortgage handling",
      when: "When the Mortgage Desk accepts a request",
      amount_cents: rate(rates?.mortgage_ops_initial_rate_cents, DEFAULT_MORTGAGE_INITIAL_RATE_CENTS),
    },
    {
      key: "mortgage_additional",
      fee: "Mortgage handling, additional check",
      when: "Each additional check on the same request",
      amount_cents: rate(rates?.mortgage_ops_additional_rate_cents, DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS),
    },
  );
  return rows;
}
