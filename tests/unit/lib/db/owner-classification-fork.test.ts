/**
 * The fork half of the owner classification (§115 t-807), against a synthetic
 * tier and the real registry.
 *
 * The fork seam is mocked empty here, deliberately: these cases register their
 * own fixture rows and assert exactly what the readers return, so a fork that
 * has filled `lib/app/owner-classification.ts` must not change their answer.
 * The real seam is exercised by `owner-classification.test.ts` (the coverage
 * guard) and pinned empty by `tests/unit/lib/app/defaults.test.ts`.
 *
 * @see lib/db/owner-classification.ts — registerAppOwnerClassification
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/app/owner-classification', () => ({
  initAppOwnerClassification: () => {},
}));

import {
  OWNER_CLASSIFICATION,
  allOwnerClassifications,
  appOwnerClassifications,
  enforcedModels,
  ownerClassificationOf,
  personalModels,
  registerAppOwnerClassification,
  __resetAppOwnerClassificationForTests,
  type OwnerClassification,
} from '@/lib/db/owner-classification';
import { logger } from '@/lib/logging';
import {
  auditOwnerClassification,
  coreSchema,
  parseSchema,
} from '@/tests/helpers/owner-classification-audit';

/** The models a fork tier has classified, for the audit's fork-only rules. */
const forkRows = () => new Set(Object.keys(appOwnerClassifications()));

describe('owner classification — fork tiers', () => {
  beforeEach(() => {
    __resetAppOwnerClassificationForTests();
  });

  /**
   * The fork tier, against a synthetic schema file and the real registry.
   *
   * Vanilla Sunrise has no fork models, so the coverage guard passes over them
   * vacuously. These cases are where the fork half is seen doing anything.
   */
  describe('a fork tier', () => {
    const appFile = `
model AppJournalEntry {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}
model AppJournalAttachment {
  id      String          @id
  entryId String
  entry   AppJournalEntry @relation(fields: [entryId], references: [id])
}
model AppCountry {
  id String @id
}
`;
    const forkSchema = new Map([...coreSchema(), ...parseSchema([appFile])]);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fails on an unclassified user-linked fork model', () => {
      expect(auditOwnerClassification(forkSchema, allOwnerClassifications(), forkRows())).toEqual([
        'AppJournalEntry links to a user or to a personal model and is not classified',
      ]);
    });

    it('then on its child, once the parent is personal', () => {
      registerAppOwnerClassification({
        tier: 'app',
        models: { AppJournalEntry: { kind: 'personal', owner: { column: 'userId' } } },
      });
      expect(auditOwnerClassification(forkSchema, allOwnerClassifications(), forkRows())).toEqual([
        'AppJournalAttachment links to a user or to a personal model and is not classified',
      ]);
    });

    it('passes once the seam classifies them, and the readers see them', () => {
      registerAppOwnerClassification({
        tier: 'app',
        models: {
          AppJournalEntry: { kind: 'personal', owner: { column: 'userId' }, enforced: true },
          AppJournalAttachment: {
            kind: 'personal',
            owner: { through: { field: 'entry', parent: 'AppJournalEntry' } },
            enforced: true,
          },
        },
      });
      expect(auditOwnerClassification(forkSchema, allOwnerClassifications(), forkRows())).toEqual(
        []
      );
      expect(ownerClassificationOf('AppJournalEntry')).toMatchObject({ kind: 'personal' });
      expect(personalModels()).toEqual(expect.arrayContaining(['AppJournalAttachment']));
      expect(enforcedModels()).toEqual(
        expect.arrayContaining(['AppJournalEntry', 'AppJournalAttachment'])
      );
    });

    it('flags an enforced child whose parent is not enforced', () => {
      // The client refuses this at construction — every query fails — so the
      // guard has to name it first.
      registerAppOwnerClassification({
        tier: 'app',
        models: {
          AppJournalEntry: { kind: 'personal', owner: { column: 'userId' } },
          AppJournalAttachment: {
            kind: 'personal',
            owner: { through: { field: 'entry', parent: 'AppJournalEntry' } },
            enforced: true,
          },
        },
      });
      expect(auditOwnerClassification(forkSchema, allOwnerClassifications(), forkRows())).toEqual([
        'AppJournalAttachment is enforced but its parent AppJournalEntry is not',
      ]);
    });

    it('refuses the conversation-share arm on a fork model', () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      registerAppOwnerClassification({
        tier: 'app',
        models: {
          AppJournalEntry: {
            kind: 'personal',
            owner: { column: 'userId' },
            alsoVisible: ['active-share'],
            enforced: true,
          },
        },
      });
      expect(ownerClassificationOf('AppJournalEntry')).toBeNull();
      expect(error).toHaveBeenCalledWith('owner-classification: app classification rejected', {
        tier: 'app',
        model: 'AppJournalEntry',
        reason: '`alsoVisible` is for core models only',
      });
    });

    it("refuses a core ownerless kind, and needs none for a fork model's orphans", () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const draftSchema = new Map([
        ...coreSchema(),
        ...parseSchema([
          `
model AppDraft {
  id     String  @id
  userId String?
  user   User?   @relation(fields: [userId], references: [id])
}
`,
        ]),
      ]);
      registerAppOwnerClassification({
        tier: 'app',
        models: {
          AppDraft: { kind: 'personal', owner: { column: 'userId' }, ownerless: 'conversation' },
        },
      });
      expect(ownerClassificationOf('AppDraft')).toBeNull();
      expect(error).toHaveBeenCalledWith('owner-classification: app classification rejected', {
        tier: 'app',
        model: 'AppDraft',
        reason: '`ownerless` is for core models only',
      });

      registerAppOwnerClassification({
        tier: 'app',
        models: { AppDraft: { kind: 'personal', owner: { column: 'userId' } } },
      });
      expect(auditOwnerClassification(draftSchema, allOwnerClassifications(), forkRows())).toEqual(
        []
      );
    });

    describe('a read rule (t-985)', () => {
      const rule = (r: { userId: string }) => ({ OR: [{ userId: r.userId }] });

      it('accepts a personal model owned by a read rule, with a child through it', () => {
        registerAppOwnerClassification({
          tier: 'app',
          models: {
            AppJournalEntry: { kind: 'personal', owner: { reader: rule }, enforced: true },
            AppJournalAttachment: {
              kind: 'personal',
              owner: { through: { field: 'entry', parent: 'AppJournalEntry' } },
              enforced: true,
            },
          },
        });
        expect(ownerClassificationOf('AppJournalEntry')).toEqual({
          kind: 'personal',
          owner: { reader: rule },
          enforced: true,
        });
        expect(auditOwnerClassification(forkSchema, allOwnerClassifications(), forkRows())).toEqual(
          []
        );
      });

      it('refuses one beside an ownerless or alsoVisible arm, and one that is not a function', () => {
        const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
        registerAppOwnerClassification({
          tier: 'app',
          models: {
            AppJournalEntry: {
              kind: 'personal',
              owner: { reader: rule },
              ownerless: 'conversation',
            },
            AppJournalAttachment: {
              kind: 'personal',
              owner: { reader: rule },
              alsoVisible: ['active-share'],
            },
            AppCountry: {
              kind: 'personal',
              // A fork's JavaScript can hand the registry anything.
              owner: { reader: 'userId' } as unknown as { reader: () => object },
            },
          },
        });
        expect(appOwnerClassifications()).toEqual({});
        expect(error.mock.calls.map(([, meta]) => meta)).toEqual([
          {
            tier: 'app',
            model: 'AppJournalEntry',
            reason: '`ownerless` is for core models only',
          },
          {
            tier: 'app',
            model: 'AppJournalAttachment',
            reason: '`alsoVisible` is for core models only',
          },
          { tier: 'app', model: 'AppCountry', reason: '`owner.reader` must be a function' },
        ]);
      });

      it('refuses an owner with two shapes, which would enforce only one of them', () => {
        const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
        registerAppOwnerClassification({
          tier: 'app',
          models: {
            AppJournalEntry: {
              kind: 'personal',
              owner: { column: 'userId', reader: rule } as unknown as { reader: typeof rule },
            },
          },
        });
        expect(ownerClassificationOf('AppJournalEntry')).toBeNull();
        expect(error.mock.calls.map(([, meta]) => meta)).toEqual([
          {
            tier: 'app',
            model: 'AppJournalEntry',
            reason: '`owner` has column and reader: give it exactly one',
          },
        ]);
      });

      it('accepts a ruled model whose only link is to a model that is not personal', () => {
        // A space's note: read by the space's members, linked to no user.
        const spaceSchema = new Map([
          ...coreSchema(),
          ...parseSchema([
            `
model AppSpace {
  id String @id
}
model AppSpaceNote {
  id      String   @id
  spaceId String
  space   AppSpace @relation(fields: [spaceId], references: [id])
}
`,
          ]),
        ]);
        registerAppOwnerClassification({
          tier: 'app',
          models: { AppSpaceNote: { kind: 'personal', owner: { reader: rule }, enforced: true } },
        });
        expect(
          auditOwnerClassification(spaceSchema, allOwnerClassifications(), forkRows())
        ).toEqual([]);
      });

      it('flags a read rule on a core model, and an enforced one with no id', () => {
        const noIdSchema = new Map([
          ...coreSchema(),
          ...parseSchema([
            `
model AppTally {
  userId String
  user   User   @relation(fields: [userId], references: [id])
  @@id([userId])
}
`,
          ]),
        ]);
        const classification: Record<string, OwnerClassification> = {
          ...allOwnerClassifications(),
          AiUserMemory: { kind: 'personal', owner: { reader: rule }, enforced: true },
          AppTally: { kind: 'personal', owner: { reader: rule }, enforced: true },
        };
        expect(auditOwnerClassification(noIdSchema, classification, new Set(['AppTally']))).toEqual(
          [
            'AiUserMemory has a read rule, which is for fork models only',
            'AppTally has a read rule and is enforced but has no id',
          ]
        );
      });
    });

    it("clears a tier's row when it re-registers the model malformed", () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      registerAppOwnerClassification({
        tier: 'app',
        models: {
          AppJournalEntry: { kind: 'personal', owner: { column: 'userId' }, enforced: true },
        },
      });
      registerAppOwnerClassification({
        tier: 'app',
        models: { AppJournalEntry: { kind: 'not-personal', because: '' } },
      });
      // Unclassified, so the coverage guard names it — not still enforced.
      expect(ownerClassificationOf('AppJournalEntry')).toBeNull();
      expect(enforcedModels()).not.toContain('AppJournalEntry');
    });

    it('accepts not-personal, and holds a fork row to the schema like a core one', () => {
      registerAppOwnerClassification({
        tier: 'app',
        models: {
          AppJournalEntry: { kind: 'not-personal', because: 'Who wrote it, not whose it is.' },
          AppCountry: { kind: 'not-personal', because: 'Reference data.' },
        },
      });
      expect(enforcedModels()).not.toContain('AppJournalEntry');
      expect(auditOwnerClassification(forkSchema, allOwnerClassifications(), forkRows())).toEqual([
        'AppCountry is classified but links to no user and no personal model',
      ]);
    });

    it("never lets a fork reclassify a core model, or take another tier's", () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      registerAppOwnerClassification({
        tier: 'framework',
        models: { AppJournalEntry: { kind: 'personal', owner: { column: 'userId' } } },
      });
      registerAppOwnerClassification({
        tier: 'app',
        models: {
          // Would switch the data layer's check off for every conversation.
          AiConversation: { kind: 'not-personal', because: 'nothing to see here' },
          AppJournalEntry: { kind: 'not-personal', because: 'mine now' },
          AppJournalAttachment: { kind: 'not-personal', because: '   ' },
        },
      });
      expect(ownerClassificationOf('AiConversation')).toBe(OWNER_CLASSIFICATION.AiConversation);
      expect(ownerClassificationOf('AppJournalEntry')).toMatchObject({ kind: 'personal' });
      expect(appOwnerClassifications()).toEqual({
        AppJournalEntry: { kind: 'personal', owner: { column: 'userId' } },
      });
      expect(error.mock.calls.map(([, meta]) => meta)).toEqual([
        { tier: 'app', model: 'AiConversation', reason: 'core already classifies this model' },
        { tier: 'app', model: 'AppJournalEntry', reason: "already classified by tier 'framework'" },
        {
          tier: 'app',
          model: 'AppJournalAttachment',
          reason: 'a not-personal model needs a reason in `because`',
        },
      ]);
    });
  });

  it('with nothing registered, reads exactly what core classifies', () => {
    // Behaviour-neutral at rest: the readers the owner layer is built from
    // return core's list and nothing else.
    const core = OWNER_CLASSIFICATION as Record<string, OwnerClassification>;
    expect(appOwnerClassifications()).toEqual({});
    expect(allOwnerClassifications()).toEqual(core);
    expect(enforcedModels()).toEqual(
      Object.entries(core)
        .filter(([, c]) => c.kind === 'personal' && c.enforced === true)
        .map(([m]) => m)
    );
    expect(personalModels()).toEqual(
      Object.entries(core)
        .filter(([, c]) => c.kind === 'personal')
        .map(([m]) => m)
    );
    for (const model of Object.keys(core)) expect(ownerClassificationOf(model)).toBe(core[model]);
    expect(ownerClassificationOf('AppJournalEntry')).toBeNull();
  });
});
