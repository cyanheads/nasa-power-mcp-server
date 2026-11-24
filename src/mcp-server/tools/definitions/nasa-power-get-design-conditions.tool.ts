/** @fileoverview Retrieve POWER climatic design conditions for one point. @module mcp-server/tools/definitions/nasa-power-get-design-conditions.tool */
import { tool } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFaithfully } from '@/services/canvas/format.js';
import {
  DesignConditionsRequestSchema,
  DesignConditionsSchema,
  getPowerService,
  RECOVERIES,
} from '@/services/power/index.js';

/** ASHRAE-style design values NASA computes per point; the body is small, so no canvas. */
export const getDesignConditionsTool = tool('nasa_power_get_design_conditions', {
  title: 'Get NASA POWER design conditions',
  description:
    "Retrieve POWER's ASHRAE-style climatic design conditions for one latitude/longitude: 87 scalar indicators (heating and humidification, cooling, dehumidification and enthalpy, extreme annual and annual summaries) and 38 twelve-month arrays, January first, each with its POWER code, report section, label and units. NASA computes them for the requested point over whole calendar years; prefer them to rebuilding design percentiles from hourly nasa_power_get_timeseries data. Supply startYear and endYear together, or omit both for POWER's full configured coverage; a window outside that coverage or shorter than its minimum span is refused with the range in force, and request echoes the years sent. Values are metric only; fill values and absent months are null.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: DesignConditionsRequestSchema,
  output: DesignConditionsSchema,
  errors: [
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Years are unpaired, reversed, outside the configured coverage or span less than its minimum',
      recovery: RECOVERIES.invalid_window,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NASA rejects the design-conditions request',
      recovery: RECOVERIES.upstream_rejected,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'NASA responds with a rate limit',
      recovery: RECOVERIES.upstream_rate_limited,
      thrownBy: 'service',
      retryable: true,
    },
    {
      reason: 'request_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Source scheduling capacity is exhausted',
      recovery: RECOVERIES.request_queue_full,
      thrownBy: 'service',
      retryable: true,
    },
  ],
  handler(input, ctx) {
    return getPowerService().designConditions(input, ctx);
  },
  format: formatFaithfully,
});
