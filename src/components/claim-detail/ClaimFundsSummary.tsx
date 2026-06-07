import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, CheckCircle2, Clock, AlertCircle } from "lucide-react";

interface ClaimFundsSummaryProps {
  settlement: any;
  checks: any[];
}

interface FundCategory {
  label: string;
  checkTypes: string[];
  expected: number;
  description: string;
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ClaimFundsSummary({ settlement, checks }: ClaimFundsSummaryProps) {
  if (!settlement && (!checks || checks.length === 0)) return null;

  const s = settlement || {};

  // ACV for dwelling = RCV - rec dep - non-rec dep - deductible
  const dwellingAcv = Math.max(0,
    Number(s.replacement_cost_value || 0)
    - Number(s.recoverable_depreciation || 0)
    - Number(s.non_recoverable_depreciation || 0)
    - Number(s.deductible || 0)
  );

  const otherStructuresAcv = Math.max(0,
    Number(s.other_structures_rcv || 0)
    - Number(s.other_structures_recoverable_depreciation || 0)
    - Number(s.other_structures_non_recoverable_depreciation || 0)
    - Number(s.other_structures_deductible || 0)
  );

  const personalPropertyAcv = Math.max(0,
    Number(s.personal_property_rcv || 0)
    - Number(s.personal_property_recoverable_depreciation || 0)
    - Number(s.personal_property_non_recoverable_depreciation || 0)
  );

  const ordinanceLawNet = Math.max(0,
    Number(s.pwi_rcv || 0)
    - Number(s.pwi_recoverable_depreciation || 0)
    - Number(s.pwi_non_recoverable_depreciation || 0)
    - Number(s.pwi_deductible || 0)
  );

  const aleAcv = Math.max(0,
    Number(s.ale_rcv || 0)
    - Number(s.ale_recoverable_depreciation || 0)
    - Number(s.ale_non_recoverable_depreciation || 0)
  );

  const totalRecoverableDepreciation =
    Number(s.recoverable_depreciation || 0)
    + Number(s.other_structures_recoverable_depreciation || 0)
    + Number(s.pwi_recoverable_depreciation || 0)
    + Number(s.personal_property_recoverable_depreciation || 0)
    + Number(s.ale_recoverable_depreciation || 0);

  const categories: FundCategory[] = [
    {
      label: "Dwelling ACV",
      checkTypes: ["initial"],
      expected: dwellingAcv,
      description: "RCV − Rec. Dep. − Non-Rec. Dep. − Deductible",
    },
    {
      label: "Recoverable Depreciation",
      checkTypes: ["recoverable_depreciation"],
      expected: totalRecoverableDepreciation,
      description: "Released when work is completed",
    },
    {
      label: "Other Structures",
      checkTypes: ["other_structures"],
      expected: otherStructuresAcv,
      description: "Detached garage, fence, shed, etc.",
    },
    {
      label: "Ordinance & Law",
      checkTypes: ["ordinance_law"],
      expected: ordinanceLawNet,
      description: "Code-required upgrades (Paid When Incurred)",
    },
    {
      label: "Personal Property / Contents",
      checkTypes: ["contents"],
      expected: personalPropertyAcv,
      description: "Furniture, appliances, personal belongings",
    },
    {
      label: "Additional Living Expenses",
      checkTypes: ["ale"],
      expected: aleAcv,
      description: "Temporary housing & living costs",
    },
    {
      label: "Supplemental Payments",
      checkTypes: ["supplemental"],
      expected: Number(s.supplement_expected || 0),
      description: "Additional amounts approved after initial settlement",
    },
  ];

  const totalRcv =
    Number(s.replacement_cost_value || 0)
    + Number(s.other_structures_rcv || 0)
    + Number(s.pwi_rcv || 0)
    + Number(s.personal_property_rcv || 0)
    + Number(s.ale_rcv || 0);

  const totalExpected = categories.reduce((sum, c) => sum + c.expected, 0);

  const checksByType: Record<string, number> = {};
  for (const check of checks) {
    const t = check.check_type as string;
    checksByType[t] = (checksByType[t] || 0) + Number(check.amount);
  }

  const totalReceived = Object.values(checksByType).reduce((a, b) => a + b, 0);

  const activeCategories = categories.filter(
    (c) => c.expected > 0 || c.checkTypes.some((t) => (checksByType[t] || 0) > 0)
  );

  if (activeCategories.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Claim Funds Summary
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              All checks grouped by category — tracks progress toward full RCV
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Total RCV</p>
            <p className="text-xl font-bold text-primary">${fmt(totalRcv)}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Grand total progress bar */}
        <div className="p-4 bg-muted/40 rounded-lg space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Total Received</span>
            <span className="font-bold text-primary">${fmt(totalReceived)}</span>
          </div>
          <Progress
            value={totalExpected > 0 ? Math.min(100, (totalReceived / totalExpected) * 100) : 0}
            className="h-2.5"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{totalExpected > 0 ? Math.round((totalReceived / totalExpected) * 100) : 0}% of expected funds received</span>
            <span>Remaining: ${fmt(Math.max(0, totalExpected - totalReceived))}</span>
          </div>
        </div>

        {/* Per-category breakdown */}
        <div className="space-y-3">
          {activeCategories.map((cat) => {
            const received = cat.checkTypes.reduce((sum, t) => sum + (checksByType[t] || 0), 0);
            const remaining = Math.max(0, cat.expected - received);
            const pct = cat.expected > 0 ? Math.min(100, (received / cat.expected) * 100) : received > 0 ? 100 : 0;
            const isComplete = cat.expected > 0 && remaining === 0;
            const isOverfunded = received > cat.expected && cat.expected > 0;

            return (
              <div key={cat.label} className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {isComplete ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                    ) : remaining > 0 ? (
                      <Clock className="h-4 w-4 text-amber-500 shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <div>
                      <span className="text-sm font-medium">{cat.label}</span>
                      <p className="text-xs text-muted-foreground">{cat.description}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <p className="text-sm font-semibold text-primary">${fmt(received)}</p>
                    {cat.expected > 0 && (
                      <p className="text-xs text-muted-foreground">of ${fmt(cat.expected)}</p>
                    )}
                  </div>
                </div>

                {cat.expected > 0 && (
                  <div className="space-y-1 pl-6">
                    <Progress value={pct} className="h-1.5" />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{Math.round(pct)}% funded</span>
                      {isOverfunded ? (
                        <Badge variant="outline" className="text-[10px] px-1.5 text-amber-500 border-amber-500/50">
                          Overfunded +${fmt(received - cat.expected)}
                        </Badge>
                      ) : remaining > 0 ? (
                        <span>Outstanding: ${fmt(remaining)}</span>
                      ) : (
                        <Badge variant="outline" className="text-[10px] px-1.5 text-emerald-500 border-emerald-500/50">
                          Paid in full
                        </Badge>
                      )}
                    </div>
                  </div>
                )}

                {cat.expected === 0 && received > 0 && (
                  <p className="text-xs text-muted-foreground pl-6">
                    No expected amount set — ${fmt(received)} received
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Summary row */}
        <div className="border-t pt-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Total Expected</p>
              <p className="text-base font-bold">${fmt(totalExpected)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Received</p>
              <p className="text-base font-bold text-primary">${fmt(totalReceived)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Outstanding</p>
              <p className={`text-base font-bold ${totalReceived >= totalExpected && totalExpected > 0 ? "text-emerald-500" : "text-amber-500"}`}>
                ${fmt(Math.max(0, totalExpected - totalReceived))}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
