import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, Download, Info, RotateCcw } from "lucide-react";
import { NumberField, StatTile } from "./NumberField";
import { money, pct } from "@/lib/financial/model";
import {
  DEFAULT_SAVINGS,
  IINK_ANNUAL_DISCOUNT_PCT,
  IINK_COMMITMENT_NOTE,
  IINK_FEATURE_ROWS,
  IINK_PRICING_CAPTURED,
  IINK_PRICING_SOURCE,
  IINK_TIERS,
  SENSITIVITY_VOLUMES,
  SavingsInputs,
  computeSavings,
  computeSavingsPayback,
  effectiveChecks,
  priceRatesFrom,
  referralCredit,
} from "@/lib/financial/iink";
import {
  COST_PER_JOB_NOTE,
  workflowPriceComponents,
  workflowVolumes,
} from "@/lib/financial/workflows";
import { PricingOptimizer } from "./PricingOptimizer";
import { downloadCsv } from "@/lib/financial/csv";

const CHART_AXIS = "hsl(var(--muted-foreground))";

export function SavingsCalculator({ presentation }: { presentation: boolean }) {
  const [i, setI] = useState<SavingsInputs>(DEFAULT_SAVINGS);

  const set = <K extends keyof SavingsInputs>(key: K) => (v: number) =>
    setI((prev) => ({ ...prev, [key]: v }));

  const checks = useMemo(() => effectiveChecks(i), [i]);
  const vol = useMemo(() => workflowVolumes(i), [i]);
  const workflows = useMemo(() => workflowPriceComponents(i, priceRatesFrom(i)), [i]);
  const weightedPerJobCost = useMemo(
    () => workflows.reduce((a, w) => a + w.share * w.total, 0),
    [workflows],
  );
  const r = useMemo(() => computeSavings(i), [i]);
  const payback = useMemo(() => computeSavingsPayback(i, 24), [i]);
  const best = r.best;

  const sensitivity = useMemo(
    () =>
      SENSITIVITY_VOLUMES.map((n) => {
        const row = computeSavings(i, n);
        return {
          checks: n,
          label: `${n}`,
          checksOps: row.checksOps.total,
          bestTier: row.best?.tier.label ?? "None eligible",
          iink: row.best?.cost.total ?? 0,
          savings: row.best ? row.best.cost.total - row.checksOps.total : 0,
        };
      }),
    [i],
  );

  const exportCsv = () =>
    downloadCsv("checksops-vs-iink.csv", [
      [`iink pricing source: ${IINK_PRICING_SOURCE} (captured ${IINK_PRICING_CAPTURED})`],
      [],
      ["Prospect profile"],
      ["Jobs / transactions per month", vol.jobs],
      ["Processed checks / month", checks],
      ["Same-day payouts / month", i.sameDayPayoutsPerMonth],
      ["Next-day payouts / month", i.nextDayPayoutsPerMonth],
      ["Received funds / month", i.receiveOnlyPerMonth],
      ["RTP / instant payments / month", i.rtpPerMonth],
      ["Wallet transfers / month", i.walletPerMonth],
      ["Average check amount", i.avgCheckAmount],
      ["% checks with mortgage payee", i.mortgagePctOfChecks],
      ["Avg mortgage companies on those checks", i.avgMortgageCompanies],
      ["Avg RTP transfer amount", i.avgRtpTransferAmount],
      ["Avg mortgage checks per claim", i.avgMortgageChecksPerClaim],
      [],
      ["Cost per job / transaction by workflow"],
      ["Workflow", "Share %", "Jobs / mo", "Check processing", "ACH", "RTP", "Wallet", "Total / job", "Monthly"],
      ...workflows.map((w) => [
        w.label,
        (w.share * 100).toFixed(1),
        w.jobs,
        w.checkProcessing,
        w.ach,
        w.rtp,
        w.wallet,
        w.total,
        w.total * w.jobs,
      ]),
      ["Weighted variable fee / job", weightedPerJobCost],
      ["Effective all-in cost / job", r.checksOps.costPerJob],
      ["iink billing term", i.iinkAnnualBilling ? "Annual (10% off)" : "Monthly"],
      [],
      [
        "Plan",
        "Eligible",
        "Subscription",
        "Overage checks",
        "Disbursement / RTP",
        "Other recurring",
        "Credits",
        "Processing subtotal",
        "Mortgage fees",
        "Total / mo",
        "Cost per job",
        "Cost per check",
        "Monthly savings vs ChecksOps",
        "Annual savings",
        "% lower",
        "Break-even checks/mo",
      ],
      [
        "ChecksOps",
        "Yes",
        r.checksOps.subscription,
        r.checksOps.perCheck,
        r.checksOps.disbursement,
        r.checksOps.otherRecurring,
        -r.checksOps.credits,
        r.checksOps.processingTotal,
        r.checksOps.mortgageTotal,
        r.checksOps.total,
        r.checksOps.costPerJob,
        r.checksOps.costPerCheck,
        "",
        "",
        "",
        "",
      ],
      ...r.tiers.map((t) => [
        `iink ${t.tier.label}`,
        t.eligible ? "Yes" : `No — deposit limit ${t.tier.depositLimit}`,
        t.cost.subscription,
        t.cost.perCheck,
        t.cost.disbursement,
        t.cost.otherRecurring,
        0,
        t.cost.processingTotal,
        t.cost.mortgageTotal,
        t.cost.total,
        t.cost.costPerJob,
        t.cost.costPerCheck,
        t.monthlySavings,
        t.annualSavings,
        t.savingsPct.toFixed(1),
        t.breakEvenChecks ?? "Not within 2,000",
      ]),
      [],
      ["Volume sensitivity"],
      ["Checks / mo", "ChecksOps", "Best eligible iink tier", "iink cost", "Savings"],
      ...sensitivity.map((s) => [s.checks, s.checksOps, s.bestTier, s.iink, s.savings]),
      [],
      ["One-time ChecksOps setup fee", payback.setupFee],
      ["Payback month", payback.paybackMonth ?? "Not within 24 months"],
      ["2-year net savings after setup fee", payback.twoYearNetSavings],
    ]);

  return (
    <div className="space-y-4">
      {/* Sales headline */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Estimated monthly savings"
          value={best ? money(best.monthlySavings) : "—"}
          sub={best ? `vs iink ${best.tier.label} · ${pct(best.savingsPct)} lower` : "No eligible iink plan"}
          tone={best && best.monthlySavings >= 0 ? "positive" : "negative"}
        />
        <StatTile
          label="Estimated annual savings"
          value={best ? money(best.annualSavings) : "—"}
          sub={best ? `${money(r.checksOps.costPerJob, 2)} vs ${money(best.cost.costPerJob, 2)} per job / transaction` : "—"}
          tone={best && best.annualSavings >= 0 ? "positive" : "negative"}
        />
        <StatTile
          label="Break-even volume"
          value={
            best
              ? best.breakEvenChecks
                ? `${best.breakEvenChecks} checks/mo`
                : "Not within 2,000"
              : "—"
          }
          sub={best ? `ChecksOps is cheaper from here vs ${best.tier.label}` : "—"}
        />
      </div>

      {r.noEligibleTier && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="text-sm">No published iink plan supports this check size</AlertTitle>
          <AlertDescription className="text-xs">
            An average check of {money(i.avgCheckAmount)} exceeds every published per-check deposit limit
            (max $1M on Premium). iink would require enterprise pricing — the comparison below is
            directional only.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button size="sm" variant="ghost" onClick={() => setI(DEFAULT_SAVINGS)}>
          <RotateCcw className="mr-1 h-4 w-4" /> Reset
        </Button>
        <Button size="sm" variant="outline" onClick={exportCsv}>
          <Download className="mr-1 h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {!presentation && (
          <div className="space-y-4 print:hidden">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Prospect profile</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField
                  label="Avg check amount"
                  prefix="$"
                  step={1000}
                  value={i.avgCheckAmount}
                  onChange={set("avgCheckAmount")}
                  hint="Drives iink's 1% mortgage fee and plan deposit-limit eligibility."
                />
                <NumberField
                  label="Checks with mortgage payee"
                  suffix="%"
                  max={100}
                  step={5}
                  value={i.mortgagePctOfChecks}
                  onChange={set("mortgagePctOfChecks")}
                  hint="Share of monthly checks that need loss-draft handling."
                />
                <NumberField
                  label="Mortgage companies / check"
                  step={0.5}
                  value={i.avgMortgageCompanies}
                  onChange={set("avgMortgageCompanies")}
                  hint="iink charges $15 for each mortgage company beyond the first."
                />
                <NumberField
                  label="Mortgage checks / claim"
                  step={0.5}
                  value={i.avgMortgageChecksPerClaim}
                  onChange={set("avgMortgageChecksPerClaim")}
                  hint="ChecksOps bills $10 for the first mortgage check on a claim and $5 for each additional check on that claim."
                />
                <NumberField
                  label="Avg RTP transfer"
                  prefix="$"
                  step={500}
                  value={i.avgRtpTransferAmount}
                  onChange={set("avgRtpTransferAmount")}
                  hint="Drives both the ChecksOps 0.95% (max $5) fee and iink's % RTP rate."
                />
                <div className="col-span-2 flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2.5">
                  <Label htmlFor="uses-mortgage" className="text-xs text-muted-foreground">
                    Uses mortgage / loss-draft services
                  </Label>
                  <Switch
                    id="uses-mortgage"
                    checked={i.usesMortgageServices}
                    onCheckedChange={(v) => setI((prev) => ({ ...prev, usesMortgageServices: v }))}
                  />
                </div>

              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Workflow / transaction mix</CardTitle>
                <CardDescription className="text-xs">
                  Not every job is a processed check. Set the share of monthly jobs by workflow — processed
                  checks, ACH, RTP and wallet volume are all derived from this mix.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2.5">
                  <Label htmlFor="use-workflow-mix" className="text-xs text-muted-foreground">
                    Use workflow mix
                  </Label>
                  <Switch
                    id="use-workflow-mix"
                    checked={i.useWorkflowMix}
                    onCheckedChange={(v) => setI((prev) => ({ ...prev, useWorkflowMix: v }))}
                  />
                </div>

                {i.useWorkflowMix ? (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <NumberField
                        label="Jobs / transactions per mo"
                        value={i.jobsPerMonth}
                        onChange={set("jobsPerMonth")}
                        hint="Every payment event the tenant runs through ChecksOps, however we are involved."
                      />
                      <NumberField
                        label="Payouts sent same-day"
                        suffix="%"
                        max={100}
                        step={5}
                        value={i.pctPayoutsSameDay}
                        onChange={set("pctPayoutsSameDay")}
                        hint="Split of ACH payouts between the same-day and next-day rate."
                      />
                      <NumberField
                        label="Check + 1 ACH"
                        suffix="%"
                        max={100}
                        step={5}
                        value={i.pctCheckAchSingle}
                        onChange={set("pctCheckAchSingle")}
                        hint="We process the check and send one disbursement."
                      />
                      <NumberField
                        label="Check + multiple ACH"
                        suffix="%"
                        max={100}
                        step={5}
                        value={i.pctCheckAchMulti}
                        onChange={set("pctCheckAchMulti")}
                        hint="One processed check split across several disbursements."
                      />
                      <NumberField
                        label="Receive funds only"
                        suffix="%"
                        max={100}
                        step={5}
                        value={i.pctReceiveOnly}
                        onChange={set("pctReceiveOnly")}
                        hint="No check-processing component at all — the tenant is the recipient."
                      />
                      <NumberField
                        label="Wallet / internal transfer"
                        suffix="%"
                        max={100}
                        step={5}
                        value={i.pctWalletTransfer}
                        onChange={set("pctWalletTransfer")}
                        hint="Money moved inside the platform wallet."
                      />
                      <NumberField
                        label="RTP / instant payment"
                        suffix="%"
                        max={100}
                        step={5}
                        value={i.pctRtp}
                        onChange={set("pctRtp")}
                        hint="Instant payout with no check-processing component."
                      />
                      <NumberField
                        label="ACH on multi-ACH job"
                        step={0.5}
                        value={i.avgAchOnMultiAchJob}
                        onChange={set("avgAchOnMultiAchJob")}
                        hint="Average disbursements when a processed check is split."
                      />
                      <NumberField
                        label="Payouts / receive-only job"
                        step={0.5}
                        value={i.avgPayoutsPerReceiveOnlyJob}
                        onChange={set("avgPayoutsPerReceiveOnlyJob")}
                        hint="Set to 0 for pure receipts where the tenant does not pay anyone out."
                      />
                    </div>
                    {vol && (
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Derived: {Math.round(vol.checks).toLocaleString()} processed checks ·{" "}
                        {Math.round(vol.achPayouts).toLocaleString()} ACH ({Math.round(vol.sameDay).toLocaleString()} same-day
                        / {Math.round(vol.nextDay).toLocaleString()} next-day) ·{" "}
                        {Math.round(vol.rtpTransfers).toLocaleString()} RTP ·{" "}
                        {Math.round(vol.walletTransfers).toLocaleString()} wallet. Shares are normalised to 100%.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Workflow mix off — the explicit check, ACH and RTP counts in the prospect profile drive the
                    model, and every job is treated as a processed check.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">ChecksOps pricing</CardTitle>
                <CardDescription className="text-xs">
                  Seeded from the rates the platform bills today. Editable.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField label="Monthly fee" prefix="$" value={i.coMonthlyFee} onChange={set("coMonthlyFee")} />
                <NumberField label="Per check" prefix="$" step={0.25} value={i.coPerCheckFee} onChange={set("coPerCheckFee")} />
                <NumberField label="Same-day ACH" prefix="$" step={0.05} value={i.coSameDayDisbursementFee} onChange={set("coSameDayDisbursementFee")} hint="Flat fee per same-day ACH disbursement." />
                <NumberField label="Next-day ACH" prefix="$" step={0.05} value={i.coNextDayDisbursementFee} onChange={set("coNextDayDisbursementFee")} hint="Flat fee per next-day ACH disbursement." />
                <NumberField label="RTP rate" suffix="%" step={0.05} value={i.coRtpPct} onChange={set("coRtpPct")} hint="Instant RTP transfers are priced as a % of the transfer amount." />
                <NumberField label="RTP fee cap" prefix="$" step={0.5} value={i.coRtpFeeCap} onChange={set("coRtpFeeCap")} hint="Maximum RTP fee per transfer." />
                <NumberField label="Wallet transfer fee" prefix="$" step={0.25} value={i.coWalletTransferFee} onChange={set("coWalletTransferFee")} hint="Charged on a wallet / internal transfer job. $0 today — editable." />
                <NumberField label="Mortgage handling" prefix="$" step={1} value={i.coMortgageFee} onChange={set("coMortgageFee")} hint="Flat fee for the first mortgage check on a claim." />
                <NumberField label="Additional mortgage check" prefix="$" step={1} value={i.coMortgageAdditionalCheckFee} onChange={set("coMortgageAdditionalCheckFee")} hint="Each additional check on the same mortgage claim." />

                <NumberField
                  label="Referrals"
                  value={i.coReferrals}
                  onChange={set("coReferrals")}
                  hint={`$${i.coReferralCreditPerReferral} credit each toward the monthly fee, max $${i.coReferralCreditCap}/mo.`}
                />
                <NumberField label="One-time setup fee" prefix="$" step={500} value={i.coSetupFee} onChange={set("coSetupFee")} hint="Charged once at onboarding; excluded from monthly cost." />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">iink billing term</CardTitle>
                <CardDescription className="text-xs">{IINK_COMMITMENT_NOTE}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <Switch
                    id="iink-annual"
                    checked={i.iinkAnnualBilling}
                    onCheckedChange={(v) => setI((prev) => ({ ...prev, iinkAnnualBilling: v }))}
                  />
                  <Label htmlFor="iink-annual" className="text-xs text-muted-foreground">
                    Annual term — {IINK_ANNUAL_DISCOUNT_PCT}% off subscription
                  </Label>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <div className="min-w-0 space-y-4">
          {/* Cost per job / transaction */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Cost per job / transaction</CardTitle>
              <CardDescription className="text-xs">{COST_PER_JOB_NOTE}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile
                  label="Effective cost / job"
                  value={money(r.checksOps.costPerJob, 2)}
                  sub={`${Math.round(r.checksOps.jobs).toLocaleString()} jobs / mo, all-in`}
                />
                <StatTile
                  label="Weighted variable fee / job"
                  value={money(weightedPerJobCost, 2)}
                  sub="Mix-weighted transaction fees, before the monthly fee"
                />
                <StatTile
                  label="Processed checks / mo"
                  value={Math.round(checks).toLocaleString()}
                  sub={
                    i.useWorkflowMix
                      ? `${pct(checks > 0 && r.checksOps.jobs > 0 ? (checks / r.checksOps.jobs) * 100 : 0, 0)} of jobs carry check processing`
                      : "Explicit count — workflow mix off"
                  }
                />
                <StatTile
                  label="Cost / processed check"
                  value={money(r.checksOps.costPerCheck, 2)}
                  sub="Reference only — overstates recipient-heavy books"
                />
              </div>

              <div className="table-scroll">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workflow</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Share</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Jobs / mo</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Check processing</TableHead>
                      <TableHead className="text-right whitespace-nowrap">ACH</TableHead>
                      <TableHead className="text-right whitespace-nowrap">RTP</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Wallet</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Total / job</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Monthly</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workflows.map((w) => (
                      <TableRow key={w.key} className={w.share > 0 ? undefined : "opacity-50"}>
                        <TableCell className="min-w-[180px]">
                          <span className="font-medium">{w.label}</span>
                          <span className="block text-[11px] text-muted-foreground">{w.description}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{pct(w.share * 100, 0)}</TableCell>
                        <TableCell className="text-right tabular-nums">{Math.round(w.jobs).toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {w.checkProcessing > 0 ? money(w.checkProcessing, 2) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {w.ach > 0 ? `${money(w.ach, 2)} (${w.achPerJob}×)` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{w.rtp > 0 ? money(w.rtp, 2) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{w.wallet > 0 ? money(w.wallet, 2) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold text-emerald-500">
                          {money(w.total, 2)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(w.total * w.jobs)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Receive-funds-only and wallet jobs carry no check-processing component. ACH is shown at the
                mix-weighted blend of the same-day and next-day rate ({i.pctPayoutsSameDay}% same-day). The
                monthly fee, referral credits and mortgage / loss-draft fees sit outside this per-job view and
                are added in the plan comparison below.
              </p>
            </CardContent>
          </Card>

          {/* Apples-to-apples split */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Monthly cost by plan</CardTitle>
              <CardDescription className="text-xs">
{Math.round(r.checksOps.jobs).toLocaleString()} jobs / mo ·{" "}
                {Math.round(checks).toLocaleString()} processed checks ·{" "}
                {Math.round((checks * Math.min(100, i.mortgagePctOfChecks)) / 100).toLocaleString()} with a mortgage
                payee. Normal check processing is separated from mortgage / loss-draft fees, and the iink side is
                costed on the prospect's real workflow mix — receive-only, wallet and RTP jobs never count as check
                submissions.
              </CardDescription>
            </CardHeader>
            <CardContent className="table-scroll">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Subscription</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Per-check</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Disbursement / RTP</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Other</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Processing subtotal</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Mortgage fees</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Total / mo</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Per job</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Per check</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="font-semibold">
                    <TableCell className="whitespace-nowrap">ChecksOps</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.checksOps.subscription)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.checksOps.perCheck)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.checksOps.disbursement)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(-r.checksOps.credits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.checksOps.processingTotal)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.checksOps.mortgageTotal)}</TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-500">{money(r.checksOps.total)}</TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-500">{money(r.checksOps.costPerJob, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-500">{money(r.checksOps.costPerCheck, 2)}</TableCell>
                  </TableRow>
                  {r.tiers.map((t) => (
                    <TableRow key={t.tier.key} className={t.eligible ? undefined : "opacity-60"}>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          iink {t.tier.label}
                          {best?.tier.key === t.tier.key && <Badge variant="secondary" className="text-[10px]">Best fit</Badge>}
                          {!t.eligible && (
                            <Badge variant="destructive" className="text-[10px]">
                              Over {money(t.tier.depositLimit)} limit
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.subscription)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.perCheck)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.disbursement)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.otherRecurring)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.processingTotal)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.mortgageTotal)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.costPerJob, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(t.cost.costPerCheck, 2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Savings per tier */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Savings vs each iink tier</CardTitle>
            </CardHeader>
            <CardContent className="table-scroll">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>iink tier</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Monthly savings</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Annual savings</TableHead>
                    <TableHead className="text-right whitespace-nowrap">% lower</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Break-even volume</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.tiers.map((t) => (
                    <TableRow key={t.tier.key} className={t.eligible ? undefined : "opacity-60"}>
                      <TableCell className="whitespace-nowrap">
                        {t.tier.label}
                        {!t.eligible && <span className="ml-2 text-[11px] text-destructive">not eligible</span>}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums ${t.monthlySavings >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                        {money(t.monthlySavings)}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums ${t.annualSavings >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                        {money(t.annualSavings)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{pct(t.savingsPct)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.breakEvenChecks ? `${t.breakEvenChecks} checks/mo` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Published tier comparison */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Plan &amp; feature comparison</CardTitle>
              <CardDescription className="text-xs">
                Published iink plan specs from {IINK_PRICING_SOURCE}, captured {IINK_PRICING_CAPTURED}.
              </CardDescription>
            </CardHeader>
            <CardContent className="table-scroll">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Line</TableHead>
                    <TableHead className="whitespace-nowrap">ChecksOps</TableHead>
                    {IINK_TIERS.map((t) => (
                      <TableHead key={t.key} className="whitespace-nowrap">
                        {t.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="font-medium">
                    <TableCell className="whitespace-nowrap">Subscription / mo</TableCell>
                    <TableCell className="whitespace-nowrap">{money(i.coMonthlyFee)}</TableCell>
                    {IINK_TIERS.map((t) => (
                      <TableCell key={t.key} className="whitespace-nowrap">
                        {money(i.iinkAnnualBilling ? t.monthlyFee * (1 - IINK_ANNUAL_DISCOUNT_PCT / 100) : t.monthlyFee)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {IINK_FEATURE_ROWS.map((row) => (
                    <TableRow key={row.label}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{row.label}</TableCell>
                      <TableCell className="whitespace-nowrap">{row.checksOps}</TableCell>
                      {IINK_TIERS.map((t) => (
                        <TableCell key={t.key} className="whitespace-nowrap">
                          {row.values[t.key]}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                {IINK_COMMITMENT_NOTE}
              </p>
            </CardContent>
          </Card>

          {/* Volume sensitivity */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Volume sensitivity</CardTitle>
              <CardDescription className="text-xs">
                Monthly cost at other check volumes, always against the cheapest eligible iink tier at that
                volume. Mortgage share, RTP share and disbursements scale with volume.
              </CardDescription>
            </CardHeader>
            <CardContent className="table-scroll">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Checks / mo</TableHead>
                    <TableHead className="text-right">ChecksOps</TableHead>
                    <TableHead className="whitespace-nowrap">Best iink tier</TableHead>
                    <TableHead className="text-right">iink</TableHead>
                    <TableHead className="text-right">Savings</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sensitivity.map((s) => (
                    <TableRow key={s.checks}>
                      <TableCell className="tabular-nums">{s.checks.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(s.checksOps)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{s.bestTier}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(s.iink)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${s.savings >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                        {money(s.savings)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Setup fee payback */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Setup fee payback — 24 months</CardTitle>
              <CardDescription className="text-xs">
                Cumulative spend including the one-time {money(payback.setupFee)} ChecksOps setup fee, against
                {best ? ` iink ${best.tier.label} at ${money(best.cost.total)} / mo` : " iink"}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile label="One-time setup" value={money(payback.setupFee)} sub="Charged once, month 1" />
                <StatTile
                  label="Monthly savings"
                  value={money(payback.monthlySavings)}
                  tone={payback.monthlySavings >= 0 ? "positive" : "negative"}
                />
                <StatTile
                  label="Pays for itself"
                  value={payback.paybackMonth ? `Month ${payback.paybackMonth}` : "Not within 24 mo"}
                  sub={payback.paybackMonth ? `${(payback.paybackMonth / 12).toFixed(1)} years` : "At these rates"}
                  tone={payback.paybackMonth ? "positive" : "negative"}
                />
                <StatTile
                  label="2-year net savings"
                  value={money(payback.twoYearNetSavings)}
                  sub="After the setup fee"
                  tone={payback.twoYearNetSavings >= 0 ? "positive" : "negative"}
                />
              </div>

              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={payback.rows} margin={{ left: -12, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART_AXIS }} interval={1} />
                    <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} tickFormatter={(v) => money(Number(v))} width={70} />
                    <RTooltip
                      formatter={(v: number) => money(v)}
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" name="ChecksOps (incl. setup)" dataKey="checksOpsCumulative" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    <Line type="monotone" name="iink cumulative" dataKey="iinkCumulative" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="text-sm">
              iink pricing source: {IINK_PRICING_SOURCE} — captured {IINK_PRICING_CAPTURED}
            </AlertTitle>
            <AlertDescription className="text-xs">
              iink pricing and features shown here are based on their public pricing page. Actual customer
              contracts, enterprise terms and negotiated rates may differ. Figures are estimates for
              comparison purposes only.
            </AlertDescription>
          </Alert>

          <PricingOptimizer
            inputs={i}
            referralCredits={referralCredit(i)}
            presentation={presentation}
          />
        </div>
      </div>
    </div>
  );
}
