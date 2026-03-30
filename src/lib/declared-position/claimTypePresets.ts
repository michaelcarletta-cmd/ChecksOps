export const CLAIM_TYPE_PRESETS: Record<string, Partial<Record<string, string>>> = {
  roof_repairability: {
    requested_remedy: "full roof replacement",
    coverage_trigger_theory:
      "Coverage is triggered because direct physical loss damaged covered roofing materials during the policy period and compliant partial repair is not technically feasible.",
  },
  water_loss: {
    coverage_trigger_theory:
      "Coverage is triggered because a covered water event caused direct physical loss to covered property during the policy period.",
  },
  fire_smoke: {
    coverage_trigger_theory:
      "Coverage is triggered because fire and resulting smoke caused direct physical loss to covered property during the policy period.",
  },
  repairability_dispute: {
    requested_remedy: "payment for full elevation or continuous material replacement based on repairability",
  },
};
