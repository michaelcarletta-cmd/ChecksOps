import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { 
  Shield, 
  AlertTriangle, 
  Hammer, 
  Wrench, 
  Factory, 
  UserX, 
  Copy, 
  ChevronDown,
  Camera,
  FileText,
  CheckCircle2,
  XCircle
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface CarrierBlameTactic {
  id: string;
  type: 'installation' | 'maintenance' | 'manufacturing' | 'manipulation';
  label: string;
  carrierClaim: string;
  counterArguments: string[];
  evidenceNeeded: {
    item: string;
    description: string;
    photoGuidance?: string;
    critical: boolean;
  }[];
  technicalCitations: string[];
}

const BLAME_TACTICS: CarrierBlameTactic[] = [
  // Installation Defects
  {
    id: 'improper_nailing',
    type: 'installation',
    label: 'Improper Nailing Pattern',
    carrierClaim: 'Shingles failed due to high nailing, overdriven fasteners, or insufficient fastener count.',
    counterArguments: [
      'If improper nailing were the proximate cause, damage would have manifested during the first significant wind event after installation—not years later.',
      'Per ARMA Technical Bulletin 201, aged shingles with factory seal strip degradation can lift even when properly fastened.',
      'High nailing alone does not cause shingle loss; it becomes a factor ONLY when combined with wind forces that exceed the diminished resistance of aged materials.',
      'The burden is on the carrier to prove the specific fastener pattern at the EXACT location of each damaged shingle—not to extrapolate from a sample.',
      'Wind damage patterns (directional consistency, edge concentration) are inconsistent with random installation defect patterns.'
    ],
    evidenceNeeded: [
      { item: 'Original permit/inspection records', description: 'Shows roof passed inspection at installation', critical: true },
      { item: 'Photos of intact fasteners on damaged shingles', description: 'Document that fasteners are still in place even though shingle is damaged', photoGuidance: 'Photograph the nail strip area showing fastener holes and any remaining nail shafts. Include a ruler for scale.', critical: true },
      { item: 'Pattern documentation', description: 'Show damage is directionally consistent, not random', photoGuidance: 'Wide shots showing damage concentrated on specific exposures (e.g., west-facing slopes)', critical: true },
      { item: 'Shingle age documentation', description: 'Invoices, permits, or manufacturer date codes', critical: false },
      { item: 'Weather event documentation', description: 'NOAA data, NWS reports showing wind event', critical: true }
    ],
    technicalCitations: [
      'ARMA TB-201: Factory seal strips degrade with atmospheric exposure',
      'ASTM D3161 ratings apply to NEW materials, not aged shingles',
      'IRC R905.2.6: Four fasteners per shingle is code-minimum, not warranty standard'
    ]
  },
  {
    id: 'seal_strip_failure',
    type: 'installation',
    label: 'Seal Strip Never Activated',
    carrierClaim: 'Shingles lifted because seal strips never properly bonded after installation.',
    counterArguments: [
      'If seal strips never activated, the first post-installation windstorm would have caused failures—not an event years later.',
      'Manufacturer guidelines require installation during warm weather for immediate seal; however, thermal cycling and summer heat will activate seals over subsequent months.',
      'Per ARMA, seal strips naturally degrade over time even when properly activated—this is atmospheric aging, not installation failure.',
      'Photos of the seal strip area will show residue or tar patterns indicating prior adhesion that subsequently failed due to age and UV exposure.',
      'The carrier cannot prove seal strips "never" activated without destructive testing at the time of installation.'
    ],
    evidenceNeeded: [
      { item: 'Photos of seal strip residue', description: 'Shows tar or adhesive residue indicating prior bond', photoGuidance: 'Close-up photos of the underside of lifted tabs showing adhesive residue patterns, staining, or transfer marks', critical: true },
      { item: 'Installation date/season', description: 'If installed in warm months, sealing would have occurred', critical: false },
      { item: 'Roof age documentation', description: 'Extended service life proves initial bonding occurred', critical: true },
      { item: 'No prior wind damage claims', description: 'Shows roof survived previous storms', critical: false }
    ],
    technicalCitations: [
      'ARMA: Seal strips require 70°F+ and direct sunlight; thermal cycling achieves this',
      'Manufacturer installation guidelines specify conditions, not guarantees',
      'Atmospheric aging degrades seal strip adhesion over time regardless of initial bond strength'
    ]
  },
  // Maintenance Failures
  {
    id: 'lack_of_maintenance',
    type: 'maintenance',
    label: 'Lack of Maintenance',
    carrierClaim: 'Damage resulted from failure to maintain the roof, not a covered peril.',
    counterArguments: [
      'Homeowners have no duty to "maintain" shingles—they are designed to be maintenance-free for their rated lifespan.',
      'There is no industry-standard "maintenance schedule" for residential asphalt shingles that would have prevented wind/hail damage.',
      'The carrier must identify the SPECIFIC maintenance task that was omitted AND prove that task would have prevented THIS damage.',
      'Normal weathering and aging is NOT lack of maintenance—it is expected material degradation.',
      'Pre-existing wear does not exclude coverage for subsequent storm damage; the peril accelerates or completes the failure.'
    ],
    evidenceNeeded: [
      { item: 'Manufacturer maintenance requirements', description: 'Most manufacturers have NONE for residential shingles', critical: true },
      { item: 'Photos of non-damaged areas', description: 'Shows overall roof condition was acceptable', photoGuidance: 'Wide shots of undamaged slopes showing shingles are generally intact and functional', critical: true },
      { item: 'Storm damage patterns', description: 'Directional damage proves external force, not neglect', critical: true },
      { item: 'Policy language review', description: 'Most policies do not require specific maintenance', critical: false }
    ],
    technicalCitations: [
      'Asphalt shingle manufacturers do not prescribe homeowner maintenance schedules',
      'NRCA: Shingle roofs require professional inspection only after significant events',
      'Wear and tear exclusion does not apply to sudden/accidental storm damage'
    ]
  },
  {
    id: 'debris_accumulation',
    type: 'maintenance',
    label: 'Debris/Moss Accumulation',
    carrierClaim: 'Debris accumulation or organic growth caused shingle deterioration.',
    counterArguments: [
      'Debris accumulation in valleys is NORMAL and does not void coverage for wind or hail damage.',
      'Moss/algae growth affects aesthetics but does not compromise shingle structural integrity per manufacturer literature.',
      'The carrier must prove a CAUSAL link between debris and THIS specific damage—not merely the presence of debris.',
      'Wind can blow debris ONTO the roof during the same event that causes damage—debris presence is evidence of the storm, not neglect.',
      'If debris caused the damage, the pattern would be localized to accumulation areas, not directionally consistent.'
    ],
    evidenceNeeded: [
      { item: 'Photos showing damage away from debris areas', description: 'Damage in clean areas proves debris is not the cause', photoGuidance: 'Document damage locations relative to valleys and debris accumulation areas', critical: true },
      { item: 'Directional damage pattern', description: 'Wind/hail patterns are independent of debris location', critical: true },
      { item: 'Photos of debris deposited by storm', description: 'Fresh debris from the event itself', photoGuidance: 'Photograph leaves, branches, or debris that appear freshly deposited', critical: false }
    ],
    technicalCitations: [
      'ARMA: Algae discoloration is cosmetic; does not affect performance',
      'Manufacturer warranties exclude ONLY staining, not functional failure from growth',
      'Debris in valleys is a natural occurrence, not maintenance failure'
    ]
  },
  // Manufacturing Defects
  {
    id: 'manufacturing_defect',
    type: 'manufacturing',
    label: 'Manufacturing Defect',
    carrierClaim: 'Shingles failed due to manufacturing defects, not storm damage.',
    counterArguments: [
      'If a manufacturing defect exists, the carrier should pursue subrogation against the manufacturer—not deny the insured.',
      'Manufacturing defects manifest uniformly across the installation, not in directional patterns consistent with wind.',
      'The carrier must produce metallurgical/laboratory analysis proving the specific defect—not speculation.',
      'Class action settlements (IKO, Atlas, etc.) do not mean every roof has defective shingles—specific proof is required.',
      'Even if a latent defect exists, the COVERED PERIL (wind/hail) was the proximate cause that exploited the defect.'
    ],
    evidenceNeeded: [
      { item: 'Photos showing non-uniform damage', description: 'Defects would affect all shingles equally; storm damage is directional', photoGuidance: 'Wide shots showing damage concentrated on windward slopes, not random distribution', critical: true },
      { item: 'Sample shingles for lab analysis', description: 'Physical samples from damaged vs. undamaged areas', critical: true },
      { item: 'Manufacturer batch/lot information', description: 'From packaging or date codes on shingles', critical: false },
      { item: 'No prior class action involvement', description: 'This specific product may not be affected', critical: false },
      { item: 'Weather event documentation', description: 'Proves external force coincided with failure', critical: true }
    ],
    technicalCitations: [
      'Concurrent causation doctrine: covered peril can exploit latent defect',
      'ASTM D3018: Defines shingle composition standards—carrier must prove deviation',
      'Insurance policy covers "direct physical loss"—the wind/hail IS the loss trigger'
    ]
  },
  // Manipulation/Fraud Allegations
  {
    id: 'manipulation_fraud',
    type: 'manipulation',
    label: 'Manipulation / Fraudulent Damage',
    carrierClaim: 'Damage was caused by human manipulation, not natural causes.',
    counterArguments: [
      'Fraud allegations require PROOF BEYOND SPECULATION—the carrier must identify the specific individual, means, and opportunity.',
      'Creasing patterns from foot traffic are distinguishable from wind creasing: foot traffic creates random, multi-directional marks; wind creates linear, directional patterns.',
      'If manipulation occurred, the carrier should file a police report and pursue criminal charges—not merely deny coverage.',
      'The presence of a contractor or adjuster on the roof does not prove manipulation; walking inspections are industry standard.',
      'Manipulation allegations without forensic evidence are bad faith claim handling tactics.',
      'Time-stamped photos from initial inspection can prove damage existed before any alleged manipulation.'
    ],
    evidenceNeeded: [
      { item: 'Time-stamped initial inspection photos', description: 'Proves damage existed before access by others', photoGuidance: 'Ensure camera/phone timestamps are visible; photograph date-stamped newspapers if needed', critical: true },
      { item: 'Directional consistency documentation', description: 'Manipulation would be random; wind is directional', photoGuidance: 'Wide shots showing damage concentrated on specific exposures', critical: true },
      { item: 'Collateral damage photos', description: 'Siding, fences, outbuildings showing same event damage', photoGuidance: 'Photograph all property damage in consistent direction', critical: true },
      { item: 'Neighbor reports/photos', description: 'Area-wide damage proves natural event', critical: false },
      { item: 'Weather event documentation', description: 'NOAA/NWS data proving significant wind/hail event occurred', critical: true },
      { item: 'Chain of custody log', description: 'Document who accessed the roof and when', critical: true }
    ],
    technicalCitations: [
      'HAAG Engineering: Wind creasing creates linear patterns along shingle length',
      'Foot traffic damage: circular/oval depressions, multi-directional scuffing',
      'Bad faith: Fraud allegations without evidence may constitute unfair claims practice'
    ]
  },
  {
    id: 'contractor_caused',
    type: 'manipulation',
    label: 'Contractor-Caused Damage',
    carrierClaim: 'The roofing contractor or inspector caused or exaggerated the damage.',
    counterArguments: [
      'Initial inspection photos predate any contractor involvement and document pre-existing damage.',
      'Contractors walking a roof for inspection follow industry-standard practices; minimal foot traffic does not cause shingle failure.',
      'If the carrier believes the contractor caused damage, they should pursue the contractor directly—not deny the insured.',
      'The damage pattern is inconsistent with localized foot traffic: it spans multiple slopes and aligns with prevailing wind direction.',
      'Carriers who raise this defense should be required to produce their OWN initial inspection documentation for comparison.'
    ],
    evidenceNeeded: [
      { item: 'Homeowner photos before contractor visit', description: 'Damage documented before any professional access', photoGuidance: 'Have homeowner take photos immediately after the storm, before calling anyone', critical: true },
      { item: 'Dated documentation timeline', description: 'Shows damage reported before contractor involvement', critical: true },
      { item: 'Carrier adjuster photos', description: 'Their own documentation confirms pre-existing damage', critical: true },
      { item: 'Multi-slope damage documentation', description: 'Foot traffic would be localized; wind affects multiple areas', critical: true },
      { item: 'Contractor insurance/license', description: 'Licensed professionals follow industry standards', critical: false }
    ],
    technicalCitations: [
      'NRCA: Roof inspections require walking the surface—industry standard practice',
      'Proper inspection technique distributes weight and avoids damage',
      'Insurance bad faith: Blaming the contractor without evidence is dilatory tactic'
    ]
  }
];

interface CausationBlameCounterSectionProps {
  selectedTactics: string[];
  onTacticsChange: (tactics: string[]) => void;
  onEvidenceCheck: (tacticId: string, evidenceItem: string, checked: boolean) => void;
  checkedEvidence: Record<string, string[]>;
}

export const CausationBlameCounterSection = ({
  selectedTactics,
  onTacticsChange,
  onEvidenceCheck,
  checkedEvidence = {}
}: CausationBlameCounterSectionProps) => {
  const [expandedTactic, setExpandedTactic] = useState<string | null>(null);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'installation': return Hammer;
      case 'maintenance': return Wrench;
      case 'manufacturing': return Factory;
      case 'manipulation': return UserX;
      default: return AlertTriangle;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'installation': return 'bg-orange-500/10 text-orange-700 border-orange-500/30';
      case 'maintenance': return 'bg-blue-500/10 text-blue-700 border-blue-500/30';
      case 'manufacturing': return 'bg-purple-500/10 text-purple-700 border-purple-500/30';
      case 'manipulation': return 'bg-red-500/10 text-red-700 border-red-500/30';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'installation': return 'Installation Defect';
      case 'maintenance': return 'Maintenance Failure';
      case 'manufacturing': return 'Manufacturing Defect';
      case 'manipulation': return 'Manipulation/Fraud';
      default: return type;
    }
  };

  const handleTacticToggle = (tacticId: string) => {
    if (selectedTactics.includes(tacticId)) {
      onTacticsChange(selectedTactics.filter(t => t !== tacticId));
    } else {
      onTacticsChange([...selectedTactics, tacticId]);
    }
  };

  const copyCounterArguments = (tactic: CarrierBlameTactic) => {
    let text = `COUNTER-ARGUMENTS: ${tactic.label}\n`;
    text += `${'='.repeat(50)}\n\n`;
    text += `CARRIER CLAIM:\n"${tactic.carrierClaim}"\n\n`;
    text += `REBUTTAL POINTS:\n`;
    tactic.counterArguments.forEach((arg, i) => {
      text += `${i + 1}. ${arg}\n\n`;
    });
    text += `TECHNICAL CITATIONS:\n`;
    tactic.technicalCitations.forEach(cite => {
      text += `• ${cite}\n`;
    });
    
    navigator.clipboard.writeText(text);
    toast.success('Counter-arguments copied to clipboard');
  };

  const getEvidenceCompleteness = (tacticId: string) => {
    const tactic = BLAME_TACTICS.find(t => t.id === tacticId);
    if (!tactic) return { checked: 0, total: 0, critical: 0, criticalChecked: 0 };
    
    const checked = checkedEvidence[tacticId]?.length || 0;
    const total = tactic.evidenceNeeded.length;
    const criticalItems = tactic.evidenceNeeded.filter(e => e.critical);
    const criticalChecked = criticalItems.filter(e => 
      checkedEvidence[tacticId]?.includes(e.item)
    ).length;
    
    return { checked, total, critical: criticalItems.length, criticalChecked };
  };

  // Group tactics by type
  const tacticsByType = BLAME_TACTICS.reduce((acc, tactic) => {
    if (!acc[tactic.type]) acc[tactic.type] = [];
    acc[tactic.type].push(tactic);
    return acc;
  }, {} as Record<string, CarrierBlameTactic[]>);

  return (
    <Card className="border-destructive/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-5 w-5 text-destructive" />
          Carrier Blame Counter-Arguments
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Select the blame-shifting tactics the carrier is using to generate counter-arguments and evidence checklists.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {Object.entries(tacticsByType).map(([type, tactics]) => {
          const TypeIcon = getTypeIcon(type);
          return (
            <div key={type} className="space-y-2">
              <div className="flex items-center gap-2">
                <TypeIcon className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{getTypeLabel(type)}</span>
              </div>
              
              <div className="grid gap-2 md:grid-cols-2 pl-6">
                {tactics.map(tactic => {
                  const isSelected = selectedTactics.includes(tactic.id);
                  const completeness = getEvidenceCompleteness(tactic.id);
                  
                  return (
                    <div
                      key={tactic.id}
                      className={cn(
                        "rounded-lg border p-3 transition-all cursor-pointer",
                        isSelected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                      )}
                      onClick={() => handleTacticToggle(tactic.id)}
                    >
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => handleTacticToggle(tactic.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{tactic.label}</p>
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                            {tactic.carrierClaim}
                          </p>
                          {isSelected && (
                            <div className="flex items-center gap-2 mt-2">
                              <Badge variant="outline" className="text-xs">
                                {completeness.criticalChecked}/{completeness.critical} critical
                              </Badge>
                              <Badge variant="secondary" className="text-xs">
                                {completeness.checked}/{completeness.total} evidence
                              </Badge>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Expanded Details for Selected Tactics */}
        {selectedTactics.length > 0 && (
          <div className="pt-4 border-t space-y-4">
            <h4 className="font-medium text-sm flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Counter-Arguments & Evidence Requirements
            </h4>
            
            <Accordion type="single" collapsible value={expandedTactic || undefined} onValueChange={(v) => setExpandedTactic(v || null)}>
              {selectedTactics.map(tacticId => {
                const tactic = BLAME_TACTICS.find(t => t.id === tacticId);
                if (!tactic) return null;
                
                const TypeIcon = getTypeIcon(tactic.type);
                
                return (
                  <AccordionItem key={tactic.id} value={tactic.id} className="border rounded-lg px-4">
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center gap-2 text-left">
                        <TypeIcon className="h-4 w-4" />
                        <span>{tactic.label}</span>
                        <Badge variant="outline" className={cn("text-xs ml-2", getTypeColor(tactic.type))}>
                          {getTypeLabel(tactic.type)}
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      {/* Carrier Claim */}
                      <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                        <p className="text-xs font-medium text-destructive mb-1">Carrier claims:</p>
                        <p className="text-sm italic">"{tactic.carrierClaim}"</p>
                      </div>
                      
                      {/* Counter-Arguments */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium">Rebuttal Points</p>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyCounterArguments(tactic)}
                            className="h-7 text-xs"
                          >
                            <Copy className="h-3 w-3 mr-1" />
                            Copy All
                          </Button>
                        </div>
                        <div className="space-y-2">
                          {tactic.counterArguments.map((arg, i) => (
                            <div key={i} className="flex gap-2 text-sm p-2 bg-muted/30 rounded">
                              <span className="text-primary font-bold shrink-0">{i + 1}.</span>
                              <span>{arg}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* Technical Citations */}
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Technical Citations</p>
                        <div className="space-y-1">
                          {tactic.technicalCitations.map((cite, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                              <span>•</span>
                              <span>{cite}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* Evidence Checklist */}
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Camera className="h-4 w-4" />
                          <p className="text-sm font-medium">Evidence Requirements</p>
                        </div>
                        <div className="space-y-2">
                          {tactic.evidenceNeeded.map((evidence, i) => {
                            const isChecked = checkedEvidence[tactic.id]?.includes(evidence.item);
                            
                            return (
                              <div 
                                key={i} 
                                className={cn(
                                  "border rounded-lg p-3 transition-all",
                                  isChecked ? "bg-green-500/5 border-green-500/30" : "bg-background"
                                )}
                              >
                                <div className="flex items-start gap-2">
                                  <Checkbox
                                    checked={isChecked}
                                    onCheckedChange={(checked) => 
                                      onEvidenceCheck(tactic.id, evidence.item, !!checked)
                                    }
                                  />
                                  <div className="flex-1 space-y-1">
                                    <div className="flex items-center gap-2">
                                      <span className={cn(
                                        "text-sm font-medium",
                                        isChecked && "line-through text-muted-foreground"
                                      )}>
                                        {evidence.item}
                                      </span>
                                      {evidence.critical && (
                                        <Badge variant="destructive" className="text-xs h-5">
                                          Critical
                                        </Badge>
                                      )}
                                      {isChecked && (
                                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                                      )}
                                    </div>
                                    <p className="text-xs text-muted-foreground">{evidence.description}</p>
                                    {evidence.photoGuidance && (
                                      <div className="mt-2 p-2 bg-primary/5 border border-primary/20 rounded text-xs">
                                        <div className="flex items-center gap-1 text-primary font-medium mb-1">
                                          <Camera className="h-3 w-3" />
                                          Photo Guidance:
                                        </div>
                                        <p className="text-muted-foreground">{evidence.photoGuidance}</p>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default CausationBlameCounterSection;
