/**
 * Tests: lib/privacy/subject-source-registry.ts
 *
 * The fork half of the Art. 15 coverage guard (#533). Two properties carry the
 * weight, and both are about what happens when a declaration is WRONG rather
 * than when it is right:
 *
 *   1. A malformed row is dropped, so the model stays unaccounted and
 *      `export-sources.test.ts` fails naming it. Dropping must never look like
 *      accepting — that is the silent false negative this whole issue is about.
 *   2. A throwing init rolls the registry back rather than keeping the rows it
 *      managed before the throw. Half a tier's declarations would give a
 *      failure list that changes with the position of a bug (#633).
 *
 * FORK NOTE — nothing here needs adjusting when you fill the seam. The suite
 * drives `registerAppSubjectSources()` directly and stubs
 * `@/lib/app/data-export`, so your declarations are neither counted nor
 * required.
 *
 * @see lib/privacy/subject-source-registry.ts
 * @see lib/app/data-export.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockInitAppSubjectSources = vi.fn();
vi.mock('@/lib/app/data-export', () => ({
  initAppSubjectSources: () => mockInitAppSubjectSources(),
}));

const {
  registerAppSubjectSources,
  getAppSubjectSources,
  getAppExcludedSubjectSources,
  getAccountedAppModels,
  appSubjectDeclarationsFailed,
  __resetAppSubjectSourceRegistryForTests,
} = await import('@/lib/privacy/subject-source-registry');

const VALID = {
  model: 'AppInvoice',
  section: 'invoices',
  disposition: 'export',
  description: 'Invoices raised against your account.',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppSubjectSourceRegistryForTests();
  mockInitAppSubjectSources.mockReset();
});

/** Make the lazy init register `contribution` when a read first triggers it. */
function seam(register: () => void): void {
  mockInitAppSubjectSources.mockImplementation(register);
}

describe('registerAppSubjectSources', () => {
  it('records a well-formed source, and the read runs the seam once', () => {
    seam(() => registerAppSubjectSources({ tier: 'app', sources: [VALID] }));

    expect(getAppSubjectSources()).toEqual([VALID]);
    getAppSubjectSources();
    expect(mockInitAppSubjectSources).toHaveBeenCalledTimes(1);
  });

  it('records an exclusion with its reason', () => {
    seam(() =>
      registerAppSubjectSources({
        tier: 'app',
        excluded: [
          { model: 'AppCountry', reason: 'Reference list of countries — no personal data.' },
        ],
      })
    );

    expect(getAppExcludedSubjectSources()).toEqual([
      { model: 'AppCountry', reason: 'Reference list of countries — no personal data.' },
    ]);
  });

  it('lets two tiers declare independently', () => {
    // The reason this is a registry and not one exported constant: a framework
    // tier filling a single slot consumes the seam its leaf forks are entitled
    // to, which is the collision the /app reservation exists to prevent.
    seam(() => {
      registerAppSubjectSources({ tier: 'framework', sources: [{ ...VALID, model: 'FrameworkTask', section: 'tasks' }] }); // prettier-ignore
      registerAppSubjectSources({ tier: 'app', sources: [VALID] });
    });

    expect([...getAccountedAppModels()].sort()).toEqual(['AppInvoice', 'FrameworkTask']);
  });

  it('counts sources and exclusions alike as accounted for', () => {
    seam(() =>
      registerAppSubjectSources({
        tier: 'app',
        sources: [VALID],
        excluded: [
          { model: 'AppCountry', reason: 'Reference list of countries — no personal data.' },
        ],
      })
    );

    expect([...getAccountedAppModels()].sort()).toEqual(['AppCountry', 'AppInvoice']);
  });

  it('is idempotent by model, so a repeated import does not duplicate', () => {
    seam(() => {
      registerAppSubjectSources({ tier: 'app', sources: [VALID] });
      registerAppSubjectSources({ tier: 'app', sources: [VALID] });
    });

    expect(getAppSubjectSources()).toHaveLength(1);
  });

  describe('rows it refuses — each stays unaccounted, so the coverage guard names it', () => {
    const cases: { why: string; register: () => void; model: string }[] = [
      {
        why: 'an empty model name',
        model: '',
        register: () => registerAppSubjectSources({ tier: 'app', sources: [{ ...VALID, model: '  ' }] }), // prettier-ignore
      },
      {
        why: 'an empty section',
        model: 'AppInvoice',
        register: () => registerAppSubjectSources({ tier: 'app', sources: [{ ...VALID, section: '' }] }), // prettier-ignore
      },
      {
        why: 'a disposition that is neither of the two',
        model: 'AppInvoice',
        register: () =>
          registerAppSubjectSources({
            tier: 'app',
            // Cast because the type forbids it — a fork's JS, or a value read
            // from config, does not have that protection.
            sources: [{ ...VALID, disposition: 'delete' as unknown as 'export' }],
          }),
      },
      {
        why: 'a description too thin to tell a reader anything',
        model: 'AppInvoice',
        register: () => registerAppSubjectSources({ tier: 'app', sources: [{ ...VALID, description: 'rows' }] }), // prettier-ignore
      },
    ];

    it.each(cases)('refuses $why', ({ register, model }) => {
      seam(register);

      expect(getAppSubjectSources()).toEqual([]);
      expect(getAccountedAppModels().has(model)).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'subject-sources: declaration rejected',
        expect.objectContaining({ tier: 'app' })
      );
    });

    it('refuses an exclusion whose reason says nothing', () => {
      // The reason is the entire value of an exclusion — it is what stands in
      // the manifest where the data would have been.
      seam(() =>
        registerAppSubjectSources({
          tier: 'app',
          excluded: [{ model: 'AppCountry', reason: 'n/a' }],
        })
      );

      expect(getAppExcludedSubjectSources()).toEqual([]);
      expect(getAccountedAppModels().has('AppCountry')).toBe(false);
    });

    it('refuses a model already claimed by another tier', () => {
      seam(() => {
        registerAppSubjectSources({ tier: 'framework', sources: [VALID] });
        registerAppSubjectSources({ tier: 'app', sources: [{ ...VALID, section: 'billing' }] });
      });

      // First claim wins, and the second is logged rather than silently
      // overwriting a tier's disposition with another tier's.
      expect(getAppSubjectSources()).toEqual([VALID]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'subject-sources: declaration rejected',
        expect.objectContaining({ tier: 'app', reason: expect.stringContaining('framework') })
      );
    });

    it('refuses a second source on a section already in use', () => {
      // Two sources under one key would have one overwrite the other inside
      // `bundle.app` — silent loss, with both models still accounted for.
      seam(() =>
        registerAppSubjectSources({
          tier: 'app',
          sources: [VALID, { ...VALID, model: 'AppCredit' }],
        })
      );

      expect(getAppSubjectSources()).toEqual([VALID]);
      expect(getAccountedAppModels().has('AppCredit')).toBe(false);
    });

    it('refuses a model declared as both a source and an exclusion', () => {
      seam(() =>
        registerAppSubjectSources({
          tier: 'app',
          sources: [VALID],
          excluded: [{ model: 'AppInvoice', reason: 'Changed my mind halfway down the file.' }],
        })
      );

      expect(getAppSubjectSources()).toEqual([VALID]);
      expect(getAppExcludedSubjectSources()).toEqual([]);
    });

    it('lets a SOURCE supersede an existing exclusion, rather than refusing it', () => {
      // Deliberately not symmetric with the case above. Refusing here left a
      // model that could never move from `excluded` to `sources` — and a
      // still-"accounted" model keeps the coverage guard green while
      // `meta.excluded` tells the subject the table was withheld and the
      // collector may be returning it. Between two claims, the one saying the
      // table DOES hold personal data is the safe answer.
      seam(() => {
        registerAppSubjectSources({
          tier: 'app',
          excluded: [{ model: 'AppInvoice', reason: 'Decided this holds no personal data.' }],
        });
        registerAppSubjectSources({ tier: 'app', sources: [VALID] });
      });

      expect(getAppSubjectSources()).toEqual([VALID]);
      expect(getAppExcludedSubjectSources()).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'subject-sources: a source declaration replaced an exclusion',
        expect.objectContaining({ model: 'AppInvoice' })
      );
    });

    it('does NOT destroy an exclusion when the superseding source is itself rejected', () => {
      // The bug this ordering exists to prevent: the delete used to run before
      // the section-collision check, so a source that never made it into the
      // registry still took a valid exclusion with it — and `meta.excluded`
      // stopped telling the subject that table was withheld and why.
      seam(() => {
        registerAppSubjectSources({
          tier: 'app',
          sources: [VALID],
          excluded: [{ model: 'AppCountry', reason: 'Reference list — holds no personal data.' }],
        });
        // Same section as VALID, so this source is rejected by the collision
        // check — after it would previously have deleted the exclusion.
        registerAppSubjectSources({
          tier: 'app',
          sources: [{ ...VALID, model: 'AppCountry' }],
        });
      });

      expect(getAppExcludedSubjectSources()).toEqual([
        { model: 'AppCountry', reason: 'Reference list — holds no personal data.' },
      ]);
      expect(getAccountedAppModels().has('AppCountry')).toBe(true);
      expect(getAppSubjectSources()).toEqual([VALID]);
    });

    it('lets a leaf tier supersede a framework tier’s exclusion', () => {
      // The cross-tier version, which is the one that actually happens: the
      // framework excludes a shared table at boot, the leaf knows it holds its
      // users' data. Ownership moves with the claim.
      seam(() => {
        registerAppSubjectSources({
          tier: 'framework',
          excluded: [{ model: 'SharedTag', reason: 'Framework tier sees no personal data here.' }],
        });
        registerAppSubjectSources({
          tier: 'app',
          sources: [{ ...VALID, model: 'SharedTag', section: 'tags' }],
        });
      });

      expect(getAppSubjectSources()).toEqual([{ ...VALID, model: 'SharedTag', section: 'tags' }]);
      expect(getAppExcludedSubjectSources()).toEqual([]);
      expect([...getAccountedAppModels()]).toEqual(['SharedTag']);
    });

    it('refuses an exclusion with an empty model name', () => {
      seam(() =>
        registerAppSubjectSources({
          tier: 'app',
          excluded: [{ model: '   ', reason: 'A reason attached to nothing in particular.' }],
        })
      );

      expect(getAppExcludedSubjectSources()).toEqual([]);
    });

    it('refuses an exclusion for a model another tier already excluded', () => {
      // Two tiers writing off the same table with different reasons: the
      // second reason would replace the first, and the manifest would show a
      // regulator whichever one happened to register last.
      seam(() => {
        registerAppSubjectSources({
          tier: 'framework',
          excluded: [{ model: 'SharedTag', reason: 'Join table owned by the framework tier.' }],
        });
        registerAppSubjectSources({
          tier: 'app',
          excluded: [{ model: 'SharedTag', reason: 'Trying to write off another tier’s table.' }],
        });
      });

      expect(getAppExcludedSubjectSources()).toEqual([
        { model: 'SharedTag', reason: 'Join table owned by the framework tier.' },
      ]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'subject-sources: declaration rejected',
        expect.objectContaining({ tier: 'app', reason: expect.stringContaining('framework') })
      );
    });

    it('survives rows whose fields are missing entirely', () => {
      // The optional chaining and `?? ''` exist for a fork's JS, or a value read
      // from config, where the type gives no protection. `undefined.trim()`
      // would throw out of the seam and take the whole contribution with it, so
      // every field a caller could omit is exercised here.
      seam(() =>
        registerAppSubjectSources({
          tier: 'app',
          sources: [
            { ...VALID, model: undefined as unknown as string },
            { ...VALID, model: 'A', section: undefined as unknown as string },
            { ...VALID, model: 'B', description: undefined as unknown as string },
          ],
          excluded: [
            { model: undefined as unknown as string, reason: 'A reason with no model.' },
            { model: 'C', reason: undefined as unknown as string },
          ],
        })
      );

      expect(getAppSubjectSources()).toEqual([]);
      expect(getAppExcludedSubjectSources()).toEqual([]);
      expect(getAccountedAppModels().size).toBe(0);
    });
  });

  describe('a throwing init', () => {
    it('keeps declarations made before the init ran', () => {
      // The restore half of the rollback, which the case below cannot reach:
      // starting from an empty registry, "roll back" and "clear" are the same
      // thing. A framework tier that registers at boot — from `initFramework()`
      // via `lib/app/bootstrap.ts`, before anything reads the export — is
      // already in the registry when the leaf's init runs, and must not be
      // destroyed by the leaf's mistake.
      registerAppSubjectSources({
        tier: 'framework',
        sources: [{ ...VALID, model: 'FrameworkTask', section: 'tasks' }],
        excluded: [{ model: 'FrameworkTag', reason: 'Join table — holds no personal data.' }],
      });

      seam(() => {
        registerAppSubjectSources({ tier: 'app', sources: [VALID] });
        throw new Error('typo in the leaf manifest');
      });

      expect(getAppSubjectSources()).toEqual([{ ...VALID, model: 'FrameworkTask', section: 'tasks' }]); // prettier-ignore
      expect(getAppExcludedSubjectSources()).toHaveLength(1);
      expect([...getAccountedAppModels()].sort()).toEqual(['FrameworkTag', 'FrameworkTask']);
    });

    it('rolls back the declarations it managed before the throw', () => {
      seam(() => {
        registerAppSubjectSources({ tier: 'app', sources: [VALID] });
        throw new Error('typo in the manifest');
      });

      // NOT [VALID]. Keeping it would leave the coverage guard green for the
      // models that happened to register first and red for the rest — a
      // failure list that moves with the position of the bug (#633).
      expect(getAppSubjectSources()).toEqual([]);
      expect(getAccountedAppModels().size).toBe(0);
    });

    it('says so, and disables rather than half-applying', () => {
      seam(() => {
        throw new Error('typo in the manifest');
      });

      getAppSubjectSources();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'subject-sources: initAppSubjectSources threw — app declarations rolled back and disabled',
        { error: 'typo in the manifest' }
      );
    });

    it('does not retry on the next read', () => {
      seam(() => {
        throw new Error('typo in the manifest');
      });

      getAppSubjectSources();
      getAppExcludedSubjectSources();
      getAccountedAppModels();

      expect(mockInitAppSubjectSources).toHaveBeenCalledTimes(1);
    });

    it('survives a throw that is not an Error', () => {
      seam(() => {
        // The lint rule below is exactly why this case exists: a fork's seam
        // can throw a non-Error, and the catch has to survive it.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string';
      });

      expect(() => getAppSubjectSources()).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('rolled back and disabled'),
        { error: 'plain string' }
      );
    });

    it('survives a throw that cannot be converted to a string', () => {
      // `String(Object.create(null))` throws "Cannot convert object to
      // primitive value". Rollback has already run by then, so the throw would
      // escape the catch and 500 the export route with no log line saying why.
      // The previous version of this case *described* this and then threw a
      // plain string, which `String()` handles — so it asserted a protection
      // neither it nor the code provided.
      seam(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw Object.create(null) as never;
      });

      expect(() => getAppSubjectSources()).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('rolled back and disabled'),
        { error: 'a value that cannot be converted to a string' }
      );
    });
  });

  describe('every public read triggers the lazy init', () => {
    it.each([
      ['getAppSubjectSources', () => getAppSubjectSources()],
      ['getAppExcludedSubjectSources', () => getAppExcludedSubjectSources()],
      ['getAccountedAppModels', () => getAccountedAppModels()],
    ])('%s', (_name, read) => {
      // A read that skipped the init would report "nothing declared" for a tier
      // that had declared — the guard would pass while protecting nothing.
      seam(() => registerAppSubjectSources({ tier: 'app', sources: [VALID] }));

      read();

      expect(mockInitAppSubjectSources).toHaveBeenCalledTimes(1);
    });
  });
});

describe('a fork init that reads its own registry mid-flight', () => {
  it('does not mark the tier failed when the init SUCCEEDS', () => {
    // The documented framework-tier bridge shape, and the obvious de-dupe check,
    // both re-enter the registry from inside the init:
    //
    //   registerAppSubjectSources({ tier: 'framework', ... });
    //   if (!getAccountedAppModels().has('X')) initFrameworkExportSources();
    //   registerAppSubjectSources({ tier: 'app', ... });
    //
    // Every read calls the lazy gate. A gate that cannot tell "still running"
    // from "threw" reports the second as the first — and `appInitFailed` is
    // sticky, so a completely successful init would leave Art. 15 subject
    // access refusing for the life of the process, with nothing logged.
    let observedMidFlight: readonly string[] | undefined;
    seam(() => {
      registerAppSubjectSources({ tier: 'framework', sources: [VALID] });
      observedMidFlight = [...getAccountedAppModels()];
      registerAppSubjectSources({
        tier: 'app',
        sources: [{ ...VALID, model: 'AppReceipt', section: 'receipts' }],
      });
    });

    expect(
      getAppSubjectSources()
        .map((s) => s.model)
        .sort()
    ).toEqual(['AppInvoice', 'AppReceipt']);
    // The re-entrant read saw the registrations made before it.
    expect(observedMidFlight).toEqual(['AppInvoice']);
    expect(appSubjectDeclarationsFailed()).toBe(false);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('still marks the tier failed when the init actually throws', () => {
    // The counterpart: the flag must keep working for its real purpose.
    seam(() => {
      registerAppSubjectSources({ tier: 'app', sources: [VALID] });
      throw new Error('fork boom');
    });

    expect(appSubjectDeclarationsFailed()).toBe(true);
    expect(getAppSubjectSources()).toEqual([]);
  });
});
