/**
 * Trade-Level Intelligence — injects real construction logic
 * including system interdependency, install sequencing, access
 * requirements, material compatibility, and water intrusion pathways.
 *
 * Auto-injected when dispute_type = scope, repairability, causation.
 */

const TRADE_TRIGGER_DISPUTES = new Set(["scope", "repairability", "causation"]);

// ── Static trade knowledge base ──────────────────────────────────────

const TRADE_KNOWLEDGE: Record<string, {
  interdependencies: string[];
  sequencing: string[];
  accessRequirements: string[];
  materialCompatibility: string[];
  waterIntrusionPaths: string[];
}> = {
  roofing: {
    interdependencies: [
      "Roof slopes share a common ridge; damage to one slope compromises the entire ridge system",
      "Flashing, drip edge, and underlayment must be continuous — partial replacement creates failure points",
      "Ventilation system (ridge vent, soffit vents) is integrated; damaged sections affect entire airflow",
      "Gutters and fascia are tied to roof edge — roof replacement typically requires gutter removal/reinstall",
    ],
    sequencing: [
      "Tear-off must occur before any new installation",
      "Underlayment must be installed before shingles",
      "Flashing must be woven with shingle courses during installation — cannot be added after",
      "Ridge cap is installed last; damaged ridge requires access to top courses",
    ],
    accessRequirements: [
      "Steep-slope work requires safety equipment and scaffolding",
      "Adjacent roof sections may need partial tear-off for proper tie-in",
      "Chimney and skylight flashing requires removal of surrounding shingles",
    ],
    materialCompatibility: [
      "Shingles from different production runs may not match in color or granule pattern",
      "Discontinued shingle lines cannot be spot-repaired to match",
      "Architectural shingles cannot be patched with 3-tab shingles",
      "Underlayment type must match building code requirements for the jurisdiction",
    ],
    waterIntrusionPaths: [
      "Damaged shingles expose underlayment; UV degrades underlayment within 30-90 days",
      "Cracked or missing flashing allows water behind wall envelope",
      "Ice dam areas require ice and water shield — patching creates gaps",
      "Valley damage allows water channeling into roof deck",
    ],
  },
  siding: {
    interdependencies: [
      "Siding runs are interlocking — individual panel replacement requires disengaging adjacent panels",
      "House wrap / WRB behind siding is part of the water management system",
      "Corner trim, J-channel, and starter strips integrate with siding runs",
      "Window and door flashing integrates with siding water management",
    ],
    sequencing: [
      "House wrap must be inspected/replaced before siding installation",
      "Starter strip must be level and properly positioned before first course",
      "Siding is installed bottom-up with proper overlap",
      "Trim and accessories are installed before or integrated with siding runs",
    ],
    accessRequirements: [
      "Upper-story siding requires scaffolding",
      "Siding removal may expose underlying damage requiring remediation",
      "Electrical boxes and penetrations must be properly flashed during reinstall",
    ],
    materialCompatibility: [
      "Vinyl siding fades with UV exposure — new panels will not match aged panels",
      "Wood siding species and grain must match for aesthetic continuity",
      "Fiber cement brands have different profiles that don't interchange",
      "Color matching across manufacturers is unreliable",
    ],
    waterIntrusionPaths: [
      "Cracked siding allows wind-driven rain behind the envelope",
      "Damaged J-channel at windows creates direct water entry path",
      "Missing or damaged kick-out flashing at roof-wall intersections causes wall saturation",
    ],
  },
  interior: {
    interdependencies: [
      "Water damage to ceilings often indicates roof or plumbing failure above",
      "Drywall damage may conceal mold growth in wall cavities",
      "Flooring damage from water may extend under baseboards and cabinets",
      "Insulation in walls/ceilings absorbs moisture and loses R-value",
    ],
    sequencing: [
      "Source of water must be remediated before interior repairs",
      "Mold remediation must precede drywall installation",
      "Drywall must be installed before texture, paint, and trim",
      "Flooring installed after walls and painting are complete",
    ],
    accessRequirements: [
      "Containment may be required for mold remediation",
      "Furniture and contents must be moved/protected",
      "HVAC ducts may need cleaning if water damage affected ductwork",
    ],
    materialCompatibility: [
      "Texture matching on ceilings and walls requires skilled labor",
      "Paint color matching across rooms for uniform appearance",
      "Flooring must match existing or be replaced in full rooms for continuity",
    ],
    waterIntrusionPaths: [
      "Roof leaks follow rafters and may emerge far from the breach point",
      "Pipe leaks in walls saturate insulation and travel down studs",
      "Window leaks may cause hidden damage inside wall cavities",
    ],
  },
  gutters: {
    interdependencies: [
      "Gutters connect to downspouts which connect to ground drainage",
      "Gutter hangers attach to fascia — damaged fascia means gutter reinstall",
      "Gutter slope must be maintained for proper drainage — partial replacement can disrupt slope",
    ],
    sequencing: [
      "Fascia must be sound before gutter installation",
      "Gutters installed after roofing is complete",
      "Downspout extensions and splash blocks last",
    ],
    accessRequirements: [
      "Ladder or lift access required for all gutter work",
      "Landscaping may need protection during gutter replacement",
    ],
    materialCompatibility: [
      "Aluminum, steel, and copper gutters cannot be mixed",
      "Gutter profiles (K-style, half-round) must match",
      "Color matching on painted gutters may not be possible with aged systems",
    ],
    waterIntrusionPaths: [
      "Clogged or damaged gutters cause fascia rot and soffit damage",
      "Overflowing gutters erode foundation areas",
      "Missing downspouts cause concentrated water pooling at foundation",
    ],
  },
};

export function shouldInjectTradeLogic(disputeType: string): boolean {
  return TRADE_TRIGGER_DISPUTES.has(disputeType);
}

export function getTradeIntelligence(trade: string | null, disputeType: string): string {
  if (!shouldInjectTradeLogic(disputeType)) return "";
  
  const tradeKey = (trade || "").toLowerCase().replace(/[^a-z]/g, "");
  
  // Map common trade names to our keys
  const tradeMap: Record<string, string> = {
    roofing: "roofing", roof: "roofing",
    siding: "siding", exterior: "siding",
    interior: "interior", drywall: "interior", flooring: "interior",
    gutters: "gutters", gutter: "gutters", downspout: "gutters",
  };
  
  const resolvedTrade = tradeMap[tradeKey] || null;
  if (!resolvedTrade || !TRADE_KNOWLEDGE[resolvedTrade]) return "";
  
  const knowledge = TRADE_KNOWLEDGE[resolvedTrade];
  const sections: string[] = [];
  
  if (disputeType === "scope" || disputeType === "repairability") {
    sections.push(`System Interdependencies:\n${knowledge.interdependencies.map(s => `- ${s}`).join("\n")}`);
    sections.push(`Install Sequencing:\n${knowledge.sequencing.map(s => `- ${s}`).join("\n")}`);
    sections.push(`Material Compatibility:\n${knowledge.materialCompatibility.map(s => `- ${s}`).join("\n")}`);
  }
  if (disputeType === "causation" || disputeType === "scope") {
    sections.push(`Water Intrusion Pathways:\n${knowledge.waterIntrusionPaths.map(s => `- ${s}`).join("\n")}`);
  }
  if (disputeType === "repairability" || disputeType === "scope") {
    sections.push(`Access & Tear-Off Requirements:\n${knowledge.accessRequirements.map(s => `- ${s}`).join("\n")}`);
  }
  
  return `=== TRADE INTELLIGENCE (${resolvedTrade.toUpperCase()}) ===\n${sections.join("\n\n")}\n=== END TRADE INTELLIGENCE ===`;
}
