export const DEMAND_PACKAGE_RULES = {
  forbiddenIfUnsupported: [
    "siding damage",
    "hail damage",
    "freeze damage",
    "vinyl siding",
    "cracked siding",
    "punctured siding",
    "displaced siding",
  ],
  requiredWhenDetected: [
    "fence",
    "chain link",
    "tree impact",
    "other structures",
  ],
};

export function warnOnDemandPackageMismatch(sourceText: string) {
  const lower = sourceText.toLowerCase();
  return {
    hasFenceEvidence:
      /chain link fence|fence damaged by tree|tree clean up|other structures/.test(lower),
    excludesHail:
      /no hail damage was found/.test(lower),
    excludesElevations:
      /no damage found to the front, right, back, and left elevations/.test(lower),
    brickExterior:
      /main material:\s*brick|brick block/.test(lower),
  };
}
