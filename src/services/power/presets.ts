/** @fileoverview POWER parameter presets. @module services/power/presets */
export const PRESETS = {
  solar_pv: ['ALLSKY_SFC_SW_DWN', 'ALLSKY_SFC_SW_DNI', 'ALLSKY_SFC_SW_DIFF', 'ALLSKY_KT', 'T2M'],
  wind_turbine: ['WS10M', 'WS50M', 'T2M'],
  building_hvac: ['T2M', 'RH2M', 'HDD18_3', 'CDD18_3'],
  agroclimatology: ['T2M', 'PRECTOTCORR', 'GWETROOT', 'GWETPROF', 'ALLSKY_SFC_SW_DWN'],
  water_balance: ['PRECTOTCORR', 'EVPTRNS', 'GWETROOT', 'GWETPROF'],
} as const;
/** Supported named parameter groups. */
export type Preset = keyof typeof PRESETS;
/** Verified climatology alias; returned members remain dynamic. */
export const TILTED_ALIAS = 'SI_EF_TILTED_SURFACE';
