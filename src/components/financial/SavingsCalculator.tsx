import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, Download, RotateCcw } from "lucide-react";
import { NumberField, StatTile } from "./NumberField";
import {
  ComparisonInputs,
  DEFAULT_COMPARISON,
  SENSITIVITY_VOLUMES,
  compareCosts,
  money,
  pct,
} from "@/lib/financial/model";
import { downloadCsv } from "@/lib/financial/csv";

const CHART_AXIS = "hsl(var(--muted-foreground))";

export function SavingsCalculator({ presentation }: { presentation: boolean }) {
  const [i, setI] = useState<ComparisonInputs>(DEFAULT_COMPARISON);

  const set = <K extends keyof ComparisonInputs>(key: K) => (v: number) =>
    setI((prev) => ({ ...prev, [key]: v }));

  const r = useMemo(() => compareCosts(i), [i]);
  const sensitivity = useMemo(
    () =>
      SENSITIVITY_VOLUMES.map((n) => {
        const row = compareCosts(i, n);
        return {
          label: `${n}`,
          checks: n,
          ChecksOps: row.checksOps.total,
          iink: row.iink.total,
          savings: row.monthlySavings,
        };
      }),
    [i],
  );

  const compareBars = [
    { name: "ChecksOps", value: r.checksOps.total },
    { name: "iink (est.)", value: r.iink.total },
  ];

  const exportCsv = () =>
    downloadCsv("checksops-vs-iink.csv", [
      ["Line", "ChecksOps", "iink (estimated)"],
      ["Monthly platform fee", r.checksOps.monthlyFee, r.iink.monthlyFee],
      ["Per-check fees", r.checksOps.perCheck, r.iink.perCheck],
      ["Disbursement fees", r.checksOps.perDisbursement, r.iink.perDisbursement],
      ["% of funds fees", r.checksOps.percentFee, r.iink.percentFee],
      ["Instant funding fees", r.checksOps.instantFee, r.iink.instantFee],
      ["MortgageOps handling", r.checksOps.mortgageFee, r.iink.mortgageFee],
      ["Total monthly cost", r.checksOps.total, r.iink.total],
      ["Cost per check", r.checksOps.costPerCheck, r.iink.costPerCheck],
      ["Basis points of volume", r.checksOps.basisPoints, r.iink.basisPoints],
      [],
      ["Monthly savings", r.monthlySavings],
      ["Annual savings", r.annualSavings],
      ["Savings %", r.savingsPct.toFixed(1)],
      [],
      ["Checks / mo", "ChecksOps", "iink (est.)", "Savings"],
      ...sensitivity.map((s) => [s.checks, s.ChecksOps, s.iink, s.savings]),
    ]);

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="text-sm">iink pricing is an editable assumption</AlertTitle>
        <AlertDescription className="text-xs">
          The iink figures below are not published contract rates. Confirm current iink pricing before
          presenting these numbers to a client or investor.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button size="sm" variant="ghost" onClick={() => setI(DEFAULT_COMPARISON)}>
          <RotateCcw className="mr-1 h-4 w-4" /> Reset
        </Button>
        <Button size="sm" variant="outline" onClick={exportCsv}>
          <Download className="mr-1 h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="ChecksOps / mo" value={money(r.checksOps.total)} sub={`${money(r.checksOps.costPerCheck, 2)} per check`} />
        <StatTile label="iink (est.) / mo" value={money(r.iink.total)} sub={`${money(r.iink.costPerCheck, 2)} per check`} />
        <StatTile
          label="Monthly savings"
          value={money(r.monthlySavings)}
          sub={pct(r.savingsPct) + " lower"}
          tone={r.monthlySavings >= 0 ? "positive" : "negative"}
        />
        <StatTile
          label="Annual savings"
          value={money(r.annualSavings)}
          sub={r.breakEvenChecks ? `Cheaper from ${r.breakEvenChecks} checks/mo` : "Never cheaper at these rates"}
          tone={r.annualSavings >= 0 ? "positive" : "negative"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {!presentation && (
          <div className="space-y-4 print:hidden">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Client profile</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField label="Checks / month" value={i.checksPerMonth} onChange={set("checksPerMonth")} />
                <NumberField label="Avg check amount" prefix="$" step={500} value={i.avgCheckAmount} onChange={set("avgCheckAmount")} />
                <NumberField label="Disbursements / check" step={0.1} value={i.disbursementsPerCheck} onChange={set("disbursementsPerCheck")} />
                <NumberField label="Instant funding mix" suffix="%" max={100} value={i.instantMixPct} onChange={set("instantMixPct")} />
                <NumberField label="Mortgage checks / month" value={i.mortgageChecksPerMonth} onChange={set("mortgageChecksPerMonth")} hint="Checks needing mortgage-company endorsement handling." />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">ChecksOps pricing</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField label="Monthly fee" prefix="$" value={i.coMonthlyFee} onChange={set("coMonthlyFee")} />
                <NumberField label="Per check" prefix="$" step={0.25} value={i.coPerCheckFee} onChange={set("coPerCheckFee")} />
                <NumberField label="Per disbursement" prefix="$" step={0.25} value={i.coPerDisbursementFee} onChange={set("coPerDisbursementFee")} />
                <NumberField label="% of funds" suffix="%" step={0.1} max={100} value={i.coPercentFeePct} onChange={set("coPercentFeePct")} />
                <NumberField label="Instant surcharge" prefix="$" step={0.25} value={i.coInstantSurcharge} onChange={set("coInstantSurcharge")} />
                <NumberField label="MortgageOps handling" prefix="$" step={1} value={i.coMortgageFee} onChange={set("coMortgageFee")} hint="Per mortgage check, billed at cost." />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">iink assumptions</CardTitle>
                <CardDescription className="text-xs">Unverified — edit to match the client's quote.</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <NumberField label="Monthly fee" prefix="$" value={i.iinkMonthlyFee} onChange={set("iinkMonthlyFee")} />
                <NumberField label="Per check" prefix="$" step={0.25} value={i.iinkPerCheckFee} onChange={set("iinkPerCheckFee")} />
                <NumberField label="% of funds" suffix="%" step={0.1} max={100} value={i.iinkPercentFeePct} onChange={set("iinkPercentFeePct")} />
                <NumberField label="Instant funding %" suffix="%" step={0.1} max={100} value={i.iinkInstantFeePct} onChange={set("iinkInstantFeePct")} />
                <NumberField label="Per disbursement" prefix="$" step={0.25} value={i.iinkPerDisbursementFee} onChange={set("iinkPerDisbursementFee")} />
                <NumberField label="Mortgage handling" prefix="$" step={1} value={i.iinkMortgageFee} onChange={set("iinkMortgageFee")} />
              </CardContent>
            </Card>
          </div>
        )}

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Side-by-side cost</CardTitle>
              <CardDescription className="text-xs">
                {i.checksPerMonth.toLocaleString()} checks · {money(r.volume)} processed per month
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cost line</TableHead>
                    <TableHead className="text-right">ChecksOps</TableHead>
                    <TableHead className="text-right">iink (est.)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    ["Monthly platform fee", r.checksOps.monthlyFee, r.iink.monthlyFee],
                    ["Per-check fees", r.checksOps.perCheck, r.iink.perCheck],
                    ["Disbursement fees", r.checksOps.perDisbursement, r.iink.perDisbursement],
                    ["% of funds", r.checksOps.percentFee, r.iink.percentFee],
                    ["Instant funding", r.checksOps.instantFee, r.iink.instantFee],
                    ["MortgageOps handling", r.checksOps.mortgageFee, r.iink.mortgageFee],
                  ].map(([label, co, ii]) => (
                    <TableRow key={String(label)}>
                      <TableCell className="text-muted-foreground">{label}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(Number(co))}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(Number(ii))}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold">
                    <TableCell>Total per month</TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-500">{money(r.checksOps.total)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.iink.total)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Effective rate on volume</TableCell>
                    <TableCell className="text-right tabular-nums">{Math.round(r.checksOps.basisPoints)} bps</TableCell>
                    <TableCell className="text-right tabular-nums">{Math.round(r.iink.basisPoints)} bps</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Monthly cost comparison</CardTitle>
              </CardHeader>
              <CardContent className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={compareBars} margin={{ left: -12, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: CHART_AXIS }} />
                    <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} tickFormatter={(v) => money(Number(v))} width={70} />
                    <RTooltip formatter={(v: number) => money(v)} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]} fill="hsl(var(--primary))" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Savings by volume</CardTitle>
                <CardDescription className="text-xs">Monthly cost at different check counts</CardDescription>
              </CardHeader>
              <CardContent className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sensitivity} margin={{ left: -12, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART_AXIS }} />
                    <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} tickFormatter={(v) => money(Number(v))} width={70} />
                    <RTooltip formatter={(v: number) => money(v)} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="ChecksOps" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="iink" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Sensitivity table</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Checks / mo</TableHead>
                    <TableHead className="text-right">ChecksOps</TableHead>
                    <TableHead className="text-right">iink (est.)</TableHead>
                    <TableHead className="text-right">Savings / mo</TableHead>
                    <TableHead className="text-right">Savings / yr</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sensitivity.map((s) => (
                    <TableRow key={s.checks}>
                      <TableCell>{s.checks}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(s.ChecksOps)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(s.iink)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${s.savings >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                        {money(s.savings)}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums ${s.savings >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                        {money(s.savings * 12)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
