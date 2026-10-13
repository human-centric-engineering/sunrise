/**
 * Tests: lib/privacy/org-source-registry.ts (§109 t-737)
 *
 * The fork half of the org export and of its coverage guard. As with the
 * subject registry, the weight is on what happens when a declaration is WRONG:
 *
 *   1. A malformed row is dropped AND logged, so the model stays unaccounted and
 *      the coverage guard fails naming it. Dropping must never look like
 *      accepting.
 *   2. A throwing init rolls the registry back and latches
 *      `appOrgDeclarationsFailed()`, which is what makes `exportOrgData()`
 *      refuse rather than ship a bundle short of the fork's tables.
 *
 * FORK NOTE — nothing here needs adjusting when you fill the seam. The suite
 * drives `registerAppOrgSources()` directly and stubs `@/lib/app/org-export`.
 *
 * @see lib/privacy/org-source-registry.ts
 * @see lib/app/org-export.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockInitAppOrgSources = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app/org-export', () => ({
  initAppOrgSources: () => mockInitAppOrgSources(),
}));

import {
  registerAppOrgSources,
  getAppOrgSources,
  getAppExcludedOrgSources,
  getAccountedAppOrgModels,
  appOrgDeclarationsFailed,
  __resetAppOrgSourceRegistryForTests,
  type AppOrgDataSource,
} from '@/lib/privacy/org-source-registry';

const fetchRows = vi.fn(async () => []);

const VALID: AppOrgDataSource = {
  model: 'AppInvoice',
  section: 'invoices',
  disposition: 'export',
  description: 'Invoices raised against the org.',
  fetch: fetchRows,
};

const REASON = 'Reference list of countries — no org data.';

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppOrgSourceRegistryForTests();
  mockInitAppOrgSources.mockReset();
});

/** Make the lazy init run `register` when a read first triggers it. */
function seam(register: () => void): void {
  mockInitAppOrgSources.mockImplementation(register);
}

/** The reject log line for `model`, whatever its reason. */
function expectRejected(tier: string, model: string, reason: string | RegExp): void {
  expect(mockLogger.error).toHaveBeenCalledWith('org-sources: declaration rejected', {
    tier,
    model,
    reason: typeof reason === 'string' ? reason : expect.stringMatching(reason),
  });
}

describe('registerAppOrgSources', () => {
  it('records a well-formed source, and the read runs the seam once', () => {
    seam(() => registerAppOrgSources({ tier: 'app', sources: [VALID] }));

    expect(getAppOrgSources()).toEqual([VALID]);
    getAppOrgSources();
    expect(mockInitAppOrgSources).toHaveBeenCalledTimes(1);
  });

  it('trims model and section, so the guard matches on the clean name', () => {
    seam(() =>
      registerAppOrgSources({
        tier: 'app',
        sources: [{ ...VALID, model: '  AppInvoice ', section: ' invoices ' }],
      })
    );

    expect(getAppOrgSources()).toEqual([VALID]);
    expect(getAccountedAppOrgModels().has('AppInvoice')).toBe(true);
  });

  it('records an exclusion with its reason, and counts it as accounted', () => {
    seam(() =>
      registerAppOrgSources({
        tier: 'app',
        sources: [VALID],
        excluded: [{ model: 'AppCountry', reason: REASON }],
      })
    );

    expect(getAppExcludedOrgSources()).toEqual([{ model: 'AppCountry', reason: REASON }]);
    expect([...getAccountedAppOrgModels()].sort()).toEqual(['AppCountry', 'AppInvoice']);
  });

  it('lets two tiers declare independently', () => {
    seam(() => {
      registerAppOrgSources({
        tier: 'framework',
        sources: [{ ...VALID, model: 'FrameworkTask', section: 'tasks' }],
      });
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
    });

    expect(getAppOrgSources().map((s) => s.model)).toEqual(['FrameworkTask', 'AppInvoice']);
  });

  it('is idempotent by model for the same tier', () => {
    seam(() => {
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
    });

    expect(getAppOrgSources()).toHaveLength(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('lets the same tier re-register an exclusion without complaint', () => {
    seam(() => {
      registerAppOrgSources({ tier: 'app', excluded: [{ model: 'AppCountry', reason: REASON }] });
      registerAppOrgSources({ tier: 'app', excluded: [{ model: 'AppCountry', reason: REASON }] });
    });

    expect(getAppExcludedOrgSources()).toHaveLength(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('accepts a contribution with neither sources nor exclusions', () => {
    seam(() => registerAppOrgSources({ tier: 'app' }));

    expect(getAppOrgSources()).toEqual([]);
    expect(getAppExcludedOrgSources()).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  describe('rows it refuses — each is logged and stays unaccounted', () => {
    const cases: Array<{
      why: string;
      source: Partial<AppOrgDataSource>;
      model: string;
      reason: string | RegExp;
    }> = [
      {
        why: 'an empty model name',
        source: { model: '  ' },
        model: '  ',
        reason: 'model is empty',
      },
      {
        why: 'a section that does not match core’s shape',
        source: { section: 'Bad-Section' },
        model: 'AppInvoice',
        reason: /^section must match /,
      },
      {
        why: 'an empty section',
        source: { section: '' },
        model: 'AppInvoice',
        reason: /^section must match /,
      },
      {
        why: 'a disposition that is neither of the two',
        // The type forbids it; a fork's JS or a config value does not.
        source: { disposition: 'delete' as unknown as 'export' },
        model: 'AppInvoice',
        reason: `disposition must be 'export' or 'attribution'`,
      },
      {
        why: 'a description of 20 characters (core requires more than 20)',
        source: { description: 'x'.repeat(20) },
        model: 'AppInvoice',
        reason: 'description must be at least 21 characters',
      },
      {
        why: 'a section that is a built-in object member',
        source: { section: 'toString' },
        model: 'AppInvoice',
        reason: "section 'toString' is a built-in object member",
      },
      {
        why: 'a description that is not a string',
        // A fork's JS can pass anything; it must be dropped, not thrown.
        source: { description: 42 as unknown as string },
        model: 'AppInvoice',
        reason: 'description must be at least 21 characters',
      },
      {
        why: 'a fetch that is not a function',
        source: { fetch: 'nope' as unknown as AppOrgDataSource['fetch'] },
        model: 'AppInvoice',
        reason: 'fetch must be a function',
      },
    ];

    it.each(cases)('refuses $why', ({ source, model, reason }) => {
      seam(() => registerAppOrgSources({ tier: 'app', sources: [{ ...VALID, ...source }] }));

      expect(getAppOrgSources()).toEqual([]);
      expect(getAccountedAppOrgModels().has('AppInvoice')).toBe(false);
      expectRejected('app', model, reason);
      // A dropped source is a missing table: the export must refuse.
      expect(appOrgDeclarationsFailed()).toBe(true);
    });

    it('latches failure for a rejected exclusion too', () => {
      seam(() =>
        registerAppOrgSources({ tier: 'app', excluded: [{ model: 'AppCountry', reason: 'x' }] })
      );

      expect(appOrgDeclarationsFailed()).toBe(true);
    });

    it.each([
      ['a null source', { sources: [null, VALID] }, 'null', 'source is not an object'],
      [
        'a non-object exclusion',
        { excluded: ['AppCountry'] },
        'string',
        'exclusion is not an object',
      ],
    ])(
      'drops %s with a log instead of throwing, keeping the valid rows',
      (_label, rows, model, reason) => {
        seam(() =>
          registerAppOrgSources({
            tier: 'app',
            ...(rows as unknown as Omit<Parameters<typeof registerAppOrgSources>[0], 'tier'>),
          })
        );

        // The read runs the lazy init; only then is there a log to check.
        expect(appOrgDeclarationsFailed()).toBe(true);
        expectRejected('app', model, reason);
        // Not a throw: the gate did not roll the tier back.
        expect(mockLogger.error).not.toHaveBeenCalledWith(
          expect.stringContaining('rolled back'),
          expect.anything()
        );
        if ('sources' in rows) expect(getAppOrgSources()).toEqual([VALID]);
      }
    );

    it('accepts a description of exactly 21 characters', () => {
      // The boundary, matching core's `> 20`: 20 is refused above, 21 must not be.
      seam(() =>
        registerAppOrgSources({
          tier: 'app',
          sources: [{ ...VALID, description: 'x'.repeat(21) }],
        })
      );

      expect(getAppOrgSources()).toHaveLength(1);
    });

    it('refuses a model already claimed by another tier, naming the owner', () => {
      seam(() => {
        registerAppOrgSources({ tier: 'framework', sources: [VALID] });
        registerAppOrgSources({ tier: 'app', sources: [{ ...VALID, section: 'billing' }] });
      });

      // First claim wins; the second is logged, not silently merged.
      expect(getAppOrgSources()).toEqual([VALID]);
      expectRejected('app', 'AppInvoice', "already declared by tier 'framework'");
    });

    it('refuses a second source on a section already in use', () => {
      // Two models under one key would have one overwrite the other inside
      // `bundle.app` — silent loss, with both still counted as declared.
      seam(() =>
        registerAppOrgSources({
          tier: 'app',
          sources: [VALID, { ...VALID, model: 'AppCredit' }],
        })
      );

      expect(getAppOrgSources()).toEqual([VALID]);
      expect(getAccountedAppOrgModels().has('AppCredit')).toBe(false);
      expectRejected('app', 'AppCredit', "section 'invoices' is already used by AppInvoice");
    });

    it('refuses an exclusion whose reason is under 20 characters', () => {
      seam(() =>
        registerAppOrgSources({
          tier: 'app',
          excluded: [{ model: 'AppCountry', reason: 'x'.repeat(19) }],
        })
      );

      expect(getAppExcludedOrgSources()).toEqual([]);
      expect(getAccountedAppOrgModels().has('AppCountry')).toBe(false);
      expectRejected('app', 'AppCountry', 'reason must be at least 20 characters');
    });

    it('refuses an exclusion with an empty model name', () => {
      seam(() =>
        registerAppOrgSources({ tier: 'app', excluded: [{ model: '   ', reason: REASON }] })
      );

      expect(getAppExcludedOrgSources()).toEqual([]);
      expectRejected('app', '   ', 'model is empty');
    });

    it('refuses an exclusion for a model already declared as a source', () => {
      seam(() =>
        registerAppOrgSources({
          tier: 'app',
          sources: [VALID],
          excluded: [{ model: 'AppInvoice', reason: 'Changed my mind halfway down the file.' }],
        })
      );

      expect(getAppOrgSources()).toEqual([VALID]);
      expect(getAppExcludedOrgSources()).toEqual([]);
      expectRejected(
        'app',
        'AppInvoice',
        'already declared as a source — a model is one or the other'
      );
    });

    it('refuses an exclusion for a model another tier already excluded', () => {
      seam(() => {
        registerAppOrgSources({
          tier: 'framework',
          excluded: [{ model: 'SharedTag', reason: 'Join table owned by the framework tier.' }],
        });
        registerAppOrgSources({
          tier: 'app',
          excluded: [{ model: 'SharedTag', reason: 'Trying to write off another tier’s table.' }],
        });
      });

      expect(getAppExcludedOrgSources()).toEqual([
        { model: 'SharedTag', reason: 'Join table owned by the framework tier.' },
      ]);
      expectRejected('app', 'SharedTag', "already declared by tier 'framework'");
    });

    it('survives rows whose fields are missing entirely', () => {
      // `undefined.trim()` would throw out of the seam and take the whole
      // contribution (and the rollback) with it; a fork's JS has no type guard.
      seam(() =>
        registerAppOrgSources({
          tier: 'app',
          sources: [
            { ...VALID, model: undefined as unknown as string },
            { ...VALID, model: 'A', section: undefined as unknown as string },
            { ...VALID, model: 'B', description: undefined as unknown as string },
          ],
          excluded: [
            { model: undefined as unknown as string, reason: REASON },
            { model: 'C', reason: undefined as unknown as string },
          ],
        })
      );

      expect(getAppOrgSources()).toEqual([]);
      expect(getAppExcludedOrgSources()).toEqual([]);
      expect(getAccountedAppOrgModels().size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledTimes(5);
      expectRejected('app', 'undefined', 'model is empty');
    });
  });

  describe('a source superseding an exclusion', () => {
    it('replaces it, logs a warning with the old reason, and moves ownership', () => {
      seam(() => {
        registerAppOrgSources({
          tier: 'app',
          excluded: [{ model: 'AppInvoice', reason: 'Decided this is not the org’s data.' }],
        });
        registerAppOrgSources({ tier: 'app', sources: [VALID] });
      });

      expect(getAppOrgSources()).toEqual([VALID]);
      expect(getAppExcludedOrgSources()).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'org-sources: a source declaration replaced an exclusion',
        {
          tier: 'app',
          model: 'AppInvoice',
          previousOwner: 'app',
          previousReason: 'Decided this is not the org’s data.',
        }
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('lets a leaf tier supersede a framework tier’s exclusion', () => {
      // The cross-tier case that actually happens: the framework writes off a
      // shared table, the leaf knows it holds org data. The duplicate-tier
      // refusal must not fire when what is being replaced is an exclusion.
      seam(() => {
        registerAppOrgSources({
          tier: 'framework',
          excluded: [{ model: 'SharedTag', reason: 'Framework tier sees no org data here.' }],
        });
        registerAppOrgSources({
          tier: 'app',
          sources: [{ ...VALID, model: 'SharedTag', section: 'tags' }],
        });
      });

      expect(getAppOrgSources().map((s) => s.model)).toEqual(['SharedTag']);
      expect(getAppExcludedOrgSources()).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'org-sources: a source declaration replaced an exclusion',
        expect.objectContaining({ tier: 'app', model: 'SharedTag', previousOwner: 'framework' })
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('does NOT destroy the exclusion when the superseding source is itself rejected', () => {
      // The ordering bug: deleting the exclusion before the section-collision
      // check let a source that never entered the registry take a valid
      // exclusion with it, leaving the model unaccounted and `meta.excluded`
      // silent about it.
      seam(() => {
        registerAppOrgSources({
          tier: 'app',
          sources: [VALID],
          excluded: [{ model: 'AppCountry', reason: REASON }],
        });
        // Same section as VALID → rejected by the collision check.
        registerAppOrgSources({ tier: 'app', sources: [{ ...VALID, model: 'AppCountry' }] });
      });

      expect(getAppExcludedOrgSources()).toEqual([{ model: 'AppCountry', reason: REASON }]);
      expect(getAccountedAppOrgModels().has('AppCountry')).toBe(true);
      expect(getAppOrgSources()).toEqual([VALID]);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expectRejected('app', 'AppCountry', "section 'invoices' is already used by AppInvoice");
    });
  });
});

describe('which rejections make the export refuse', () => {
  it('does NOT refuse when a rejected exclusion’s model is exported by another tier', () => {
    // Leaf declares the source, then the framework tier it calls excludes the
    // same model: the exclusion is rejected, but nothing is missing.
    seam(() => {
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
      registerAppOrgSources({
        tier: 'framework',
        excluded: [{ model: 'AppInvoice', reason: REASON }],
      });
    });

    expect(appOrgDeclarationsFailed()).toBe(false);
    expectRejected('framework', 'AppInvoice', /already declared as a source/);
    expect(getAppOrgSources()).toEqual([VALID]);
  });

  it('does NOT refuse when a rejected cross-tier duplicate source is already exported', () => {
    seam(() => {
      registerAppOrgSources({ tier: 'framework', sources: [VALID] });
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
    });

    expect(appOrgDeclarationsFailed()).toBe(false);
    expectRejected('app', 'AppInvoice', "already declared by tier 'framework'");
  });

  it('does NOT refuse once a rejected source is re-registered correctly', () => {
    seam(() => {
      registerAppOrgSources({ tier: 'app', sources: [{ ...VALID, description: 'short' }] });
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
    });

    expect(appOrgDeclarationsFailed()).toBe(false);
  });

  it('refuses when a rejected source’s model is only EXCLUDED elsewhere — its rows are missing', () => {
    seam(() => {
      registerAppOrgSources({
        tier: 'framework',
        excluded: [{ model: 'AppInvoice', reason: REASON }],
      });
      // Supersede would apply, but this source is malformed, so it is rejected
      // and the table the fork meant to export is not in the bundle.
      registerAppOrgSources({ tier: 'app', sources: [{ ...VALID, fetch: undefined as never }] });
    });

    expect(appOrgDeclarationsFailed()).toBe(true);
  });

  it('refuses for a row that named no model, whatever else is registered', () => {
    seam(() => registerAppOrgSources({ tier: 'app', sources: [VALID, { ...VALID, model: '' }] }));

    expect(appOrgDeclarationsFailed()).toBe(true);
  });

  it('labels a non-string model safely, even one with no prototype', () => {
    seam(() =>
      registerAppOrgSources({
        tier: 'app',
        sources: [{ ...VALID, model: Object.create(null) as string }],
      })
    );

    expect(appOrgDeclarationsFailed()).toBe(true);
    expectRejected('app', 'object', 'model is empty');
  });
});

describe('what an exclusion carries into the bundle', () => {
  it('keeps exactly model and a trimmed reason, whatever else the fork passed', () => {
    seam(() =>
      registerAppOrgSources({
        tier: 'app',
        excluded: [
          {
            model: 'AppCountry',
            reason: `  ${REASON}  `,
            internalNote: 'not for the customer',
          } as unknown as { model: string; reason: string },
        ],
      })
    );

    expect(getAppExcludedOrgSources()).toEqual([{ model: 'AppCountry', reason: REASON }]);
  });

  it('hands out copies, so a reader mutating one cannot change the registry', () => {
    seam(() =>
      registerAppOrgSources({ tier: 'app', excluded: [{ model: 'AppCountry', reason: REASON }] })
    );

    getAppExcludedOrgSources()[0].reason = 'tampered';
    expect(getAppExcludedOrgSources()[0].reason).toBe(REASON);
  });
});

describe('a throwing init', () => {
  it('rolls back the declarations it managed before the throw', () => {
    seam(() => {
      registerAppOrgSources({
        tier: 'app',
        sources: [VALID],
        excluded: [{ model: 'AppCountry', reason: REASON }],
      });
      throw new Error('typo in the manifest');
    });

    // NOT [VALID]: keeping the early rows makes the failure list depend on
    // where in the init the bug sat.
    expect(getAppOrgSources()).toEqual([]);
    expect(getAppExcludedOrgSources()).toEqual([]);
    expect(getAccountedAppOrgModels().size).toBe(0);
  });

  it('keeps declarations made before the init ran (a framework tier at boot)', () => {
    registerAppOrgSources({
      tier: 'framework',
      sources: [{ ...VALID, model: 'FrameworkTask', section: 'tasks' }],
      excluded: [{ model: 'FrameworkTag', reason: 'Join table — holds no org data.' }],
    });
    seam(() => {
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
      throw new Error('leaf typo');
    });

    expect(getAppOrgSources().map((s) => s.model)).toEqual(['FrameworkTask']);
    expect([...getAccountedAppOrgModels()].sort()).toEqual(['FrameworkTag', 'FrameworkTask']);
  });

  it('also rolls back ownership, so a rolled-back model can be claimed by another tier', () => {
    // Ownership is part of the snapshot: a leaked owner would make the
    // framework tier's later claim look like a cross-tier duplicate.
    seam(() => {
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
      throw new Error('boom');
    });
    getAppOrgSources();

    registerAppOrgSources({ tier: 'framework', sources: [VALID] });

    expect(mockLogger.error).not.toHaveBeenCalledWith(
      'org-sources: declaration rejected',
      expect.anything()
    );
    expect(getAppOrgSources()).toEqual([VALID]);
  });

  it('logs that the declarations were rolled back and disabled', () => {
    seam(() => {
      throw new Error('typo in the manifest');
    });

    getAppOrgSources();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'org-sources: initAppOrgSources threw — app org-source declarations rolled back and disabled',
      { error: 'typo in the manifest' }
    );
  });

  it('latches appOrgDeclarationsFailed() and keeps it true on later reads', () => {
    seam(() => {
      throw new Error('typo in the manifest');
    });

    expect(appOrgDeclarationsFailed()).toBe(true);
    getAppOrgSources();
    getAppExcludedOrgSources();
    getAccountedAppOrgModels();
    expect(appOrgDeclarationsFailed()).toBe(true);
    // And never retries: a retry could flip the answer mid-process.
    expect(mockInitAppOrgSources).toHaveBeenCalledTimes(1);
  });

  it('does not report failure when the init never threw', () => {
    seam(() => registerAppOrgSources({ tier: 'app', sources: [VALID] }));

    expect(appOrgDeclarationsFailed()).toBe(false);
  });
});

describe('an init that re-enters a reader mid-flight', () => {
  it('does NOT latch failure when the init succeeds', () => {
    // The framework-tier bridge and any de-dupe check read the registry from
    // inside the init. The gate answers 'running' to those; mistaking it for
    // failure would make exportOrgData() refuse every org for the life of the
    // process after a perfectly good init.
    let observedMidFlight: string[] | undefined;
    seam(() => {
      registerAppOrgSources({ tier: 'framework', sources: [VALID] });
      observedMidFlight = getAppOrgSources().map((s) => s.model);
      registerAppOrgSources({
        tier: 'app',
        sources: [{ ...VALID, model: 'AppReceipt', section: 'receipts' }],
      });
    });

    expect(
      getAppOrgSources()
        .map((s) => s.model)
        .sort()
    ).toEqual(['AppInvoice', 'AppReceipt']);
    expect(observedMidFlight).toEqual(['AppInvoice']);
    expect(appOrgDeclarationsFailed()).toBe(false);
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockInitAppOrgSources).toHaveBeenCalledTimes(1);
  });

  it('still latches failure when a re-entering init then throws', () => {
    seam(() => {
      registerAppOrgSources({ tier: 'app', sources: [VALID] });
      getAppOrgSources();
      throw new Error('fork boom');
    });

    expect(appOrgDeclarationsFailed()).toBe(true);
    expect(getAppOrgSources()).toEqual([]);
  });
});

describe('every public read triggers the lazy init', () => {
  it.each([
    ['getAppOrgSources', () => getAppOrgSources()],
    ['getAppExcludedOrgSources', () => getAppExcludedOrgSources()],
    ['getAccountedAppOrgModels', () => getAccountedAppOrgModels()],
    ['appOrgDeclarationsFailed', () => appOrgDeclarationsFailed()],
  ])('%s', (_name, read) => {
    // A read that skipped the init would report "nothing declared" for a tier
    // that had declared — the guard would pass while protecting nothing.
    seam(() => registerAppOrgSources({ tier: 'app', sources: [VALID] }));

    read();

    expect(mockInitAppOrgSources).toHaveBeenCalledTimes(1);
    expect(getAppOrgSources()).toEqual([VALID]);
  });
});

describe('__resetAppOrgSourceRegistryForTests', () => {
  it('clears declarations and ownership, and re-arms the init', () => {
    seam(() => registerAppOrgSources({ tier: 'app', sources: [VALID] }));
    expect(getAppOrgSources()).toHaveLength(1);

    __resetAppOrgSourceRegistryForTests();
    seam(() => registerAppOrgSources({ tier: 'framework', sources: [VALID] }));

    // Re-ran the init (2 calls) and the old 'app' ownership is gone, or the
    // framework claim would be rejected as a cross-tier duplicate.
    expect(getAppOrgSources()).toEqual([VALID]);
    expect(mockInitAppOrgSources).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('clears a latched rejection', () => {
    seam(() => registerAppOrgSources({ tier: 'app', sources: [{ ...VALID, section: '' }] }));
    expect(appOrgDeclarationsFailed()).toBe(true);

    __resetAppOrgSourceRegistryForTests();
    seam(() => registerAppOrgSources({ tier: 'app', sources: [VALID] }));

    expect(appOrgDeclarationsFailed()).toBe(false);
  });

  it('clears a latched failure', () => {
    seam(() => {
      throw new Error('boom');
    });
    expect(appOrgDeclarationsFailed()).toBe(true);

    __resetAppOrgSourceRegistryForTests();
    seam(() => registerAppOrgSources({ tier: 'app', sources: [VALID] }));

    expect(appOrgDeclarationsFailed()).toBe(false);
    expect(getAppOrgSources()).toEqual([VALID]);
  });
});
