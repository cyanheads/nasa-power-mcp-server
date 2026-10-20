/** @fileoverview Filter a complete pair-specific POWER dictionary. @module mcp-server/tools/definitions/nasa-power-search-parameters.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatFaithfully } from '@/services/canvas/format.js';
import {
  CommunitySchema,
  DictionaryEntrySchema,
  getPowerService,
  ResolutionSchema,
} from '@/services/power/index.js';

const SearchEntrySchema = DictionaryEntrySchema.extend({
  code: z.string().describe('Exact source parameter code'),
});

/** Resolve exact source codes before requesting observations. */
export const searchParametersTool = tool('nasa_power_search_parameters', {
  title: 'Search NASA POWER parameters',
  description:
    'Find parameter codes supported by a community and temporalResolution. Every whitespace-separated filter token must match code, name or definition, ignoring case. Filtering covers the complete dictionary before sorted pagination. Blank filter browses all codes; pass returned codes to a producing tool.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({
    community: CommunitySchema.default('RE'),
    temporalResolution: ResolutionSchema.default('daily'),
    filter: z
      .string()
      .max(256)
      .default('')
      .describe('Local case-insensitive code/name/definition token filter'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based offset within all filtered matches'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum entries returned, 1 through 100'),
  }),
  output: z.object({
    community: CommunitySchema,
    temporalResolution: ResolutionSchema,
    filter: z.string().describe('Effective local token filter'),
    offset: z.number().describe('Requested filtered offset'),
    limit: z.number().describe('Requested maximum entry count'),
    total: z.number().describe('Total matches across the complete dictionary'),
    hasMore: z.boolean().describe('Whether another filtered page follows'),
    truncated: z.boolean().describe('Whether matching entries remain after this page'),
    entries: z
      .array(SearchEntrySchema.describe('One complete source dictionary entry'))
      .describe('Matching complete source entries'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when the complete filter has no matches'),
  },
  errors: [
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'NASA rate limits dictionary retrieval',
      recovery:
        'Wait for the reported retry delay before repeating this request; reuse an existing result when possible.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'request_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Source scheduling capacity is exhausted',
      recovery: 'Wait for pending requests to finish, then retry a smaller request.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'dataset_limit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Dictionary response exceeds the bounded source body limit',
      recovery:
        'Narrow the date window, region, selected parameters, or location count and retry the producing tool.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NASA rejects dictionary retrieval',
      recovery:
        'Inspect the returned NASA messages, then use nasa_power_list_reference topic coverage or nasa_power_search_parameters to revise the request.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const dictionary = await getPowerService().dictionary(
      input.community,
      input.temporalResolution,
      ctx,
    );
    const tokens = input.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = Object.entries(dictionary)
      .filter(([code, entry]) => {
        const text = [code, entry.name, entry.definition]
          .filter((value) => value !== undefined)
          .join(' ')
          .toLowerCase();
        return tokens.every((token) => text.includes(token));
      })
      .sort(([left], [right]) => left.localeCompare(right));
    ctx.signal.throwIfAborted();
    if (matches.length === 0)
      ctx.enrich.notice(
        'No parameters matched this filter for the selected community and temporal resolution. Broaden filter or use nasa_power_list_reference topic presets.',
      );
    return {
      ...input,
      total: matches.length,
      hasMore: input.offset + input.limit < matches.length,
      truncated: input.offset + input.limit < matches.length,
      entries: matches
        .slice(input.offset, input.offset + input.limit)
        .map(([code, entry]) => SearchEntrySchema.parse({ ...entry, code })),
    };
  },
  format: formatFaithfully,
});
