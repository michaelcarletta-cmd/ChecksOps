import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle, Clipboard, Send, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { DismantlerResult, DecisionCard, MissingDocRequest, ClaimFactsPack } from "@/lib/darwinContracts";

interface ParsedDismantler {
  estimatedConfidence: number;
  evidenceLines: string[];
  weaknesses: string[];
  resolution: string[];
  missingDocs: string[];
  missingDocRequests: MissingDocRequest[];
  notesForUser: string[];
  objections: DismantlerResult["objections"];
  decisionCards: DecisionCard[];
  isStructured: boolean;
}

interface DismantlerOutputProps {
  parsed: ParsedDismantler;
  dismantlerText: string | null;
  claimFactsPack?: ClaimFactsPack | null;
  compact?: boolean;
}

export function DismantlerOutput({ parsed, dismantlerText, claimFactsPack, compact }: DismantlerOutputProps) {
  const handleCopyFull = async () => {
    if (!dismantlerText) return;
    await navigator.clipboard.writeText(dismantlerText);
    toast.success("Dismantler output copied");
  };

  const handleCopyResolution = async () => {
    if (!parsed.resolution.length) return;
    const text = parsed.resolution.map((r, i) => `${i + 1}. ${r}`).join("\n");
    await navigator.clipboard.writeText(text);
    toast.success("Requested Resolution copied");
  };

  const handleCopyRequestDocsTemplate = async () => {
    const reqs = parsed.missingDocRequests ?? [];
    const lines = reqs.length > 0
      ? reqs.map((r) => `- ${r.title}${r.whyNeeded ? ` (${r.whyNeeded})` : ""}`)
      : parsed.missingDocs.map((d) => `- ${d}`);
    const template = `Subject: Request for missing claim documentation\n\nHello,\n\nTo complete a defensible review and respond appropriately, please provide the following documents/information:\n${lines.join("\n")}\n\nThank you,\n`;
    await navigator.clipboard.writeText(template);
    toast.success("Request docs template copied");
  };

  if (!dismantlerText || dismantlerText.trim().length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center space-y-3">
        <Shield className="h-8 w-8 text-muted-foreground/40" />
        <div className="text-sm font-medium text-muted-foreground">No dismantler output yet</div>
        <p className="text-xs text-muted-foreground/70 max-w-[280px]">
          Run any Darwin analysis (Auto-Draft Rebuttal, Systematic Dismantler, etc.) and the results will appear here automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Copy button */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1" onClick={handleCopyFull}>
          <Clipboard className="h-3 w-3" />
          Copy All
        </Button>
      </div>

      {/* Confidence bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">Confidence</span>
          <span className={cn(
            "font-semibold",
            parsed.estimatedConfidence >= 0.7 ? "text-green-600 dark:text-green-400" :
            parsed.estimatedConfidence >= 0.5 ? "text-amber-600 dark:text-amber-400" :
            "text-destructive"
          )}>
            {Math.round(parsed.estimatedConfidence * 100)}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              parsed.estimatedConfidence >= 0.7 ? "bg-green-500" :
              parsed.estimatedConfidence >= 0.5 ? "bg-amber-500" :
              "bg-destructive"
            )}
            style={{ width: `${Math.round(parsed.estimatedConfidence * 100)}%` }}
          />
        </div>
      </div>

      {/* Evidence ledger */}
      {claimFactsPack?.evidenceIndexSummary?.byFolderKey && Object.keys(claimFactsPack.evidenceIndexSummary.byFolderKey).length > 0 && (
        <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5">
          <span className="font-medium">Evidence ledger:</span>
          {Object.entries(claimFactsPack.evidenceIndexSummary.byFolderKey).map(([k, v]) => (
            <span key={k}>{k.replace(/_/g, " ")} {v}</span>
          ))}
        </div>
      )}

      {/* Low confidence warning */}
      {(parsed.estimatedConfidence < 0.5 || parsed.evidenceLines.length === 0) && (
        <Alert className="border-warning/50 bg-warning/10">
          <AlertCircle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-xs">Needs more documentation</AlertTitle>
          <AlertDescription className="text-xs mt-1 space-y-2">
            {parsed.estimatedConfidence < 0.5 && (
              <p className="text-muted-foreground">
                Low confidence: {parsed.missingDocRequests?.length
                  ? parsed.missingDocRequests.slice(0, 3).map((r) => r.title).join("; ")
                  : parsed.missingDocs.slice(0, 3).join("; ")}.
              </p>
            )}
            <div>
              Missing docs:
              <ul className="list-disc ml-4 mt-1">
                {parsed.missingDocs.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1" onClick={handleCopyRequestDocsTemplate}>
              <Send className="h-3 w-3" />
              Copy request docs template
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Upload checklist */}
      {parsed.missingDocRequests && parsed.missingDocRequests.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-muted-foreground">Upload checklist</div>
          <ul className="space-y-0.5 text-[11px]">
            {(["high", "med", "low"] as const).map((priority) => {
              const items = parsed.missingDocRequests!.filter((r) => r.priority === priority);
              if (items.length === 0) return null;
              return (
                <li key={priority} className="text-muted-foreground">
                  <span className={cn(
                    "capitalize font-medium",
                    priority === "high" && "text-destructive",
                    priority === "med" && "text-amber-600 dark:text-amber-400"
                  )}>{priority}:</span> {items.map((r) => r.title).join("; ")}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Notes for user */}
      {parsed.notesForUser.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-muted-foreground">Notes for you</div>
          <ul className="list-disc ml-4 text-xs text-muted-foreground space-y-0.5">
            {parsed.notesForUser.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Objections */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-muted-foreground">Objections</div>
        {parsed.isStructured && parsed.objections.length > 0 ? (
          <div className="space-y-2">
            {parsed.objections.map((obj, idx) => (
              <Card key={idx} className="border-border/50">
                <CardContent className="p-2 text-xs space-y-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {obj.type && (
                      <span className="text-[10px] uppercase tracking-wide text-primary font-semibold">{obj.type}</span>
                    )}
                    {"evidenceStrength" in obj && obj.evidenceStrength && (
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded-full",
                        obj.evidenceStrength === "strong" && "bg-green-500/20 text-green-700 dark:text-green-400",
                        obj.evidenceStrength === "ok" && "bg-muted text-muted-foreground",
                        obj.evidenceStrength === "weak" && "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                      )}>
                        {obj.evidenceStrength}
                      </span>
                    )}
                  </div>
                  <div className="font-medium">{obj.verbatim}</div>
                  <div className="text-muted-foreground">{obj.whyItFails}</div>
                  {obj.evidence.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {obj.evidence.map((e, i) => (
                        <span
                          key={i}
                          className="px-1.5 py-0.5 rounded bg-muted text-[10px]"
                          title={[e.quote || e.docName, e.evidenceMethod ? `Method: ${e.evidenceMethod}` : null, e.spanHint ? `Lines: ${e.spanHint.startLine ?? "?"}-${e.spanHint.endLine ?? "?"}` : null, e.evidenceMethod === "inference" && e.basis ? `Basis: ${e.basis}` : null].filter(Boolean).join(" · ")}
                        >
                          {e.docName}{e.quote ? `: "${e.quote.slice(0, 20)}…"` : ""}
                          {e.evidenceMethod && <span className="opacity-70"> ({e.evidenceMethod})</span>}
                          {e.evidenceMethod === "inference" && e.basis && <span className="block mt-0.5 text-[9px] opacity-80">— {e.basis.slice(0, 60)}{e.basis.length > 60 ? "…" : ""}</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  {obj.requestedResolution && (
                    <div className="pt-1 border-t border-border/50 text-muted-foreground">
                      Request: {obj.requestedResolution}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : parsed.weaknesses.length > 0 ? (
          <div className="space-y-2">
            {parsed.weaknesses.map((w, idx) => (
              <Card key={idx} className="border-border/50">
                <CardContent className="p-2 text-xs">
                  <div className="font-medium">Objection #{idx + 1}</div>
                  <div className="text-muted-foreground mt-1">{w}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No objections parsed.</div>
        )}
      </div>

      {/* Decision cards */}
      {parsed.decisionCards?.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-muted-foreground">Decision cards</div>
          <div className="space-y-2">
            {parsed.decisionCards.map((card, idx) => (
              <Card key={"key" in card && card.key ? card.key : idx} className="border-border/50">
                <CardContent className="p-2 text-xs space-y-1">
                  <div className="font-medium">{card.decision}</div>
                  {card.requiredFacts?.length > 0 && (
                    <div className="text-muted-foreground">Facts: {card.requiredFacts.join("; ")}</div>
                  )}
                  {card.requiredDocs?.length > 0 && (
                    <div className="text-muted-foreground">Docs: {card.requiredDocs.join("; ")}</div>
                  )}
                  <div className="pt-1 border-t border-border/50 grid grid-cols-2 gap-1 text-[10px]">
                    <div><span className="text-muted-foreground">If true:</span> {card.ifTrue}</div>
                    <div><span className="text-muted-foreground">If false:</span> {card.ifFalse}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Evidence chips */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-muted-foreground">Evidence</div>
        <div className="flex flex-wrap gap-1.5">
          {parsed.evidenceLines.length > 0 ? (
            parsed.evidenceLines.map((e, idx) => (
              <span
                key={idx}
                className="px-2 py-1 rounded-full bg-muted text-muted-foreground text-[11px]"
                title={e}
              >
                {e}
              </span>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No evidence references parsed.</span>
          )}
        </div>
      </div>

      {/* Requested Resolution */}
      <div className="pt-2 border-t space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-muted-foreground">Requested Resolution</div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={handleCopyResolution}
            disabled={parsed.resolution.length === 0}
          >
            <Clipboard className="h-3 w-3" />
            Copy
          </Button>
        </div>
        {parsed.resolution.length > 0 ? (
          <ol className="list-decimal ml-4 text-xs space-y-1">
            {parsed.resolution.map((r, idx) => (
              <li key={idx} className="text-muted-foreground">{r}</li>
            ))}
          </ol>
        ) : (
          <div className="text-xs text-muted-foreground">No requested resolution parsed.</div>
        )}
      </div>
    </div>
  );
}
