import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, RotateCcw } from "lucide-react";
import { NumberField, StatTile } from "./NumberField";
import {
  DEFAULT_PNL,
  PnlAssumptions,
  SCENARIOS,
  ScenarioKey,
  computePnl,
  money,
  pct,
  projectTwelveMonths,
  tenantVolumes,
} from "@/lib/financial/model";
import {
  COST_PER_JOB_NOTE,
  workflowCostComponents,
  workflowPriceComponents,
} from "@/lib/financial/workflows";
import { downloadCsv } from "@/lib/financial/csv";

const CHART_AXIS = "hsl(var(--muted-foreground))";

export function PnlModel({ presentation }: { presentation: boolean }) {
  const [a, setA] = useState<PnlAssumptions>(DEFAULT_PNL);
  const [scenario, setScenario] = useState<ScenarioKey | "custom">("custom");
  const [growth, setGrowth] = useState(1);

  const set = <K extends keyof PnlAssumptions>(key: K) => (v: number) => {
    setScenario("custom");
    setA((prev) => ({ ...prev, [key]: v }));
  };

  const result = useMemo(() => computePnl(a), [a]);
  const per = useMemo(() => tenantVolumes(a), [a]);
  const workflowPrices = useMemo(
    () =>
      workflowPriceComponents(a, {
        perCheckFee: a.perCheckFee,
        sameDayFee: a.disbursementFeeHigh,
        nextDayFee: a.disbursementFeeLow,
        rtpPct: a.rtpFeePct,
        rtpCap: a.rtpFeeCap,
        walletFee: a.walletTransferFee,
        avgRtpAmount: a.avgRtpTransferAmount,
      }),
    [a],
  );
  const workflowCosts = useMemo(
    () =>
      workflowCostComponents(a, {
        depositCostPerCheck: a.checkDepositCost,
        sameDayCost: a.sameDayDisbursementCost,
        nextDayCost: a.nextDayDisbursementCost,
        rtpCostPerTransfer: a.rtpCostPerTransfer,
        walletCost: a.walletTransferCost,
      }),
    [a],
  );
  const projection = useMemo(() => projectTwelveMonths(a, growth), [a, growth]);

  const revenueBars = [
    { name: "Maintenance", value: result.maintenanceRevenue, annual: result.maintenanceRevenue * 12 },
    { name: "Per-check", value: result.perCheckRevenue, annual: result.perCheckRevenue * 12 },
    { name: "Same-day disbursements", value: result.sameDayRevenue, annual: result.sameDayRevenue * 12 },
    { name: "Next-day disbursements", value: result.nextDayRevenue, annual: result.nextDayRevenue * 12 },
    { name: "RTP / instant", value: result.rtpRevenue, annual: result.rtpRevenue * 12 },
    { name: "Wallet transfers", value: result.walletRevenue, annual: result.walletRevenue * 12 },
    {
      name: "Setup fees (one-time, all tenants)",
      value: result.setupRevenueAllTenants,
      annual: result.setupRevenueAllTenants,
    },
  ].filter((r) => r.value > 0);

  // Setup fees and onboarding costs are billed once, so the annual view is
  // recurring × 12 plus the one-time lines.
  const recurringVariableCost = result.variableCost - result.onboardingCostAllTenants;
  const annualGrossRevenue = result.recurringRevenue * 12 + result.setupRevenueAllTenants;
  const annualNetProfit =
    (result.recurringRevenue - recurringVariableCost - result.fixedOverhead) * 12 +
    result.setupRevenueAllTenants -
    result.onboardingCostAllTenants;

  const costBars = [
    { name: "Deposit (RDC)", value: result.depositCost, annual: result.depositCost * 12 },
    { name: "Same-day rail cost", value: result.sameDayCost, annual: result.sameDayCost * 12 },
    { name: "Next-day rail cost", value: result.nextDayCost, annual: result.nextDayCost * 12 },
    { name: "RTP rail cost", value: result.rtpCost, annual: result.rtpCost * 12 },
    { name: "Wallet transfer cost", value: result.walletTransferCostTotal, annual: result.walletTransferCostTotal * 12 },
    { name: "Wallet / tenant", value: result.walletCost, annual: result.walletCost * 12 },
    { name: "Fixed overhead", value: result.fixedOverhead, annual: result.fixedOverhead * 12 },
    {
      name: "Onboarding (KYB/KYC + CheckAlt, one-time per tenant)",
      value: result.onboardingCostAllTenants,
      annual: result.onboardingCostAllTenants,
    },
  ].filter((r) => r.value > 0);


  const applyScenario = (key: ScenarioKey) => {
    setScenario(key);
    setA((prev) => ({ ...prev, ...SCENARIOS[key].patch }));
  };

  const exportCsv = () => {
    downloadCsv("checksops-pnl-model.csv", [
      ["Metric", "Monthly", "Annual"],
      ["Recurring revenue", result.recurringRevenue, result.recurringRevenue * 12],
      ["Setup fees (one-time, all tenants)", result.setupRevenueAllTenants, result.setupRevenueAllTenants],
      ["Gross revenue", result.grossRevenue, annualGrossRevenue],
      ["Variable cost (recurring)", recurringVariableCost, recurringVariableCost * 12],
      ["Onboarding cost (one-time, all tenants)", result.onboardingCostAllTenants, result.onboardingCostAllTenants],
      ["Gross profit", result.grossProfit, annualGrossRevenue - recurringVariableCost * 12 - result.onboardingCostAllTenants],
      ["Fixed overhead", result.fixedOverhead, result.fixedOverhead * 12],
      ["Net profit", result.netProfit, annualNetProfit],
      ["Gross margin %", result.grossMarginPct.toFixed(1), ""],
      ["Net margin %", result.netMarginPct.toFixed(1), ""],
      ["Tenants", result.checks > 0 ? a.tenants : 0, ""],
      ["Jobs / transactions per month", result.jobs, result.jobs * 12],
      ["Checks / month", result.checks, result.checks * 12],
      ["RTP transfers / month", result.rtpTransfers, result.rtpTransfers * 12],
      ["Wallet transfers / month", result.walletTransfers, result.walletTransfers * 12],
      ["Revenue per job", result.revenuePerJob, ""],
      ["Variable cost per job", result.variableCostPerJob, ""],
      ["Gross profit per job", result.grossProfitPerJob, ""],
      ["Disbursements / month", result.disbursements, result.disbursements * 12],
      ["Revenue per tenant", result.revenuePerTenant, result.revenuePerTenant * 12],
      ["Profit per tenant", result.profitPerTenant, result.profitPerTenant * 12],
      ["Break-even tenants", result.breakEvenTenants, ""],
      ["One-time setup fees (all tenants)", result.setupRevenueAllTenants, ""],
      [],
      ["Month", "Tenants", "Revenue", "Cost", "Net profit"],
      ...projection.map((p) => [p.label, p.tenants, p.revenue, p.cost, p.netProfit]),
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {(Object.keys(SCENARIOS) as ScenarioKey[]).map((key) => (
          <Button
            key={key}
            size="sm"
            variant={scenario === key ? "default" : "outline"}
            onClick={() => applyScenario(key)}
          >
            {SCENARIOS[key].label}
          </Button>
        ))}
        {scenario === "custom" && <Badge variant="secondary">Custom</Badge>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setA(DEFAULT_PNL); setScenario("custom"); }}>
            <RotateCcw className="mr-1 h-4 w-4" /> Reset
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" /> Export CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Gross revenue / mo"
          value={money(result.grossRevenue)}
          sub={`incl. ${money(result.setupRevenueAllTenants)} setup · ${money(annualGrossRevenue)} yr 1`}
        />
        <StatTile
          label="Gross profit / mo"
          value={money(result.grossProfit)}
          sub={`${pct(result.grossMarginPct)} margin`}
          tone={result.grossProfit >= 0 ? "positive" : "negative"}
        />
        <StatTile
          label="Net profit / mo"
          value={money(result.netProfit)}
          sub={`${pct(result.netMarginPct)} net margin`}
          tone={result.netProfit >= 0 ? "positive" : "negative"}
        />
        <StatTile
          label="One-time setup fees"
          value={money(result.setupRevenueAllTenants)}
          sub={`${a.tenants} tenants × ${money(a.setupFee)}`}
          tone="positive"
        />
        <StatTile
          label="Revenue / job"
          value={money(result.revenuePerJob, 2)}
          sub={`${Math.round(result.jobs).toLocaleString()} jobs / mo · recurring only`}
        />
        <StatTile
          label="Variable cost / job"
          value={money(result.variableCostPerJob, 2)}
          sub="Weighted across the workflow mix"
        />
        <StatTile
          label="Gross profit / job"
          value={money(result.grossProfitPerJob, 2)}
          sub={`${Math.round(result.checks).toLocaleString()} of ${Math.round(result.jobs).toLocaleString()} jobs process a check`}
          tone={result.grossProfitPerJob >= 0 ? "positive" : "negative"}
        />

      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {!presentation && (
          <div className="space-y-4 print:hidden">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Volume &amp; revenue</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField label="Tenants" value={a.tenants} onChange={set("tenants")} />
                <NumberField label="Per-check fee" prefix="$" step={0.25} value={a.perCheckFee} onChange={set("perCheckFee")} />
                <NumberField label="Disbursement fee (high)" prefix="$" step={0.05} value={a.disbursementFeeHigh} onChange={set("disbursementFeeHigh")} hint="$1.00 tier." />
                <NumberField label="RTP fee" suffix="%" step={0.05} value={a.rtpFeePct} onChange={set("rtpFeePct")} hint="Instant transfers are billed as a % of the amount." />
                <NumberField label="RTP fee cap" prefix="$" step={0.5} value={a.rtpFeeCap} onChange={set("rtpFeeCap")} hint="Maximum RTP fee per transfer." />
                <NumberField label="Avg RTP transfer" prefix="$" step={500} value={a.avgRtpTransferAmount} onChange={set("avgRtpTransferAmount")} />
                <NumberField label="Wallet transfer fee" prefix="$" step={0.25} value={a.walletTransferFee} onChange={set("walletTransferFee")} hint="Charged on wallet / internal transfer jobs. $0 today." />
                <NumberField label="Disbursement fee (low)" prefix="$" step={0.05} value={a.disbursementFeeLow} onChange={set("disbursementFeeLow")} hint="$0.75 tier." />
                <NumberField label="Monthly maintenance fee" prefix="$" value={a.monthlyMaintenanceFee} onChange={set("monthlyMaintenanceFee")} />
                <NumberField label="Setup fee (one-time)" prefix="$" step={250} value={a.setupFee} onChange={set("setupFee")} />
                <NumberField label="New tenants / mo" value={a.newTenantsPerMonth} onChange={set("newTenantsPerMonth")} hint="Used for the 12-month growth projection only; setup fees bill per tenant." />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Workflow / transaction mix</CardTitle>
                <CardDescription className="text-xs">
                  Per tenant, per month — plain counts, no percentages. Receive-funds-only and wallet jobs never
                  pick up a check-processing cost.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="Checks / mo" value={a.checksPerMonth} onChange={set("checksPerMonth")} hint="Insurance checks we process." />
                  <NumberField label="Same-day payouts / mo" value={a.sameDayPayoutsPerMonth} onChange={set("sameDayPayoutsPerMonth")} hint="Billed at the same-day rate." />
                  <NumberField label="Next-day payouts / mo" value={a.nextDayPayoutsPerMonth} onChange={set("nextDayPayoutsPerMonth")} hint="Billed at the next-day rate." />
                  <NumberField label="Received funds / mo" value={a.receiveOnlyPerMonth} onChange={set("receiveOnlyPerMonth")} hint="Tenant only receives money — no check component." />
                  <NumberField label="RTP / mo" value={a.rtpPerMonth} onChange={set("rtpPerMonth")} hint="Instant payouts." />
                  <NumberField label="Wallet transfers / mo" value={a.walletPerMonth} onChange={set("walletPerMonth")} hint="Internal wallet moves." />
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Per tenant: {Math.round(per.jobs).toLocaleString()} jobs / mo —{" "}
                  {Math.round(per.checks).toLocaleString()} checks ·{" "}
                  {Math.round(per.sameDay).toLocaleString()} same-day ·{" "}
                  {Math.round(per.nextDay).toLocaleString()} next-day ·{" "}
                  {Math.round(per.rtpTransfers).toLocaleString()} RTP ·{" "}
                  {Math.round(per.walletTransfers).toLocaleString()} wallet.
                </p>
              </CardContent>
            </Card>



            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Cost structure</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField label="Deposit cost / check" prefix="$" step={0.01} value={a.checkDepositCost} onChange={set("checkDepositCost")} hint="CheckAlt FinCapture RDC." />
                <NumberField label="Next day disbursement" prefix="$" step={0.05} value={a.nextDayDisbursementCost} onChange={set("nextDayDisbursementCost")} />
                <NumberField label="Same day disbursement" prefix="$" step={0.05} value={a.sameDayDisbursementCost} onChange={set("sameDayDisbursementCost")} />
                <NumberField label="RTP cost / transfer" prefix="$" step={0.05} value={a.rtpCostPerTransfer} onChange={set("rtpCostPerTransfer")} hint="NEEDS CONFIRMATION — placeholder Moov instant-transfer cost." />
                <NumberField label="Wallet transfer cost" prefix="$" step={0.05} value={a.walletTransferCost} onChange={set("walletTransferCost")} hint="NEEDS CONFIRMATION — our cost per internal wallet transfer." />
                <NumberField label="Wallet / tenant" prefix="$" value={a.walletPerTenantMonthly} onChange={set("walletPerTenantMonthly")} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Fixed overhead / mo</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField label="CheckAlt monthly fee" prefix="$" step={50} value={a.checkAltMonthlyFee} onChange={set("checkAltMonthlyFee")} />
                <NumberField label="Moov monthly minimum" prefix="$" step={50} value={a.moovMonthlyMinimumFee} onChange={set("moovMonthlyMinimumFee")} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Onboarding cost (one-time, per tenant)</CardTitle>
                <CardDescription className="text-xs">
                  Charged once per tenant — {money(result.onboardingCostPerTenant)} × {a.tenants} tenants ={" "}
                  {money(result.onboardingCostAllTenants)}.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField label="KYB / KYC setup / tenant" prefix="$" step={50} value={a.kybKycSetupCost} onChange={set("kybKycSetupCost")} />
                <NumberField label="CheckAlt onboarding / tenant" prefix="$" step={50} value={a.checkAltOnboardingFee} onChange={set("checkAltOnboardingFee")} />
              </CardContent>
            </Card>
          </div>
        )}

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Unit economics per job / transaction</CardTitle>
              <CardDescription className="text-xs">{COST_PER_JOB_NOTE}</CardDescription>
            </CardHeader>
            <CardContent className="table-scroll">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Share</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Jobs / tenant / mo</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Revenue / job</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Variable cost / job</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Gross profit / job</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Margin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workflowPrices.map((w, index) => {
                    const cost = workflowCosts[index];
                    const profit = w.total - cost.total;
                    return (
                      <TableRow key={w.key} className={w.share > 0 ? undefined : "opacity-50"}>
                        <TableCell className="min-w-[180px]">
                          <span className="font-medium">{w.label}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {w.checkProcessing > 0
                              ? `Check ${money(w.checkProcessing, 2)}`
                              : "No check processing"}
                            {w.ach > 0 ? ` + ACH ${money(w.ach, 2)}` : ""}
                            {w.rtp > 0 ? ` + RTP ${money(w.rtp, 2)}` : ""}
                            {w.wallet > 0 ? ` + wallet ${money(w.wallet, 2)}` : ""}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{pct(w.share * 100, 0)}</TableCell>
                        <TableCell className="text-right tabular-nums">{Math.round(w.jobs).toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(w.total, 2)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(cost.total, 2)}</TableCell>
                        <TableCell
                          className={`text-right tabular-nums ${profit >= 0 ? "text-emerald-500" : "text-destructive"}`}
                        >
                          {money(profit, 2)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {w.total > 0 ? pct((profit / w.total) * 100, 0) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="font-semibold">
                    <TableCell>Weighted average (incl. monthly fee)</TableCell>
                    <TableCell className="text-right tabular-nums">100%</TableCell>
                    <TableCell className="text-right tabular-nums">{Math.round(per.jobs).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(result.revenuePerJob, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(result.variableCostPerJob, 2)}</TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${result.grossProfitPerJob >= 0 ? "text-emerald-500" : "text-destructive"}`}
                    >
                      {money(result.grossProfitPerJob, 2)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {result.revenuePerJob > 0
                        ? pct((result.grossProfitPerJob / result.revenuePerJob) * 100, 0)
                        : "—"}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>


          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Monthly P&amp;L</CardTitle>
              <CardDescription className="text-xs">
                {result.checks.toLocaleString()} checks · {result.sameDayDisbursements.toLocaleString()} same-day +{" "}
                {result.nextDayDisbursements.toLocaleString()} next-day disbursements
              </CardDescription>
            </CardHeader>

            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead className="text-right">Monthly</TableHead>
                    <TableHead className="text-right">Annual</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {revenueBars.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="text-muted-foreground">
                        {r.name === "Setup fees (one-time, all tenants)"
                          ? `Setup fees (${a.tenants} × ${money(a.setupFee)}, one-time)`
                          : r.name}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.value)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.annual)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-medium">
                    <TableCell>Gross revenue</TableCell>
                    <TableCell className="text-right tabular-nums">{money(result.grossRevenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(annualGrossRevenue)}</TableCell>
                  </TableRow>
                  {costBars.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="text-muted-foreground">{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">({money(r.value)})</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">({money(r.annual)})</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold">
                    <TableCell>Net profit</TableCell>
                    <TableCell className={`text-right tabular-nums ${result.netProfit >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {money(result.netProfit)}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${annualNetProfit >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {money(annualNetProfit)}
                    </TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell className="text-muted-foreground">Break-even tenants</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {result.breakEvenTenants > 0 ? result.breakEvenTenants : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {money(result.contributionPerTenant)} / tenant contribution
                    </TableCell>
                  </TableRow>

                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Revenue mix</CardTitle>
              </CardHeader>
              <CardContent className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={revenueBars} margin={{ left: -12, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_AXIS }} interval={0} angle={-20} textAnchor="end" height={54} />
                    <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} tickFormatter={(v) => money(Number(v))} width={70} />
                    <RTooltip formatter={(v: number) => money(v)} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {revenueBars.map((_, i) => (
                        <Cell key={i} fill="hsl(var(--primary))" fillOpacity={1 - i * 0.12} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Cost breakdown</CardTitle>
              </CardHeader>
              <CardContent className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={costBars} margin={{ left: -12, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_AXIS }} interval={0} angle={-20} textAnchor="end" height={54} />
                    <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} tickFormatter={(v) => money(Number(v))} width={70} />
                    <RTooltip formatter={(v: number) => money(v)} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]} fill="hsl(var(--destructive))" fillOpacity={0.75} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">12-month projection</CardTitle>
              <CardDescription className="text-xs">Net new tenants per month: {growth}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="max-w-xs print:hidden">
                <Slider value={[growth]} min={0} max={10} step={1} onValueChange={([v]) => setGrowth(v)} aria-label="Net new tenants per month" />
              </div>
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={projection} margin={{ left: -12, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART_AXIS }} />
                    <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} tickFormatter={(v) => money(Number(v))} width={70} />
                    <RTooltip formatter={(v: number) => money(v)} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="revenue" name="Revenue" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="cost" name="Total cost" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="netProfit" name="Net profit" stroke="hsl(var(--chart-2, var(--primary)))" strokeWidth={2} strokeDasharray="4 3" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
