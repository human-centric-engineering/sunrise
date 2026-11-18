/**
 * Unit Tests: entitlement switches (§135 t-1033)
 *
 * The registry an app fills from `lib/app/entitlements.ts`, and what an org's
 * stored switches mean against it. Pins: the seam ships empty and changes no
 * answer; a throwing init rolls back every switch it registered; a switch
 * nobody set on an org answers its `whenNothingSet`, which is not the same as
 * a switch set off, and a switch registered after an org was saved reaches it
 * at its default; a stored key nobody registers reads as off; a typo fails
 * closed.
 *
 * @see lib/tenancy/entitlements.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The fork seam ships empty; the tests below fill it explicitly.
vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockPrisma = vi.hoisted(() => {
  const db = {
    org: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  return db;
});
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import { initAppEntitlements } from '@/lib/app/entitlements';
import { logger } from '@/lib/logging';
import {
  __resetEntitlementRegistryForTests,
  entitlementSwitchesFailed,
  loadOrgSwitches,
  orgHasSwitch,
  orgSwitchState,
  switchUnverifiedMessage,
  registerEntitlementSwitch,
  registerMeter,
  registeredEntitlementSwitches,
  registeredMeters,
  resolveOrgSwitches,
  setOrgSwitches,
  type EntitlementSwitch,
  type MeterDefinition,
} from '@/lib/tenancy/entitlements';
import { MAX_METERS, MAX_ORG_ENTITLEMENT_SWITCHES } from '@/lib/validations/tenancy';

const ORG = 'cmorg000000000000000acme1';

/** What is stored: the keys set on and off. Nothing set by default. */
const stored = (on: string[] = [], off: string[] = [], unreadable = false) => ({
  on,
  off,
  unreadable,
});

/** Register the two switches most tests use: one new area, one every org has today. */
function registerBoth() {
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerEntitlementSwitch({
      key: 'reports',
      label: 'Reports',
      description: 'Build and share reports.',
    });
    registerEntitlementSwitch({
      key: 'leads',
      label: 'Lead generation',
      description: 'Funnels and leads.',
      whenNothingSet: true,
    });
  });
}

beforeEach(() => {
  __resetEntitlementRegistryForTests();
  vi.clearAllMocks();
  vi.mocked(initAppEntitlements).mockImplementation(() => {});
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
});

describe('the registry', () => {
  it('ships empty, so an org of any shape has no switch on', () => {
    expect(registeredEntitlementSwitches()).toEqual([]);
    for (const read of [stored(), stored(['reports']), stored([], ['reports'])]) {
      expect(resolveOrgSwitches(read).on).toEqual([]);
    }
  });

  it('lists switches in registration order, with whenNothingSet filled in as off', () => {
    registerBoth();

    expect(registeredEntitlementSwitches()).toEqual([
      {
        key: 'reports',
        label: 'Reports',
        description: 'Build and share reports.',
        whenNothingSet: false,
      },
      {
        key: 'leads',
        label: 'Lead generation',
        description: 'Funnels and leads.',
        whenNothingSet: true,
      },
    ]);
  });

  it('runs the fork init once, however many reads there are', () => {
    registerBoth();

    registeredEntitlementSwitches();
    registeredEntitlementSwitches();
    resolveOrgSwitches(stored());

    expect(initAppEntitlements).toHaveBeenCalledOnce();
  });

  it('replaces a switch registered twice under one key', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Old', description: '' });
      registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: 'New' });
    });

    expect(registeredEntitlementSwitches()).toEqual([
      { key: 'reports', label: 'Reports', description: 'New', whenNothingSet: false },
    ]);
  });

  it('rolls back every switch when the init throws part-way, and says so', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
      throw new Error('boom');
    });

    expect(registeredEntitlementSwitches()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('entitlements: initAppEntitlements threw'),
      expect.anything()
    );
  });

  it.each([
    ['upper case', 'Reports'],
    ['a hyphen', 'lead-gen'],
    ['a leading digit', '1reports'],
    ['nothing', ''],
  ])('refuses a key with %s, which rolls the init back', (_what, key) => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'leads', label: 'Leads', description: '' });
      registerEntitlementSwitch({ key, label: 'Bad', description: '' });
    });

    expect(registeredEntitlementSwitches()).toEqual([]);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('refuses a switch with no label, or a label left out, with a message rather than a TypeError', () => {
    for (const label of ['   ', undefined]) {
      __resetEntitlementRegistryForTests();
      vi.mocked(logger.error).mockClear();
      vi.mocked(initAppEntitlements).mockImplementation(() => {
        registerEntitlementSwitch({ key: 'reports', label, description: '' } as never);
      });

      expect(registeredEntitlementSwitches()).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('entitlements: initAppEntitlements threw'),
        expect.objectContaining({ error: expect.stringContaining('needs a label') })
      );
    }
  });

  it.each([
    ['the string "false"', 'false'],
    ['a number', 1],
  ])(
    'refuses whenNothingSet given as %s, which read loosely would open the switch for every org',
    (_what, whenNothingSet) => {
      vi.mocked(initAppEntitlements).mockImplementation(() => {
        registerEntitlementSwitch({
          key: 'reports',
          label: 'Reports',
          description: '',
          whenNothingSet,
        } as never);
      });

      expect(registeredEntitlementSwitches()).toEqual([]);
      expect(resolveOrgSwitches(stored()).on).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('entitlements: initAppEntitlements threw'),
        expect.objectContaining({ error: expect.stringContaining('must be true or false') })
      );
    }
  );

  it('refuses one switch past the limit, and still lets a registered one be replaced', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      for (let i = 0; i < MAX_ORG_ENTITLEMENT_SWITCHES; i += 1) {
        registerEntitlementSwitch({ key: `s${i}`, label: `Switch ${i}`, description: '' });
      }
      registerEntitlementSwitch({ key: 's0', label: 'Replaced', description: '' });
    });
    expect(registeredEntitlementSwitches()).toHaveLength(MAX_ORG_ENTITLEMENT_SWITCHES);

    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      for (let i = 0; i <= MAX_ORG_ENTITLEMENT_SWITCHES; i += 1) {
        registerEntitlementSwitch({ key: `s${i}`, label: `Switch ${i}`, description: '' });
      }
    });
    expect(registeredEntitlementSwitches()).toEqual([]);
    expect(entitlementSwitchesFailed()).toBe(true);
  });

  it('says whether the app registration failed, which an empty registry alone cannot', () => {
    expect(entitlementSwitchesFailed()).toBe(false);

    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(registeredEntitlementSwitches()).toEqual([]);
    expect(entitlementSwitchesFailed()).toBe(true);
  });

  it('reads a description left out as none, rather than failing the whole init', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Reports' } as EntitlementSwitch);
    });

    expect(registeredEntitlementSwitches()).toEqual([
      { key: 'reports', label: 'Reports', description: '', whenNothingSet: false },
    ]);
  });
});

describe('resolveOrgSwitches', () => {
  beforeEach(registerBoth);

  it('gives an org with nothing set each switch at its default', () => {
    expect(resolveOrgSwitches(stored())).toEqual({
      nothingSet: true,
      unreadable: false,
      on: ['leads'],
      atDefault: ['reports', 'leads'],
      unregistered: [],
    });
  });

  it('gives an org set to none no switch at all, which is not the same as nothing set', () => {
    const none = resolveOrgSwitches(stored([], ['leads', 'reports']));
    const nothing = resolveOrgSwitches(stored());

    expect(none).toEqual({
      nothingSet: false,
      unreadable: false,
      on: [],
      atDefault: [],
      unregistered: [],
    });
    // The whole point: a default-on switch is lost only where somebody set it off.
    expect(nothing.on).toContain('leads');
    expect(none.on).not.toContain('leads');
  });

  it('gives a set org exactly what was set, in registration order', () => {
    expect(resolveOrgSwitches(stored(['leads', 'reports'])).on).toEqual(['reports', 'leads']);
    expect(resolveOrgSwitches(stored(['reports'], ['leads'])).on).toEqual(['reports']);
  });

  it('gives a switch registered after the org was saved its default, not off', () => {
    // Saved when only `reports` was registered: reports on, nothing else known.
    const savedEarlier = stored(['reports']);

    const resolved = resolveOrgSwitches(savedEarlier);

    // `leads` arrived later with whenNothingSet: true, so this org has it,
    // like every org that exists today.
    expect(resolved.on).toEqual(['reports', 'leads']);
    expect(resolved.atDefault).toEqual(['leads']);
    expect(resolved.nothingSet).toBe(false);
  });

  it('reads a stored key nobody registers as off, and names it', () => {
    expect(resolveOrgSwitches(stored(['reports', 'retired'], ['leads']))).toEqual({
      nothingSet: false,
      unreadable: false,
      on: ['reports'],
      atDefault: [],
      unregistered: ['retired'],
    });
  });

  it('gives an unreadable slice nothing, not even the defaults', () => {
    expect(resolveOrgSwitches(stored([], [], true))).toEqual({
      nothingSet: false,
      unreadable: true,
      on: [],
      atDefault: [],
      unregistered: [],
    });
  });
});

describe('loading an org', () => {
  beforeEach(registerBoth);

  it("reads the org's row and resolves it", async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['reports'], off: ['leads'] }, appOwn: { x: 1 } },
    });

    await expect(loadOrgSwitches(ORG)).resolves.toMatchObject({
      nothingSet: false,
      on: ['reports'],
    });
    expect(mockPrisma.org.findUnique).toHaveBeenCalledWith({
      where: { id: ORG },
      select: { settings: true },
    });
  });

  it('is null for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    await expect(loadOrgSwitches(ORG)).resolves.toBeNull();
    await expect(orgHasSwitch(ORG, 'leads')).resolves.toBe(false);
  });

  it('answers one switch, with the default for an org nothing was set on', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ settings: null });

    await expect(orgHasSwitch(ORG, 'leads')).resolves.toBe(true);
    await expect(orgHasSwitch(ORG, 'reports')).resolves.toBe(false);
  });

  it('fails closed on a key nobody registers, even one stored on the org', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['repots'], off: [] } },
    });

    await expect(orgHasSwitch(ORG, 'repots')).resolves.toBe(false);
  });
});

describe('orgSwitchState: off kept apart from could-not-tell (t-1034)', () => {
  beforeEach(registerBoth);

  it('is on or off for a slice that was read', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['reports'], off: ['leads'] } },
    });

    await expect(orgSwitchState(ORG, 'reports')).resolves.toBe('on');
    await expect(orgSwitchState(ORG, 'leads')).resolves.toBe('off');
  });

  it('is off for an org that does not exist, as orgHasSwitch answers false', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    await expect(orgSwitchState(ORG, 'leads')).resolves.toBe('off');
  });

  it('is unknown, not off, when the read throws, and logs it', async () => {
    mockPrisma.org.findUnique.mockRejectedValue(new Error('connection reset'));

    await expect(orgSwitchState(ORG, 'reports')).resolves.toBe('unknown');
    expect(logger.error).toHaveBeenCalledWith(
      "entitlements: could not read an org's switches",
      expect.objectContaining({ orgId: ORG, key: 'reports', error: 'connection reset' })
    );
  });

  it('is unknown for a stored slice that could not be read, though access reads it as off', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: 'reports', off: [] } },
    });

    await expect(orgHasSwitch(ORG, 'reports')).resolves.toBe(false);
    await expect(orgSwitchState(ORG, 'reports')).resolves.toBe('unknown');
  });

  it("is unknown when the app's initAppEntitlements() failed", async () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('bad init');
    });
    mockPrisma.org.findUnique.mockResolvedValue({ settings: null });

    await expect(orgSwitchState(ORG, 'reports')).resolves.toBe('unknown');
  });
});

describe('setOrgSwitches', () => {
  beforeEach(registerBoth);

  /** The entitlements slice the last write stored, or undefined when it removed it. */
  function storedSlice() {
    const call = mockPrisma.org.update.mock.calls.at(-1) as
      [{ data: { settings: unknown } }] | undefined;
    const settings = call?.[0].data.settings as { entitlements?: unknown } | undefined;
    return settings?.entitlements;
  }

  it('sets only the switches it names, leaving every other stored value alone', async () => {
    // `beta` was set by a newer build; `retired` by an older one.
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['beta', 'retired'], off: ['leads'] } },
    });

    const written = await setOrgSwitches(ORG, { on: ['leads'], off: ['reports'] });

    expect(storedSlice()).toEqual({ on: ['beta', 'leads', 'retired'], off: ['reports'] });
    expect(written?.previous).toEqual({
      on: ['beta', 'retired'],
      off: ['leads'],
      unreadable: false,
    });
  });

  it('leaves a switch it does not name at its default, rather than setting it off', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ settings: null });

    // A writer that only knew about `reports`.
    await setOrgSwitches(ORG, { on: ['reports'], off: [] });

    expect(storedSlice()).toEqual({ on: ['reports'], off: [] });
    mockPrisma.org.findUnique.mockResolvedValue({ settings: { entitlements: storedSlice() } });
    await expect(orgHasSwitch(ORG, 'leads')).resolves.toBe(true);
  });

  it('puts every registered switch back to its default for null, keeping keys nothing registers', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['reports', 'retired'], off: ['leads', 'older'] } },
    });

    await setOrgSwitches(ORG, null);

    expect(storedSlice()).toEqual({ on: ['retired'], off: ['older'] });
  });

  it('keeps the keys an unreadable slice held, but off, so the save neither drops nor grants them', async () => {
    // `off` is missing: the org has nothing. `old_pkg` is a key this build
    // does not register (a newer build's, or a retired one).
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['old_pkg', 'reports'] } },
    });

    await setOrgSwitches(ORG, { on: [], off: ['reports', 'leads'] });

    expect(storedSlice()).toEqual({ on: [], off: ['leads', 'old_pkg', 'reports'] });
  });

  it('turns nothing on over an unreadable slice but what the change sets on', async () => {
    // `off` is not a list: the org has nothing, and the slice may have set `leads` off.
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['old_pkg', 'leads'], off: 'leads' } },
    });

    await setOrgSwitches(ORG, { on: ['reports'], off: [] });

    // `leads` (on by default, and held in `on`) is set off, not left to its
    // default or kept on; the unregistered `old_pkg` is kept, off.
    expect(storedSlice()).toEqual({ on: ['reports'], off: ['leads', 'old_pkg'] });
  });

  it('puts an unreadable slice back to the defaults for null, as asked, keeping its other keys off', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['old_pkg', 'leads'], off: 'x' } },
    });

    await setOrgSwitches(ORG, null);

    expect(storedSlice()).toEqual({ on: [], off: ['old_pkg'] });
  });

  it('writes nothing for a change that names nothing, even over an unreadable slice', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['reports'], off: 5 } },
    });

    const written = await setOrgSwitches(ORG, { on: [], off: [] });

    expect(written?.changed).toBe(false);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing named, nothing written
  });

  it('refuses any write while the registration has failed, writing nothing', async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(setOrgSwitches(ORG, null)).rejects.toThrow(/failed to register/);
    await expect(setOrgSwitches(ORG, { on: ['leads'], off: [] })).rejects.toThrow(
      /failed to register/
    );
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('is null, writing nothing, for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    await expect(setOrgSwitches(ORG, { on: ['reports'], off: [] })).resolves.toBeNull();
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });
});

describe('switchUnverifiedMessage (t-1034)', () => {
  it('names the switch by its label', () => {
    registerBoth();
    expect(switchUnverifiedMessage('leads')).toBe(
      'We could not check whether your organisation has Lead generation, so this was refused. Try again in a moment.'
    );
  });

  it('shows no internal key when there is no label, as when the app init failed', () => {
    expect(switchUnverifiedMessage('leads')).toBe(
      'We could not check whether your organisation has the feature this needs, so this was refused. Try again in a moment.'
    );
  });
});

describe('registerMeter (§135 t-1035)', () => {
  const validMeter = (overrides: Partial<MeterDefinition> = {}): MeterDefinition => ({
    key: 'convos',
    label: 'Conversations',
    period: 'month',
    count: () => 0,
    ...overrides,
  });

  /** Register through the init, as an app does, so a throw takes the rollback path. */
  function initRegisters(fn: () => void) {
    vi.mocked(initAppEntitlements).mockImplementation(fn);
  }

  it('ships with no meters', () => {
    expect(registeredMeters()).toEqual([]);
  });

  it('stores a meter with its label and description trimmed and a missing description as empty', () => {
    const count = vi.fn();
    initRegisters(() => {
      registerMeter(
        validMeter({ label: '  Conversations  ', description: '  Finished this month.  ', count })
      );
      registerMeter(validMeter({ key: 'plain', label: 'Plain', period: 'standing' }));
    });

    const [first, second] = registeredMeters();

    expect(first).toMatchObject({
      key: 'convos',
      label: 'Conversations',
      description: 'Finished this month.',
      period: 'month',
      count,
    });
    expect(second).toMatchObject({ key: 'plain', description: '', period: 'standing' });
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('accepts a function period', () => {
    const period = vi.fn();
    initRegisters(() => registerMeter(validMeter({ period })));

    expect(registeredMeters()[0].period).toBe(period);
  });

  it.each([
    ['upper case', 'Convos'],
    ['a hyphen', 'my-meter'],
    ['a leading digit', '1convos'],
    ['empty', ''],
    ['not a string', 42],
  ])('refuses a key that is %s', (_what, key) => {
    initRegisters(() => registerMeter(validMeter({ key: key as never })));

    expect(registeredMeters()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('threw'),
      expect.objectContaining({ error: expect.stringContaining('must be lower-case') })
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['missing', undefined],
  ])('refuses a label that is %s', (_what, label) => {
    initRegisters(() => registerMeter(validMeter({ label: label as never })));

    expect(registeredMeters()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('threw'),
      expect.objectContaining({ error: expect.stringContaining('needs a label') })
    );
  });

  it.each([
    ['an unknown word', 'weekly'],
    ['a number', 7],
    ['missing', undefined],
  ])('refuses a period that is %s', (_what, period) => {
    initRegisters(() => registerMeter(validMeter({ period: period as never })));

    expect(registeredMeters()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('threw'),
      expect.objectContaining({
        error: expect.stringContaining("'month', 'standing' or a function"),
      })
    );
  });

  it('refuses a count that is not a function', () => {
    initRegisters(() => registerMeter(validMeter({ count: 5 as never })));

    expect(registeredMeters()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('threw'),
      expect.objectContaining({ error: expect.stringContaining('needs a count function') })
    );
  });

  it('refuses a meter past the cap, but lets a registered key be replaced at the cap', () => {
    initRegisters(() => {
      for (let i = 0; i < MAX_METERS; i += 1) {
        registerMeter(validMeter({ key: `m${i}`, label: `Meter ${i}` }));
      }
      registerMeter(validMeter({ key: 'm0', label: 'Replaced' }));
    });
    expect(registeredMeters()).toHaveLength(MAX_METERS);
    expect(registeredMeters()[0].label).toBe('Replaced');

    __resetEntitlementRegistryForTests();
    vi.mocked(logger.error).mockClear();
    initRegisters(() => {
      for (let i = 0; i <= MAX_METERS; i += 1) {
        registerMeter(validMeter({ key: `m${i}`, label: `Meter ${i}` }));
      }
    });
    expect(registeredMeters()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('threw'),
      expect.objectContaining({ error: expect.stringContaining(`At most ${MAX_METERS} meters`) })
    );
  });

  it('replaces a meter registered twice under one key, keeping its place', () => {
    initRegisters(() => {
      registerMeter(validMeter({ key: 'a', label: 'Old' }));
      registerMeter(validMeter({ key: 'b', label: 'B' }));
      registerMeter(validMeter({ key: 'a', label: 'New' }));
    });

    expect(registeredMeters().map((m) => [m.key, m.label])).toEqual([
      ['a', 'New'],
      ['b', 'B'],
    ]);
  });

  it('rolls back meters and switches together when the init throws part-way', () => {
    initRegisters(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
      registerMeter(validMeter());
      throw new Error('boom');
    });

    expect(registeredMeters()).toEqual([]);
    expect(registeredEntitlementSwitches()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('entitlements: initAppEntitlements threw'),
      expect.anything()
    );
  });

  it('rolls back the switches when only a meter registration throws', () => {
    initRegisters(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
      registerMeter(validMeter({ label: '' }));
    });

    expect(registeredEntitlementSwitches()).toEqual([]);
    expect(registeredMeters()).toEqual([]);
    expect(entitlementSwitchesFailed()).toBe(true);
  });

  it('keeps both the switches and the meters when the init succeeds', () => {
    initRegisters(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
      registerMeter(validMeter());
    });

    expect(registeredEntitlementSwitches().map((s) => s.key)).toEqual(['reports']);
    expect(registeredMeters().map((m) => m.key)).toEqual(['convos']);
    expect(initAppEntitlements).toHaveBeenCalledOnce();
  });
});
