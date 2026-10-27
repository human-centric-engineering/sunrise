import { describe, expect, it } from 'vitest';

import {
  modelParamOptions,
  narrowProviderTools,
  narrowServiceTier,
  narrowVerbosity,
  providerToolsSchema,
  spendWebSearches,
  withProviderTool,
} from '@/lib/orchestration/llm/model-params';

describe('modelParamOptions', () => {
  it('passes every set value through', () => {
    expect(
      modelParamOptions({
        stopSequences: ['END', '###'],
        topP: 0.9,
        verbosity: 'high',
        parallelToolCalls: false,
        serviceTier: 'priority',
      })
    ).toEqual({
      stopSequences: ['END', '###'],
      topP: 0.9,
      verbosity: 'high',
      parallelToolCalls: false,
      serviceTier: 'priority',
    });
  });

  it('leaves unset values out, so the provider default applies', () => {
    expect(
      modelParamOptions({
        stopSequences: [],
        topP: null,
        verbosity: null,
        parallelToolCalls: null,
        serviceTier: null,
        providerTools: null,
      })
    ).toEqual({});
    expect(modelParamOptions({})).toEqual({});
  });

  it('keeps a 0 top_p and an explicit true, which are settings, not absence', () => {
    expect(modelParamOptions({ topP: 0, parallelToolCalls: true })).toEqual({
      topP: 0,
      parallelToolCalls: true,
    });
  });

  it('drops a stored value outside its enum instead of forwarding it to a 400', () => {
    // The columns are plain TEXT; raw SQL or a fork's bundle can hold anything.
    expect(modelParamOptions({ verbosity: 'verbose', serviceTier: 'turbo' })).toEqual({});
  });

  it('drops whitespace-only stop sequences, which Anthropic refuses', () => {
    expect(modelParamOptions({ stopSequences: ['  ', '\t', 'END'] })).toEqual({
      stopSequences: ['END'],
    });
  });

  it('drops empty stop sequences and keeps at most four', () => {
    expect(modelParamOptions({ stopSequences: ['a', '', 'b', 'c', 'd', 'e'] })).toEqual({
      stopSequences: ['a', 'b', 'c', 'd'],
    });
  });
});

describe('narrowVerbosity / narrowServiceTier', () => {
  it('narrow known values and reject the rest', () => {
    expect(narrowVerbosity('medium')).toBe('medium');
    expect(narrowVerbosity('MEDIUM')).toBeUndefined();
    expect(narrowServiceTier('flex')).toBe('flex');
    expect(narrowServiceTier('scale')).toBeUndefined();
    expect(narrowServiceTier(null)).toBeUndefined();
  });
});

describe('provider tools (t-912)', () => {
  it('passes web search through, with its options', () => {
    expect(
      modelParamOptions({
        providerTools: { webSearch: { maxUses: 2, allowedDomains: ['example.com'] } },
      })
    ).toEqual({ providerTools: { webSearch: { maxUses: 2, allowedDomains: ['example.com'] } } });
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['an unknown tool', { fileSearch: {} }],
    ['a malformed search', { webSearch: { maxUses: 'lots' } }],
    ['both domain lists', { webSearch: { allowedDomains: ['a.com'], blockedDomains: ['b.com'] } }],
  ])('turns nothing on for %s', (_label, providerTools) => {
    expect(narrowProviderTools(providerTools)).toBeUndefined();
    expect(modelParamOptions({ providerTools })).toEqual({});
  });

  it('refuses both an allow and a block list, naming the block list', () => {
    const result = providerToolsSchema.safeParse({
      webSearch: { allowedDomains: ['a.com'], blockedDomains: ['b.com'] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['webSearch', 'blockedDomains']);
  });

  it('refuses an empty allow list, which would search every site', () => {
    const result = providerToolsSchema.safeParse({ webSearch: { allowedDomains: [] } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['webSearch', 'allowedDomains']);
  });

  it('takes an empty list beside a full one, as the form sends while one is being typed', () => {
    expect(
      providerToolsSchema.safeParse({
        webSearch: { allowedDomains: ['a.com'], blockedDomains: [] },
      }).success
    ).toBe(true);
  });

  it.each(['example.com', 'docs.example.com/guides', 'EXAMPLE.co.uk'])('accepts %s', (domain) => {
    expect(providerToolsSchema.safeParse({ webSearch: { allowedDomains: [domain] } }).success).toBe(
      true
    );
  });

  it.each(['https://example.com', 'example', 'exa mple.com', '-example.com', ''])(
    'refuses %j as a domain',
    (domain) => {
      expect(
        providerToolsSchema.safeParse({ webSearch: { blockedDomains: [domain] } }).success
      ).toBe(false);
    }
  );

  it.each([0, 21, 1.5])('refuses %s as a search limit', (maxUses) => {
    expect(providerToolsSchema.safeParse({ webSearch: { maxUses } }).success).toBe(false);
  });
});

describe('code execution tool (t-956)', () => {
  it('accepts it alone', () => {
    expect(providerToolsSchema.safeParse({ codeExecution: {} }).success).toBe(true);
    expect(narrowProviderTools({ codeExecution: {} })).toEqual({ codeExecution: {} });
    expect(modelParamOptions({ providerTools: { codeExecution: {} } })).toEqual({
      providerTools: { codeExecution: {} },
    });
  });

  it('accepts it beside web search, keeping both', () => {
    const both = { webSearch: { maxUses: 3 }, codeExecution: {} };
    expect(providerToolsSchema.safeParse(both).success).toBe(true);
    expect(narrowProviderTools(both)).toEqual(both);
  });

  it('refuses options on it, since it takes none', () => {
    expect(providerToolsSchema.safeParse({ codeExecution: { anything: 1 } }).success).toBe(false);
    expect(narrowProviderTools({ codeExecution: { anything: 1 } })).toBeUndefined();
    expect(
      narrowProviderTools({ webSearch: { maxUses: 2 }, codeExecution: { anything: 1 } })
    ).toBeUndefined();
  });
});

describe('withProviderTool', () => {
  it('sets a key and keeps the others', () => {
    expect(withProviderTool({ webSearch: { maxUses: 2 } }, 'codeExecution', {})).toEqual({
      webSearch: { maxUses: 2 },
      codeExecution: {},
    });
  });

  it('replaces a key that is already set', () => {
    expect(withProviderTool({ webSearch: { maxUses: 2 } }, 'webSearch', { maxUses: 7 })).toEqual({
      webSearch: { maxUses: 7 },
    });
  });

  it('turning one off keeps the others', () => {
    expect(
      withProviderTool({ webSearch: { maxUses: 2 }, codeExecution: {} }, 'codeExecution', null)
    ).toEqual({ webSearch: { maxUses: 2 } });
  });

  it('returns null when turning off the last one', () => {
    expect(withProviderTool({ codeExecution: {} }, 'codeExecution', null)).toBeNull();
  });

  it('starts from a null value', () => {
    expect(withProviderTool(null, 'codeExecution', {})).toEqual({ codeExecution: {} });
    expect(withProviderTool(null, 'codeExecution', null)).toBeNull();
  });

  it('does not mutate the value it was given', () => {
    const value = { webSearch: { maxUses: 2 }, codeExecution: {} };
    withProviderTool(value, 'codeExecution', null);
    expect(value).toEqual({ webSearch: { maxUses: 2 }, codeExecution: {} });
  });
});

describe('spendWebSearches', () => {
  it('takes the searches already run off the limit, keeping the whole limit', () => {
    expect(
      spendWebSearches({ model: 'm', providerTools: { webSearch: { maxUses: 5 } } }, 2)
    ).toEqual({ model: 'm', providerTools: { webSearch: { maxUses: 3, replyLimit: 5 } } });
  });

  it('stops at 0 rather than going below it', () => {
    expect(spendWebSearches({ providerTools: { webSearch: { maxUses: 2 } } }, 3)).toEqual({
      providerTools: { webSearch: { maxUses: 0, replyLimit: 2 } },
    });
  });

  it('keeps the agent’s limit, not what was left, when it is applied again (t-955)', () => {
    // Today's callers spend from the agent's own options each time. One that
    // spent from already-spent options must still send OpenAI the agent's
    // whole limit, not what was left.
    const once = spendWebSearches({ providerTools: { webSearch: { maxUses: 5 } } }, 2);
    expect(spendWebSearches(once, 2)).toEqual({
      providerTools: { webSearch: { maxUses: 1, replyLimit: 5 } },
    });
  });

  it('returns the options unchanged with no limit, or no search yet', () => {
    const unlimited = { providerTools: { webSearch: { allowedDomains: ['example.com'] } } };
    const limited = { providerTools: { webSearch: { maxUses: 2 } } };
    expect(spendWebSearches(unlimited, 4)).toBe(unlimited);
    expect(spendWebSearches(limited, 0)).toBe(limited);
    expect(spendWebSearches({}, 1)).toEqual({});
  });
});
