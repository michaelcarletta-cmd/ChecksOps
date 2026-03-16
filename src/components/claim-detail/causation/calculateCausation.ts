import {
  CausationFormData,
  CausationResult,
  IndicatorBreakdown,
  IndicatorState,
} from './types';
import { ALL_INDICATORS, PERILS } from './indicators';

function joinDamageTypes(damageTypes: string[]): string {
  if (!damageTypes.length) return 'reported damage';
  if (damageTypes.length === 1) return damageTypes[0].toLowerCase();
  if (damageTypes.length === 2) {
    return `${damageTypes[0].toLowerCase()} and ${damageTypes[1].toLowerCase()}`;
  }
  return `${damageTypes.slice(0, -1).map(d => d.toLowerCase()).join(', ')}, and ${damageTypes[damageTypes.length - 1].toLowerCase()}`;
}

function buildCounterfactualQuestion(peril: string, damageTypes: string[]): string {
  const has = (text: string) => damageTypes.some(d => d.toLowerCase().includes(text));

  if (peril === 'wind') {
    if (has('missing shingles') || has('shingle creasing') || has('lifting')) {
      return 'If not for wind, would the shingles be missing or creased?';
    }
    if (has('flashing')) {
      return 'If not for wind, would the flashing be displaced or damaged?';
    }
    return 'If not for wind, would the reported damage be present?';
  }

  if (peril === 'ice') {
    if (has('water intrusion')) {
      return 'If not for the weight of snow and ice, would there be interior water damage?';
    }
    return 'If not for the weight of snow and ice, would the reported damage be present?';
  }

  if (peril === 'hail') {
    if (has('bruising') || has('soft spots') || has('punctures')) {
      return 'If not for hail impact, would these impact marks be present?';
    }
    return 'If not for hail impact, would the reported damage be present?';
  }

  if (peril === 'water') {
    if (has('water intrusion')) {
      return 'If not for water intrusion, would the interior damage be present?';
    }
    return 'If not for water, would the reported damage be present?';
  }

  return `If not for ${peril.toLowerCase()}, would the reported damage be present?`;
}

function buildBaselineContext(formData: CausationFormData, perilLabel: string): string {
  const roofAgeNum = parseInt(formData.roofAge || '', 10);

  if (!roofAgeNum) return '';

  if (roofAgeNum < 5) {
    return `The roof is relatively young (${roofAgeNum} years old), which makes ordinary age-related failure a less persuasive explanation absent specific contrary evidence.`;
  }

  if (roofAgeNum < 15) {
    return `The roof is approximately ${roofAgeNum} years old. Age may affect susceptibility, but susceptibility is not the same as cause. The question remains whether ${perilLabel.toLowerCase()} caused the reported condition.`;
  }

  return `The roof is approximately ${roofAgeNum} years old. Age and prior wear may increase vulnerability, but they do not by themselves explain why the reported damage appeared in the documented pattern and timing.`;
}

export function calculateCausation(formData: CausationFormData): CausationResult {
  const perilLabel =
    PERILS.find((p) => p.value === formData.perilTested)?.label || formData.perilTested || 'the reported peril';

  const damageText = joinDamageTypes(formData.damageTypes);

  const indicatorBreakdown: IndicatorBreakdown[] = ALL_INDICATORS.map((indicator) => {
    const state: IndicatorState = formData.indicators[indicator.id]?.state || 'unknown';

    return {
      id: indicator.id,
      label: indicator.label,
      state,
      isPositive: indicator.isPositive,
      category: indicator.category,
    };
  });

  const supportingObservations = indicatorBreakdown.filter(
    (i) => i.isPositive && i.state === 'present'
  );

  const opposingObservations = indicatorBreakdown.filter(
    (i) => !i.isPositive && i.state === 'present'
  );

  const unknownObservations = indicatorBreakdown.filter((i) => i.state === 'unknown');

  const evidenceGaps: string[] = [];

  if (!formData.eventDate) evidenceGaps.push('Date of reported event is not documented.');
  if (!formData.damageNoticedDate) evidenceGaps.push('Date damage was first noticed is not documented.');
  if (!formData.weatherEvidence?.trim()) evidenceGaps.push('Weather or event documentation is not provided.');
  if (!formData.observationsNotes?.trim() && supportingObservations.length === 0) {
    evidenceGaps.push('No narrative field observations have been entered.');
  }

  const coreSupportCount = supportingObservations.filter(
    (i) => i.category === 'core_evidence'
  ).length;

  const hasAffirmativeAlternative = opposingObservations.length > 0;
  const hasMeaningfulSupport = coreSupportCount > 0 || supportingObservations.length >= 2;

  let decision: 'supported' | 'not_supported' | 'indeterminate' = 'indeterminate';
  let decisionLabel = 'More Documentation Needed';
  let directAnswer = '';
  let conclusion = '';
  let reasoningSummary = '';

  if (hasMeaningfulSupport && !hasAffirmativeAlternative) {
    decision = 'supported';
    decisionLabel = 'Causation Supported';
    directAnswer = `No. Based on the documented observations, the ${damageText} would not reasonably be expected in the same form absent ${perilLabel.toLowerCase()}.`;
    conclusion = `${perilLabel} is the most supported cause of the reported damage based on the currently documented observations.`;
    reasoningSummary =
      supportingObservations.length > 0
        ? `This conclusion is supported by documented observations including ${supportingObservations
            .slice(0, 3)
            .map((i) => i.label.toLowerCase())
            .join(', ')}.`
        : `This conclusion is supported by the currently documented file materials.`;
  } else if (!hasMeaningfulSupport && hasAffirmativeAlternative) {
    decision = 'not_supported';
    decisionLabel = 'Causation Not Supported';
    directAnswer = `Yes, based on the current file, the reported condition could exist without ${perilLabel.toLowerCase()} because affirmative alternative-cause evidence has been documented.`;
    conclusion = `The current file does not support ${perilLabel.toLowerCase()} as the most supported cause of the reported damage.`;
    reasoningSummary = `This is due to documented alternative-cause observations including ${opposingObservations
      .slice(0, 3)
      .map((i) => i.label.toLowerCase())
      .join(', ')}.`;
  } else {
    decision = 'indeterminate';
    decisionLabel = 'More Documentation Needed';
    directAnswer = `It cannot yet be determined from the current documentation whether the ${damageText} would exist absent ${perilLabel.toLowerCase()}.`;
    conclusion = `The current file does not yet contain enough clear documented observations to firmly answer the counterfactual question.`;
    if (supportingObservations.length > 0 && opposingObservations.length > 0) {
      reasoningSummary = `There is evidence pointing in both directions. The file contains support for ${perilLabel.toLowerCase()} causation, but it also contains documented alternative-cause issues that must be addressed directly.`;
    } else if (supportingObservations.length > 0) {
      reasoningSummary = `Some observations support ${perilLabel.toLowerCase()} causation, but the file still needs clearer documentation before the conclusion can be stated firmly.`;
    } else if (opposingObservations.length > 0) {
      reasoningSummary = `Alternative-cause issues are documented, but the file does not yet clearly establish whether they fully explain the reported condition.`;
    } else {
      reasoningSummary = `The file currently lacks enough documented observations to make a firm causation statement.`;
    }
  }

  const carrierBurdenStatement =
    `If the carrier contends that ${perilLabel.toLowerCase()} did not cause the reported damage, it should identify what specific cause did, and point to the documented facts supporting that alternative explanation.`;

  const baselineContext = buildBaselineContext(formData, perilLabel);

  return {
    decision,
    decisionLabel,
    counterfactualQuestion: buildCounterfactualQuestion(perilLabel, damageText),
    directAnswer,
    conclusion,
    reasoningSummary,
    supportingObservations,
    opposingObservations,
    unknownObservations,
    evidenceGaps,
    carrierBurdenStatement,
    baselineContext,
    rebuttalSummary:
      formData.carrierBlameTactics.length > 0
        ? `${formData.carrierBlameTactics.length} carrier blame-shifting argument(s) were identified for rebuttal.`
        : undefined,
  };
}
