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
} from "@/lib/financial/model";
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
  const projection = useMemo(() => projectTwelveMonths(a, growth), [a, growth]);

  const revenueBars = [
    { name: "Maintenance", value: result.maintenanceRevenue },
    { name: "Per-check", value: result.perCheckRevenue },
    { name: "Disbursements", value: result.disbursementRevenue },
    { name: "MortgageOps", value: result.mortgageRevenue },
    { name: "Setup fees", value: result.setupRevenue },
  ].filter((r) => r.value > 0);

  const costBars = [
    { name: "Deposit (RDC)", value: result.depositCost },
    { name: "Disbursement rails", value: result.disbursementCost },
    { name: "Wallet / tenant", value: result.walletCost },
    { name: "Fixed overhead", value: result.fixedOverhead },
  ].filter((r) => r.value > 0);


  const applyScenario = (key: ScenarioKey) => {
    setScenario(key);
    setA((prev) => ({ ...prev, ...SCENARIOS[key].patch }));
  };

  const exportCsv = () => {
    downloadCsv("checksops-pnl-model.csv", [
      ["Metric", "Monthly", "Annual"],
      ["Gross revenue", result.grossRevenue, result.grossRevenue * 12],
      ["Variable cost", result.variableCost, result.variableCost * 12],
      ["Gross profit", result.grossProfit, result.grossProfit * 12],
      ["Fixed overhead", result.fixedOverhead, result.fixedOverhead * 12],
      ["Net profit", result.netProfit, result.netProfit * 12],
      ["Gross margin %", result.grossMarginPct.toFixed(1), ""],
      ["Net margin %", result.netMarginPct.toFixed(1), ""],
      ["Tenants", result.checks > 0 ? a.tenants : 0, ""],
      ["Checks / month", result.checks, result.checks * 12],
      ["Disbursements / month", result.disbursements, result.disbursements * 12],
      ["Revenue per tenant", result.revenuePerTenant, result.revenuePerTenant * 12],
      ["Profit per tenant", result.profitPerTenant, result.profitPerTenant * 12],
      ["Break-even tenants", result.breakEvenTenants, ""],
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
        <StatTile label="Gross revenue / mo" value={money(result.grossRevenue)} sub={`${money(result.grossRevenue * 12)} annual`} />
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
          label="Break-even tenants"
          value={result.breakEvenTenants > 0 ? String(result.breakEvenTenants) : "—"}
          sub={`${money(result.contributionPerTenant)} contribution / tenant`}
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
                <NumberField label="Checks / tenant / mo" value={a.checksPerTenantPerMonth} onChange={set("checksPerTenantPerMonth")} />
                <NumberField label="Per-check fee" prefix="$" step={0.25} value={a.perCheckFee} onChange={set("perCheckFee")} />
                <NumberField label="Disbursements / check" step={0.1} value={a.disbursementsPerCheck} onChange={set("disbursementsPerCheck")} />
                <NumberField label="Disbursement fee (high)" prefix="$" step={0.05} value={a.disbursementFeeHigh} onChange={set("disbursementFeeHigh")} hint="$1.00 tier." />
                <NumberField label="Disbursement fee (low)" prefix="$" step={0.05} value={a.disbursementFeeLow} onChange={set("disbursementFeeLow")} hint="$0.75 tier." />
                <NumberField label="% at $1.00 rate" suffix="%" max={100} value={a.disbursementsAtHighRatePct} onChange={set("disbursementsAtHighRatePct")} hint="Remainder billed at the $0.75 rate." />
                <NumberField label="Monthly maintenance fee" prefix="$" value={a.monthlyMaintenanceFee} onChange={set("monthlyMaintenanceFee")} />
                <NumberField label="MortgageOps fee" prefix="$" value={a.mortgageHandlingFee} onChange={set("mortgageHandlingFee")} hint="$10 first check, $5 additional." />
                <NumberField label="MortgageOps checks / tenant" value={a.mortgageChecksPerTenantPerMonth} onChange={set("mortgageChecksPerTenantPerMonth")} />
                <NumberField label="Setup fee (one-time)" prefix="$" step={250} value={a.setupFee} onChange={set("setupFee")} />
                <NumberField label="New tenants / mo" value={a.newTenantsPerMonth} onChange={set("newTenantsPerMonth")} hint="Drives setup fee revenue." />
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
                <NumberField label="RTP" prefix="$" step={0.05} value={a.rtpCost} onChange={set("rtpCost")} />
                <NumberField label="Next day mix" suffix="%" max={100} value={a.nextDayMixPct} onChange={set("nextDayMixPct")} />
                <NumberField label="Same day mix" suffix="%" max={100} value={a.sameDayMixPct} onChange={set("sameDayMixPct")} hint="Remainder of the mix is RTP." />
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
                <NumberField label="KYB / KYC setup" prefix="$" step={50} value={a.kybKycSetupCost} onChange={set("kybKycSetupCost")} />
                <NumberField label="CheckAlt onboarding fee" prefix="$" step={50} value={a.checkAltOnboardingFee} onChange={set("checkAltOnboardingFee")} />
              </CardContent>
            </Card>
          </div>
        )}

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Monthly P&amp;L</CardTitle>
              <CardDescription className="text-xs">
                {result.checks.toLocaleString()} checks · {result.disbursements.toLocaleString()} disbursements
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
                      <TableCell className="text-muted-foreground">{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.value)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.value * 12)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-medium">
                    <TableCell>Gross revenue</TableCell>
                    <TableCell className="text-right tabular-nums">{money(result.grossRevenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(result.grossRevenue * 12)}</TableCell>
                  </TableRow>
                  {costBars.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="text-muted-foreground">{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">({money(r.value)})</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">({money(r.value * 12)})</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold">
                    <TableCell>Net profit</TableCell>
                    <TableCell className={`text-right tabular-nums ${result.netProfit >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {money(result.netProfit)}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${result.netProfit >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {money(result.netProfit * 12)}
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
