import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Info, RotateCcw, Sparkles } from "lucide-react";
import { NumberField, StatTile } from "./NumberField";
import { money, pct } from "@/lib/financial/model";
import { IINK_TIERS, SavingsInputs } from "@/lib/financial/iink";
import {
  DEFAULT_PROVIDER_COSTS,
  DEFAULT_SCENARIOS,
  DEFAULT_TARGETS,
  OPTIMIZATION_VOLUMES,
  OptimizationTargets,
  PricingScenario,
  ProviderCosts,
  describeBands,
  optimizePricing,
} from "@/lib/financial/pricingScenarios";
import { downloadCsv } from "@/lib/financial/csv";

interface Props {
  inputs: SavingsInputs;
  referralCredits: number;
  presentation: boolean;
}

export function PricingOptimizer({ inputs, referralCredits, presentation }: Props) {
  const [scenarios, setScenarios] = useState<PricingScenario[]>(DEFAULT_SCENARIOS);
  const [costs, setCosts] = useState<ProviderCosts>(DEFAULT_PROVIDER_COSTS);
  const [targets, setTargets] = useState<OptimizationTargets>(DEFAULT_TARGETS);

  const result = useMemo(
    () => optimizePricing(scenarios, inputs, costs, targets, IINK_TIERS, referralCredits),
    [scenarios, inputs, costs, targets, referralCredits],
  );

  const patchScenario = (key: string, patch: Partial<PricingScenario>) =>
    setScenarios((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const patchBand = (key: string, index: number, rate: number) =>
    setScenarios((prev) =>
      prev.map((s) =>
        s.key === key
          ? { ...s, bands: s.bands.map((b, n) => (n === index ? { ...b, rate } : b)) }
          : s,
      ),
    );

  const patchBandCap = (key: string, index: number, upTo: number) =>
    setScenarios((prev) =>
      prev.map((s) =>
        s.key === key
          ? { ...s, bands: s.bands.map((b, n) => (n === index ? { ...b, upTo } : b)) }
          : s,
      ),
    );

  const reset = () => {
    setScenarios(DEFAULT_SCENARIOS);
    setCosts(DEFAULT_PROVIDER_COSTS);
    setTargets(DEFAULT_TARGETS);
  };

  const exportCsv = () =>
    downloadCsv("checksops-pricing-optimization.csv", [
      ["ChecksOps pricing optimization — analysis only, does not change live billing"],
      ["Target discount vs iink", `${targets.minDiscountPct}%–${targets.maxDiscountPct}%`],
      ["Gross margin floor", `${targets.minGrossMarginPct}%`],
      ["Mortgage / loss-draft services in scope", inputs.usesMortgageServices ? "Yes" : "No"],
      [],
      ["Provider cost assumptions (per month unless noted)"],
      ["Deposit cost / check", costs.depositCostPerCheck],
      ["Same-day ACH cost", costs.sameDayCost],
      ["Next-day ACH cost", costs.nextDayCost],
      ["RTP cost / transfer", costs.rtpCostPerTransfer],
      ["Mortgage handling cost / check", costs.mortgageHandlingCost],
      ["Platform cost / tenant", costs.platformCostPerTenant],
      [],
      [
        "Scenario",
        "Checks / mo",
        "Customer cost / mo",
        "Customer cost / yr",
        "Effective cost / check",
        "Best eligible iink tier",
        "iink cost / mo",
        "Savings / mo",
        "% vs iink",
        "ChecksOps gross profit",
        "Gross margin %",
        "In target corridor",
      ],
      ...result.analyses.flatMap((a) =>
        a.byVolume.map((v) => [
          a.scenario.label,
          v.checks,
          v.cost.total,
          v.cost.total * 12,
          v.cost.costPerCheck,
          v.bestTier?.label ?? "None eligible",
          v.bestTierTotal,
          v.savings,
          v.savingsPct.toFixed(1),
          v.margin.grossProfit,
          v.margin.grossMarginPct.toFixed(1),
          v.inTargetCorridor ? "Yes" : "No",
        ]),
      ),
      [],
      ["Break-even check volume by scenario and iink tier"],
      ["Scenario", ...IINK_TIERS.map((t) => t.label)],
      ...result.analyses.map((a) => [
        a.scenario.label,
        ...a.vsTiers.map((t) => t.breakEvenChecks ?? "Not within 2,000"),
      ]),
      [],
      ["Best fit", result.bestFit?.scenario.label ?? "—"],
      ["Reason", result.bestFitReason],
    ]);

  const bestFit = result.bestFit;

  return (
    <div className="space-y-4">
      {/* Best Fit recommendation */}
      <Card className="border-primary/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Best Fit Pricing
            {bestFit && <Badge variant="secondary">{bestFit.scenario.label}</Badge>}
          </CardTitle>
          <CardDescription className="text-xs">{result.bestFitReason}</CardDescription>
        </CardHeader>
        {bestFit && (
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="Customer cost / mo"
                value={money(bestFit.atProspectVolume.cost.total)}
                sub={`${money(bestFit.atProspectVolume.cost.costPerCheck, 2)} per check`}
              />
              <StatTile
                label="Savings vs iink"
                value={money(bestFit.atProspectVolume.savings)}
                sub={`${pct(bestFit.atProspectVolume.savingsPct)} lower · ${money(bestFit.atProspectVolume.savings * 12)} / yr`}
                tone={bestFit.atProspectVolume.savings >= 0 ? "positive" : "negative"}
              />
              <StatTile
                label="ChecksOps gross margin"
                value={pct(bestFit.atProspectVolume.margin.grossMarginPct)}
                sub={`${money(bestFit.atProspectVolume.margin.grossProfit)} gross profit / mo`}
                tone={bestFit.atProspectVolume.marginHealthy ? "positive" : "negative"}
              />
              <StatTile
                label="Wins at volumes"
                value={
                  bestFit.winningVolumes.length
                    ? bestFit.winningVolumes.map((v) => v.toLocaleString()).join(", ")
                    : "None"
                }
                sub="Checks / mo where it beats the best eligible iink tier"
              />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {bestFit.scenario.description} Rate structure: {describeBands(bestFit.scenario)}.
            </p>
          </CardContent>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button size="sm" variant="ghost" onClick={reset}>
          <RotateCcw className="mr-1 h-4 w-4" /> Reset scenarios
        </Button>
        <Button size="sm" variant="outline" onClick={exportCsv}>
          <Download className="mr-1 h-4 w-4" /> Export optimization CSV
        </Button>
      </div>

      {/* Scenario editors */}
      {!presentation && (
        <div className="grid gap-4 lg:grid-cols-3">
          {scenarios.map((s) => (
            <Card key={s.key} className={result.bestFit?.scenario.key === s.key ? "border-primary/50" : undefined}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Input
                    value={s.label}
                    onChange={(e) => patchScenario(s.key, { label: e.target.value })}
                    className="h-8 text-sm font-medium"
                    aria-label="Scenario name"
                  />
                </CardTitle>
                <CardDescription className="text-[11px]">
                  {s.isCurrent ? "Live customer pricing — shown for reference only." : s.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label="Monthly fee"
                    prefix="$"
                    value={s.monthlyFee}
                    onChange={(v) => patchScenario(s.key, { monthlyFee: v })}
                  />
                  <NumberField
                    label="Included checks"
                    value={s.includedChecks}
                    onChange={(v) => patchScenario(s.key, { includedChecks: v })}
                    hint="Checks bundled into the monthly fee before per-check rates apply."
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Declining per-check bands</Label>
                  {s.bands.map((b, index) => (
                    <div key={index} className="grid grid-cols-2 gap-2">
                      <NumberField
                        label={b.upTo === null ? "Beyond last band" : `Up to (checks)`}
                        value={b.upTo ?? 0}
                        onChange={(v) => patchBandCap(s.key, index, v)}
                      />
                      <NumberField
                        label="Rate / check"
                        prefix="$"
                        step={0.25}
                        value={b.rate}
                        onChange={(v) => patchBand(s.key, index, v)}
                      />
                    </div>
                  ))}
                  <p className="text-[11px] text-muted-foreground">{describeBands(s)}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="Same-day ACH" prefix="$" step={0.05} value={s.sameDayFee} onChange={(v) => patchScenario(s.key, { sameDayFee: v })} />
                  <NumberField label="Next-day ACH" prefix="$" step={0.05} value={s.nextDayFee} onChange={(v) => patchScenario(s.key, { nextDayFee: v })} />
                  <NumberField label="RTP rate" suffix="%" step={0.05} value={s.rtpPct} onChange={(v) => patchScenario(s.key, { rtpPct: v })} />
                  <NumberField label="RTP cap" prefix="$" step={0.5} value={s.rtpCap} onChange={(v) => patchScenario(s.key, { rtpCap: v })} />
                  <NumberField label="Mortgage handling" prefix="$" value={s.mortgageFee} onChange={(v) => patchScenario(s.key, { mortgageFee: v })} hint="Only applied when the prospect uses mortgage / loss-draft services." />
                  <NumberField label="Addl mortgage check" prefix="$" value={s.mortgageAdditionalCheckFee} onChange={(v) => patchScenario(s.key, { mortgageAdditionalCheckFee: v })} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Provider costs + targets */}
      {!presentation && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Our provider costs</CardTitle>
              <CardDescription className="text-xs">
                Seeded from the internal P&amp;L model. Confirm against the current CheckAlt and Moov
                contracts — RTP and mortgage handling costs are estimates.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <NumberField label="Deposit cost / check" prefix="$" step={0.01} value={costs.depositCostPerCheck} onChange={(v) => setCosts({ ...costs, depositCostPerCheck: v })} hint="CheckAlt FinCapture RDC." />
              <NumberField label="Same-day ACH cost" prefix="$" step={0.05} value={costs.sameDayCost} onChange={(v) => setCosts({ ...costs, sameDayCost: v })} />
              <NumberField label="Next-day ACH cost" prefix="$" step={0.05} value={costs.nextDayCost} onChange={(v) => setCosts({ ...costs, nextDayCost: v })} />
              <NumberField label="RTP cost / transfer" prefix="$" step={0.05} value={costs.rtpCostPerTransfer} onChange={(v) => setCosts({ ...costs, rtpCostPerTransfer: v })} hint="NEEDS CONFIRMATION — placeholder Moov instant-transfer cost." />
              <NumberField label="Mortgage handling cost" prefix="$" step={0.5} value={costs.mortgageHandlingCost} onChange={(v) => setCosts({ ...costs, mortgageHandlingCost: v })} hint="NEEDS CONFIRMATION — labour plus shipping label per loss-draft check." />
              <NumberField label="Platform cost / tenant" prefix="$" value={costs.platformCostPerTenant} onChange={(v) => setCosts({ ...costs, platformCostPerTenant: v })} hint="Infra and support carried per tenant per month." />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Optimization targets</CardTitle>
              <CardDescription className="text-xs">
                A scenario lands &quot;in corridor&quot; when it is inside this discount range against the
                applicable iink tier and clears the margin floor.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <NumberField label="Min discount vs iink" suffix="%" max={100} value={targets.minDiscountPct} onChange={(v) => setTargets({ ...targets, minDiscountPct: v })} />
              <NumberField label="Max discount vs iink" suffix="%" max={100} value={targets.maxDiscountPct} onChange={(v) => setTargets({ ...targets, maxDiscountPct: v })} />
              <NumberField label="Gross margin floor" suffix="%" max={100} value={targets.minGrossMarginPct} onChange={(v) => setTargets({ ...targets, minGrossMarginPct: v })} />
            </CardContent>
          </Card>
        </div>
      )}

      {/* Volume grid per scenario */}
      {result.analyses.map((a) => (
        <Card key={a.scenario.key}>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {a.scenario.label}
              {a.scenario.isCurrent && <Badge variant="outline" className="text-[10px]">Live pricing</Badge>}
              {result.bestFit?.scenario.key === a.scenario.key && (
                <Badge variant="secondary" className="text-[10px]">Best fit</Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              {describeBands(a.scenario)} · avg {pct(a.avgSavingsPct)} vs iink · avg {pct(a.avgMarginPct)} gross
              margin across the volume sweep.
            </CardDescription>
          </CardHeader>
          <CardContent className="table-scroll">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Checks / mo</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Customer / mo</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Customer / yr</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Cost / check</TableHead>
                  <TableHead className="whitespace-nowrap">Applicable iink tier</TableHead>
                  <TableHead className="text-right whitespace-nowrap">iink / mo</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Savings</TableHead>
                  <TableHead className="text-right whitespace-nowrap">% vs iink</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Gross margin</TableHead>
                  <TableHead className="whitespace-nowrap">Verdict</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.byVolume.map((v) => (
                  <TableRow key={v.checks}>
                    <TableCell className="tabular-nums">
                      {v.checks.toLocaleString()}
                      {v.checks === OPTIMIZATION_VOLUMES[OPTIMIZATION_VOLUMES.length - 1] ? "+" : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(v.cost.total)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(v.cost.total * 12)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(v.cost.costPerCheck, 2)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {v.bestTier?.label ?? "None eligible"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(v.bestTierTotal)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${v.savings >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {money(v.savings)}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${v.savingsPct >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {pct(v.savingsPct)}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${v.marginHealthy ? "text-emerald-500" : "text-destructive"}`}>
                      {pct(v.margin.grossMarginPct)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {v.inTargetCorridor ? (
                        <Badge variant="secondary" className="text-[10px]">In target</Badge>
                      ) : v.wins && v.marginHealthy ? (
                        <Badge variant="outline" className="text-[10px]">Wins</Badge>
                      ) : v.wins ? (
                        <Badge variant="outline" className="text-[10px] text-destructive">Thin margin</Badge>
                      ) : (
                        <Badge variant="destructive" className="text-[10px]">Loses</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}

      {/* Break-even matrix */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Break-even check volume by scenario</CardTitle>
          <CardDescription className="text-xs">
            Smallest monthly check volume where each ChecksOps scenario becomes cheaper than that iink tier,
            at the prospect&apos;s current mortgage, ACH and RTP mix.
          </CardDescription>
        </CardHeader>
        <CardContent className="table-scroll">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Scenario</TableHead>
                {IINK_TIERS.map((t) => (
                  <TableHead key={t.key} className="text-right whitespace-nowrap">
                    {t.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.analyses.map((a) => (
                <TableRow key={a.scenario.key}>
                  <TableCell className="whitespace-nowrap">{a.scenario.label}</TableCell>
                  {a.vsTiers.map((t) => (
                    <TableCell key={t.tier.key} className="text-right tabular-nums">
                      {t.breakEvenChecks ? `${t.breakEvenChecks}/mo` : "—"}
                      {!t.eligible && <span className="ml-1 text-[10px] text-muted-foreground">n/e</span>}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle className="text-sm">Analysis layer only</AlertTitle>
        <AlertDescription className="text-xs">
          These scenarios are a sales and modeling tool. Nothing here changes live customer pricing, tenant
          billing rates, or invoicing. Mortgage / loss-draft fees are excluded entirely unless the prospect
          profile marks those services as in use. RTP cost per transfer and mortgage handling cost are
          placeholders pending contract confirmation.
        </AlertDescription>
      </Alert>
    </div>
  );
}
