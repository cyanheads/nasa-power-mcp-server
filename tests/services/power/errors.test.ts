/** @fileoverview Error-data rendering shared by every POWER and canvas failure message. @module tests/services/power/errors */
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { describePowerError } from '@/services/power/errors.js';
import { markdownText } from '../../markdown-text.js';

const nasa422 =
  'Please provide at least on meteorology parameter for times prior to 1984-1-1; radiation parameters are not available until 1984-1-1. The request would return no data.';
/** Upstream text holding markup, a fence, a backslash and a line break. */
const hostile = 'source\n**literal** | ``` \\ value https://example.com/source';
const perLocation = 'NASA POWER rejected the request.\nstatus: 422\nmessages[0]: bad\nsource 422';

describe('describePowerError', () => {
  it.each<[string, string, Record<string, unknown>, string]>([
    [
      'a NASA rejection',
      'NASA POWER rejected the request.',
      { status: 422, messages: [nasa422] },
      `NASA POWER rejected the request.\nstatus: 422\nmessages[0]: ${nasa422}`,
    ],
    [
      'upstream markup and line breaks as written',
      'NASA POWER rejected the request.',
      { status: 422, messages: [hostile, ''] },
      `NASA POWER rejected the request.\nstatus: 422\nmessages[0]: ${hostile}\nmessages[1]: `,
    ],
    [
      'the retry delay beside the terms line',
      'NASA POWER rate limited this request.',
      { status: 429, messages: ['slow down'], retryAfter: '60' },
      'NASA POWER rate limited this request.\nstatus: 429\nmessages[0]: slow down\nretryAfter: 60',
    ],
    [
      'numbers, nulls and empty containers',
      'Refused.',
      { count: 21, limit: 20, missing: null, none: [], empty: {} },
      'Refused.\ncount: 21\nlimit: 20\nmissing: null\nnone: []\nempty: {}',
    ],
    [
      'nested failures whose messages keep their own lines',
      'Every requested NASA POWER location failed.',
      {
        failed: [
          {
            locationId: 'location_1',
            label: 'site\n**literal**',
            latitude: 40,
            reason: 'upstream_rejected',
            message: perLocation,
          },
        ],
      },
      `Every requested NASA POWER location failed.\nfailed[0].locationId: location_1\nfailed[0].label: site\n**literal**\nfailed[0].latitude: 40\nfailed[0].reason: upstream_rejected\nfailed[0].message: ${perLocation}`,
    ],
    [
      'only the message when every field is an envelope field',
      'Refused.',
      { reason: 'x', retryable: false, recovery: { hint: 'y' }, requestId: 'z', gone: undefined },
      'Refused.',
    ],
  ])('renders %s as one plain path: value line per fact', (_label, message, data, expected) => {
    const described = describePowerError(message, data);
    expect(described).toBe(expected);
    /** The framework escapes the message for content[]; CommonMark reads it back exactly. */
    expect(markdownText(`Error: ${escapeMarkdownInline(described)}`).replace(/\n$/, '')).toBe(
      `Error: ${described}`,
    );
  });
});
