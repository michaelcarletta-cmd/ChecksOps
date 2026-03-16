import { CausationIndicator } from './types';

export const PERIL_SUPPORTING_INDICATORS: CausationIndicator[] = [
  {
    id: 'directional_pattern',
    category: 'core_evidence',
    label: 'Directional damage pattern documented',
    description: 'Damage shows a directional pattern consistent with the reported peril.',
    isPositive: true,
  },
  {
    id: 'displaced_missing_materials',
    category: 'core_evidence',
    label: 'Displaced or missing roofing materials documented',
    description: 'Materials are missing, displaced, or lifted in a manner consistent with external force.',
    isPositive: true,
  },
  {
    id: 'collateral_same_exposure',
    category: 'core_evidence',
    label: 'Collateral damage on the same exposure documented',
    description: 'Other components on the same exposure show related damage.',
    isPositive: true,
  },
  {
    id: 'storm_plus_localized_damage',
    category: 'core_evidence',
    label: 'Storm event verified and damage is localized rather than uniform',
    description: 'A weather event is documented and the damage is not simply uniform aging.',
    isPositive: true,
  },
  {
    id: 'lifted_tabs',
    category: 'secondary',
    label: 'Lifted or creased tabs documented',
    description: 'Tabs are lifted or creased in a manner consistent with wind uplift.',
    isPositive: true,
  },
  {
    id: 'debris_scatter_pattern',
    category: 'secondary',
    label: 'Debris scatter pattern documented',
    description: 'Debris distribution is consistent with the reported event direction.',
    isPositive: true,
  },
  {
    id: 'edge_damage_concentration',
    category: 'secondary',
    label: 'Damage concentrated at edges or ridges',
    description: 'Damage appears where wind exposure is typically greatest.',
    isPositive: true,
  },
  {
    id: 'neighboring_property_damage',
    category: 'secondary',
    label: 'Neighboring properties show similar event damage',
    description: 'Nearby structures show damage from the same event.',
    isPositive: true,
  },
  {
    id: 'fence_siding_damage',
    category: 'secondary',
    label: 'Fence or siding damage documented',
    description: 'Other exterior components show related event damage.',
    isPositive: true,
  },
  {
    id: 'verified_weather_event',
    category: 'event',
    label: 'Weather event verified',
    description: 'Weather documentation confirms an event near the reported date.',
    isPositive: true,
  },
  {
    id: 'immediate_notice',
    category: 'timeline',
    label: 'Damage noticed soon after event',
    description: 'Damage was discovered close in time to the reported event.',
    isPositive: true,
  },
  {
    id: 'fresh_fractures',
    category: 'physical',
    label: 'Fresh fractures or recent physical distress documented',
    description: 'Observed conditions appear recent rather than long-weathered.',
    isPositive: true,
  },
];

export const ALTERNATIVE_CAUSE_INDICATORS: CausationIndicator[] = [
  {
    id: 'uniform_wear_all_slopes',
    category: 'alternative',
    label: 'Uniform wear across all slopes documented',
    description: 'Condition appears uniform rather than exposure-specific.',
    isPositive: false,
  },
  {
    id: 'damage_predates_event',
    category: 'alternative',
    label: 'Damage predates the reported event',
    description: 'Records show the condition existed before the reported date of loss.',
    isPositive: false,
  },
  {
    id: 'no_weather_event_documented',
    category: 'alternative',
    label: 'No weather event documented near the reported date',
    description: 'Available weather data does not corroborate the reported event.',
    isPositive: false,
  },
  {
    id: 'installation_defect_documented',
    category: 'alternative',
    label: 'Installation defect documented as the condition source',
    description: 'There is affirmative documentation of installation-related failure.',
    isPositive: false,
  },
  {
    id: 'prior_damage_same_location',
    category: 'alternative',
    label: 'Prior damage or repair at same location documented',
    description: 'Records show prior issues in the same area.',
    isPositive: false,
  },
];

export const ALL_INDICATORS = [
  ...PERIL_SUPPORTING_INDICATORS,
  ...ALTERNATIVE_CAUSE_INDICATORS,
];

export const PERILS = [
  { value: 'wind', label: 'Wind' },
  { value: 'hail', label: 'Hail' },
  { value: 'water', label: 'Water / Rain' },
  { value: 'fire', label: 'Fire' },
  { value: 'ice', label: 'Ice / Snow' },
  { value: 'falling_object', label: 'Falling Object / Tree' },
];

export const DAMAGE_TYPES = [
  'Shingle creasing/lifting',
  'Missing shingles',
  'Granule loss',
  'Punctures/holes',
  'Flashing damage',
  'Gutter damage',
  'Siding damage',
  'Bruising/soft spots',
  'Water intrusion',
  'Structural damage',
  'Other',
];

export const SHINGLE_TYPES = [
  { value: '3_tab', label: '3-Tab Shingles' },
  { value: 'architectural', label: 'Architectural / Dimensional' },
  { value: 'metal', label: 'Metal Roofing' },
  { value: 'tile', label: 'Tile Roofing' },
  { value: 'slate', label: 'Slate' },
  { value: 'wood_shake', label: 'Wood Shake' },
  { value: 'unknown', label: 'Unknown' },
];
