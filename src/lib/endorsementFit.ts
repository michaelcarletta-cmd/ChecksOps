export type EndorsementFitInput = {
  signerCount: number;
  zoneHeightPx: number;
  requestedScale: number;
};

export type EndorsementLayoutPreset = {
  fontSize: number;
  lineGap: number;
  rowGap: number;
  signatureHeight: number;
  columns: 1 | 2;
  compactText: boolean;
  scale: number;
};

export type EndorsementMeasuredLayout = EndorsementLayoutPreset & {
  estimatedHeight: number;
};

const PRESETS: EndorsementLayoutPreset[] = [
  {
    fontSize: 28,
    lineGap: 18,
    rowGap: 24,
    signatureHeight: 110,
    columns: 1,
    compactText: false,
    scale: 1,
  },
  {
    fontSize: 24,
    lineGap: 14,
    rowGap: 18,
    signatureHeight: 92,
    columns: 1,
    compactText: true,
    scale: 0.92,
  },
  {
    fontSize: 22,
    lineGap: 12,
    rowGap: 14,
    signatureHeight: 78,
    columns: 2,
    compactText: true,
    scale: 0.86,
  },
  {
    fontSize: 20,
    lineGap: 10,
    rowGap: 10,
    signatureHeight: 64,
    columns: 2,
    compactText: true,
    scale: 0.8,
  },
];

function estimateHeaderHeight(preset: EndorsementLayoutPreset) {
  const headerLines = preset.compactText ? 2 : 3;
  return headerLines * (preset.fontSize + preset.lineGap);
}

function estimateSignerBlockHeight(
  signerCount: number,
  preset: EndorsementLayoutPreset,
) {
  const rows = preset.columns === 2 ? Math.ceil(signerCount / 2) : signerCount;
  const perRow = preset.fontSize + 8 + preset.signatureHeight + preset.rowGap;
  return rows * perRow;
}

export function measurePreset(
  signerCount: number,
  preset: EndorsementLayoutPreset,
): EndorsementMeasuredLayout {
  const headerHeight = estimateHeaderHeight(preset);
  const signerHeight = estimateSignerBlockHeight(signerCount, preset);
  const footerHeight = preset.fontSize + preset.lineGap + preset.signatureHeight + 20;

  return {
    ...preset,
    estimatedHeight: Math.ceil(headerHeight + signerHeight + footerHeight),
  };
}

export function fitEndorsementLayout({
  signerCount,
  zoneHeightPx,
  requestedScale,
}: EndorsementFitInput): EndorsementMeasuredLayout {
  const userScale = requestedScale || 1;

  // Pick the largest preset that leaves vertical room to drag the endorsement.
  // We require the block to be no more than ~65% of the zone so the user has
  // meaningful freedom of placement; fall back to a strict fit if nothing
  // satisfies that, and finally to the smallest preset.
  const PLACEMENT_HEADROOM = 0.65;
  let basePreset: EndorsementLayoutPreset | null = null;
  for (const preset of PRESETS) {
    const measured = measurePreset(signerCount, preset);
    if (measured.estimatedHeight <= zoneHeightPx * PLACEMENT_HEADROOM) {
      basePreset = preset;
      break;
    }
  }
  if (!basePreset) {
    for (const preset of PRESETS) {
      const measured = measurePreset(signerCount, preset);
      if (measured.estimatedHeight <= zoneHeightPx) {
        basePreset = preset;
        break;
      }
    }
  }
  if (!basePreset) basePreset = PRESETS[PRESETS.length - 1];

  // Apply user scale to all dimensions directly (not as CSS transform)
  const scaled: EndorsementLayoutPreset = {
    ...basePreset,
    fontSize: Math.round(basePreset.fontSize * userScale),
    lineGap: Math.round(basePreset.lineGap * userScale),
    rowGap: Math.round(basePreset.rowGap * userScale),
    signatureHeight: Math.round(basePreset.signatureHeight * userScale),
    scale: userScale,
  };

  return measurePreset(signerCount, scaled);
}
