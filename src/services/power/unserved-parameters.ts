/** @fileoverview Dictionary codes NASA POWER lists but does not serve at a resolution. @module services/power/unserved-parameters */
import type { Resolution } from './types.js';

/** Family recoveries; daily GDD values are per-day totals, so their sum is the period total. */
const RECOVERIES = {
  growing_degree_days:
    'Growing degree day codes (GDD4_4, GDD7_2, GDD10, GDD13_3, GDD15_6) are served only at daily resolution: request the window at daily (for a climatology, its start and end years) and sum the daily values for each month, season or year, averaging those sums across years for a climatological value.',
  hour_extremes:
    'Hour-of-day maximum and minimum groups (codes such as ALLSKY_SFC_SW_DWN_HR_MAX and ALLSKY_SFC_SW_DWN_HR_MIN) are served only as climatology: request them at climatology resolution, or request the matching hour group (such as ALLSKY_SFC_SW_DWN_HR) at monthly resolution for hour-of-day monthly values.',
} as const;
type Family = keyof typeof RECOVERIES;

const GDD = ['GDD4_4', 'GDD7_2', 'GDD10', 'GDD13_3', 'GDD15_6'];
const HOUR_EXTREMES = [
  'ALLSKY_SFC_SW_DIFF_HR_MAX',
  'ALLSKY_SFC_SW_DIFF_HR_MIN',
  'ALLSKY_SFC_SW_DNI_HR_MAX',
  'ALLSKY_SFC_SW_DNI_HR_MIN',
  'ALLSKY_SFC_SW_DWN_HR_MAX',
  'ALLSKY_SFC_SW_DWN_HR_MIN',
];
const family = (codes: string[], name: Family) => codes.map((code) => [code, name] as const);

/**
 * Every community's dictionary lists these codes at the resolution, yet POWER's data endpoints
 * answer HTTP 500 for them (regional monthly `GDD*` returns only fill values). Found by requesting
 * every monthly and climatology dictionary code in AG, RE and SB on 2026-10-28, then confirmed at a
 * second location and window. No dictionary field separates them from served codes, so they are
 * curated here; re-sweep when POWER changes its products.
 */
const UNSERVED: Partial<Record<Resolution, ReadonlyMap<string, Family>>> = {
  monthly: new Map([
    ...family(GDD, 'growing_degree_days'),
    ...family(HOUR_EXTREMES, 'hour_extremes'),
  ]),
  climatology: new Map(family(GDD, 'growing_degree_days')),
};

/**
 * The requested codes POWER does not serve at this resolution, with the recoveries of the
 * families present, or undefined when every code is served.
 */
export function unservedParameters(
  codes: readonly string[],
  resolution: Resolution,
): { parameters: string[]; recovery: string } | undefined {
  const table = UNSERVED[resolution];
  if (!table) return undefined;
  const parameters = codes.filter((code) => table.has(code));
  if (!parameters.length) return undefined;
  const families = new Set(parameters.flatMap((code) => table.get(code) ?? []));
  return {
    parameters,
    recovery: [...families].map((name) => RECOVERIES[name]).join(' '),
  };
}
