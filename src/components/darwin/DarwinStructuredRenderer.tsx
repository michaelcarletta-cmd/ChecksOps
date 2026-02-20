import { useMemo } from "react";
import { Copy, ExternalLink } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type {
  DarwinEvidenceSource,
  DarwinStructuredResult,
} from "@/components/darwin/types";

function scoreTone(score: number): "default" | "secondary" | "destructive" {
  if (score >= 75) return "default";
  if (score >= 45) return "secondary";
  return "destructive";
}

function SectionCopyButton({
  onCopy,
}: {
  onCopy: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onCopy}
      className="h-8"
    >
      <Copy className="mr-1 h-3.5 w-3.5" />
      Copy section
    </Button>
  );
}

function EvidenceSourceList({ sources }: { sources: DarwinEvidenceSource[] }) {
  if (!sources?.length) {
    return <p className="text-xs text-muted-foreground">No sources listed.</p>;
  }

  return (
    <ul className="space-y-1">
      {sources.map((source, idx) => (
        <li key={`${source.label}-${idx}`} className="text-sm">
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2"
            >
              {source.label}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            source.label
          )}
        </li>
      ))}
    </ul>
  );
}

export function DarwinStructuredRenderer({
  result,
}: {
  result: DarwinStructuredResult;
}) {
  const { toast } = useToast();
  const fullJson = useMemo(() => JSON.stringify(result, null, 2), [result]);

  const copyValue = async (label: string, value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    await navigator.clipboard.writeText(text);
    toast({
      title: "Copied",
      description: `${label} copied to clipboard`,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-sm font-medium text-muted-foreground">Darwin structured output</h5>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => copyValue("JSON", fullJson)}
          className="h-8"
        >
          <Copy className="mr-1 h-3.5 w-3.5" />
          Copy all JSON
        </Button>
      </div>

      <Accordion
        type="multiple"
        defaultValue={[
          "steelman",
          "claims",
          "rebuttals",
          "evidence",
          "questions",
          "risks",
          "talking-points",
          "confidence",
        ]}
        className="w-full rounded-md border px-3"
      >
        <AccordionItem value="steelman">
          <AccordionTrigger>Steelman opponent</AccordionTrigger>
          <AccordionContent className="space-y-2">
            <SectionCopyButton onCopy={() => copyValue("Steelman", result.steelman_opponent)} />
            <p className="text-sm">
              {result.steelman_opponent || "No steelman perspective was generated."}
            </p>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="claims">
          <AccordionTrigger>
            Their key claims <Badge className="ml-2">{result.their_key_claims.length}</Badge>
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <SectionCopyButton onCopy={() => copyValue("Key claims", result.their_key_claims)} />
            {result.their_key_claims.length ? (
              result.their_key_claims.map((item, idx) => (
                <Card key={`${item.claim}-${idx}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">{item.claim}</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <p className="mb-1 text-xs text-muted-foreground">Assumptions</p>
                    <ul className="list-disc space-y-1 pl-5 text-sm">
                      {item.assumptions?.length ? (
                        item.assumptions.map((assumption, aIdx) => (
                          <li key={`${assumption}-${aIdx}`}>{assumption}</li>
                        ))
                      ) : (
                        <li>No assumptions listed.</li>
                      )}
                    </ul>
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No key claims returned.</p>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="rebuttals">
          <AccordionTrigger>
            My best rebuttals <Badge className="ml-2">{result.my_best_rebuttals.length}</Badge>
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <SectionCopyButton onCopy={() => copyValue("Best rebuttals", result.my_best_rebuttals)} />
            {result.my_best_rebuttals.length ? (
              result.my_best_rebuttals.map((item, idx) => (
                <Card key={`${item.rebuttal}-${idx}`}>
                  <CardHeader className="space-y-2 pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-sm">{item.rebuttal}</CardTitle>
                      <Badge variant={scoreTone(item.strength_score)}>
                        {item.strength_score}/100
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0">
                    <div>
                      <p className="text-xs text-muted-foreground">Reasoning</p>
                      <p className="text-sm">{item.reasoning}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Suggested phrasing</p>
                      <p className="rounded-md bg-muted/50 p-2 text-sm">{item.suggested_phrasing}</p>
                    </div>
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No rebuttals returned.</p>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="evidence">
          <AccordionTrigger>
            Evidence pack <Badge className="ml-2">{result.evidence_pack.length}</Badge>
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <SectionCopyButton onCopy={() => copyValue("Evidence pack", result.evidence_pack)} />
            {result.evidence_pack.length ? (
              result.evidence_pack.map((item, idx) => (
                <Card key={`${item.relevance}-${idx}`}>
                  <CardContent className="space-y-3 pt-4">
                    <div>
                      <p className="mb-1 text-xs text-muted-foreground">Key facts</p>
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {item.key_facts?.length ? (
                          item.key_facts.map((fact, fIdx) => <li key={`${fact}-${fIdx}`}>{fact}</li>)
                        ) : (
                          <li>No key facts listed.</li>
                        )}
                      </ul>
                    </div>
                    <div>
                      <p className="mb-1 text-xs text-muted-foreground">Sources</p>
                      <EvidenceSourceList sources={item.sources || []} />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Relevance</p>
                      <p className="text-sm">{item.relevance}</p>
                    </div>
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No evidence pack generated.</p>
            )}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="questions">
          <AccordionTrigger>
            Questions to clarify{" "}
            <Badge className="ml-2">{result.questions_to_clarify.length}</Badge>
          </AccordionTrigger>
          <AccordionContent className="space-y-2">
            <SectionCopyButton
              onCopy={() => copyValue("Questions to clarify", result.questions_to_clarify)}
            />
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {result.questions_to_clarify.length ? (
                result.questions_to_clarify.map((question, idx) => (
                  <li key={`${question}-${idx}`}>{question}</li>
                ))
              ) : (
                <li>No clarification questions returned.</li>
              )}
            </ul>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="risks">
          <AccordionTrigger>
            Risk flags <Badge className="ml-2">{result.risk_flags.length}</Badge>
          </AccordionTrigger>
          <AccordionContent className="space-y-2">
            <SectionCopyButton onCopy={() => copyValue("Risk flags", result.risk_flags)} />
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {result.risk_flags.length ? (
                result.risk_flags.map((risk, idx) => <li key={`${risk}-${idx}`}>{risk}</li>)
              ) : (
                <li>No risk flags returned.</li>
              )}
            </ul>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="talking-points">
          <AccordionTrigger>Talking points</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <SectionCopyButton onCopy={() => copyValue("Talking points", result.talking_points)} />
            <div className="grid gap-3 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">30-sec</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm">{result.talking_points["30-sec"]}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">2-min</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm">{result.talking_points["2-min"]}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">5-min</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm">{result.talking_points["5-min"]}</CardContent>
              </Card>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="confidence">
          <AccordionTrigger>Confidence & uncertainties</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <SectionCopyButton
              onCopy={() =>
                copyValue("Confidence and uncertainties", {
                  confidence: result.confidence,
                  uncertainties: result.uncertainties,
                })
              }
            />
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Confidence:</p>
              <Badge variant={scoreTone(result.confidence)}>{result.confidence}/100</Badge>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {result.uncertainties.length ? (
                result.uncertainties.map((uncertainty, idx) => (
                  <li key={`${uncertainty}-${idx}`}>{uncertainty}</li>
                ))
              ) : (
                <li>No explicit uncertainties listed.</li>
              )}
            </ul>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
