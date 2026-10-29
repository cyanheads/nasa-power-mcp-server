/** @fileoverview POWER parameter presets. @module services/power/presets */
import type { Resolution } from './types.js';
export const PRESETS = {
  solar_pv: ['ALLSKY_SFC_SW_DWN', 'ALLSKY_SFC_SW_DNI', 'ALLSKY_SFC_SW_DIFF', 'ALLSKY_KT', 'T2M'],
  wind_turbine: ['WS10M', 'WS50M', 'T2M'],
  building_hvac: ['T2M', 'RH2M', 'HDD18_3', 'CDD18_3'],
  agroclimatology: ['T2M', 'PRECTOTCORR', 'GWETROOT', 'GWETPROF', 'ALLSKY_SFC_SW_DWN'],
  water_balance: ['PRECTOTCORR', 'EVPTRNS', 'GWETROOT', 'GWETPROF'],
} as const;
/** Supported named parameter groups. */
export type Preset = keyof typeof PRESETS;
/** Non-hourly temperature extremes are source-period aggregates, not daily reconstructions. */
export function presetParameters(preset: Preset, resolution: Resolution): string[] {
  return [
    ...PRESETS[preset],
    ...(preset === 'agroclimatology' && resolution !== 'hourly' ? ['T2M_MAX', 'T2M_MIN'] : []),
  ];
}
/** Canonical NASA wind surfaces and their source long names. */
export const WIND_SURFACES = {
  vegtype_1: '35-m broadleaf-evergreen trees (70% coverage)',
  vegtype_2: '20-m broadleaf-deciduous trees (75% coverage)',
  vegtype_3: '20-m broadleaf and needleleaf trees (75% coverage)',
  vegtype_4: '17-m needleleaf-evergreen trees (75% coverage)',
  vegtype_5: '14-m needleleaf-deciduous trees (50% coverage)',
  vegtype_6: 'Savanna:18-m broadleaf trees (30%) & groundcover',
  vegtype_7: '0.6-m perennial groundcover (100%)',
  vegtype_8: '0.5-m broadleaf shrubs (variable %) & groundcover',
  vegtype_9: '0.5-m broadleaf shrubs (10%) with bare soil',
  vegtype_10: 'Tundra: 0.6-m trees/shrubs (variable %) & groundcover',
  vegtype_11: 'Rough bare soil',
  vegtype_12: 'Crop: 20-m broadleaf-deciduous trees (10%) & wheat',
  vegtype_20: 'Rough glacial snow/ice',
  seaice: 'Smooth sea ice',
  openwater: 'Open water',
  airportice: 'Airport: flat ice/snow',
  airportgrass: 'Airport: flat rough grass',
} as const;
/** Verified climatology alias; returned members remain dynamic. */
export const TILTED_ALIAS = 'SI_EF_TILTED_SURFACE';
/** Tilted and sun-tracker groups return `<group>_<mode>` members (`SI_TRACKER_AVG_DUAL`). */
const MODE_GROUP = /^SI_(?:TILTED|TRACKER)_(?:AVG|MIN|MAX)$/;
/** Hour groups: `<base>_HR` returns `<base>_00`…`_23`; `_HR_MAX`/`_HR_MIN` return `<base>_00_MAX`…. */
const HOUR_GROUP_MEMBER = {
  _HR: /^\d{2}$/,
  _HR_MAX: /^\d{2}_MAX$/,
  _HR_MIN: /^\d{2}_MIN$/,
} as const;
/**
 * Membership test for a requested group alias, or undefined when the code is not one. POWER
 * expands these aliases into member columns and never returns the alias itself. Families are
 * recognized by naming taken from captured responses, so members POWER adds to a known family
 * stay covered without a hand-listed code table.
 */
export function aliasMembership(code: string): ((returned: string) => boolean) | undefined {
  if (code === TILTED_ALIAS) return (returned) => returned.startsWith('SI_TILTED_');
  if (MODE_GROUP.test(code)) return (returned) => returned.startsWith(`${code}_`);
  for (const [suffix, member] of Object.entries(HOUR_GROUP_MEMBER)) {
    if (!code.endsWith(suffix)) continue;
    const prefix = `${code.slice(0, -suffix.length)}_`;
    return (returned) => returned.startsWith(prefix) && member.test(returned.slice(prefix.length));
  }
  return undefined;
}
