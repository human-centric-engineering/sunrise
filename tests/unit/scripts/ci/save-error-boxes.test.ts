/**
 * Tests for the hand-drawn save-error box rules (§124 t-950).
 *
 * Each rule has a planted box it must report and a near miss it must not: a
 * scan that cannot be shown to report is not evidence of a clean tree. The
 * CLI's wiring, and the real tree passing, are in
 * `check-save-error-boxes.test.ts`.
 *
 * @see scripts/ci/save-error-boxes.ts
 */

import { describe, it, expect } from 'vitest';

import {
  applyExemptions,
  BOX_EXEMPTIONS,
  formatBox,
  scanSaveErrorBoxes,
} from '@/scripts/ci/save-error-boxes';

/** A component around `body` (statements) and `jsx` (what it returns). */
function component(body: string, jsx: string): string {
  return [
    "import { useState } from 'react';",
    'export function Form() {',
    '  const [error, setError] = useState<string | null>(null);',
    body,
    `  return (<div>${jsx}</div>);`,
    '}',
  ].join('\n');
}

const RED_BOX = '{error && <div className="bg-destructive/10 text-destructive p-3">{error}</div>}';

const CATCH_SAVE = `
  async function save() {
    setError(null);
    try {
      await apiClient.patch('/api/v1/x', { body: {} });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }`;

const scan = (source: string) => scanSaveErrorBoxes(source, 'components/x.tsx');

describe('scripts/ci/save-error-boxes', () => {
  describe('what counts as a save error', () => {
    it('reports state set in the catch of a try that sends a mutation', () => {
      const source = component(CATCH_SAVE, RED_BOX);
      const line = source.split('\n').findIndex((l) => l.includes('bg-destructive/10')) + 1;

      expect(scan(source)).toEqual([{ path: 'components/x.tsx', line, state: 'error' }]);
    });

    it.each([
      ['apiClient.post', "await apiClient.post('/x', { body: {} });"],
      ['apiClient.put', "await apiClient.put('/x', { body: {} });"],
      ['apiClient.delete', "await apiClient.delete('/x');"],
      ['a fetch with a method', "await fetch('/x', { method: 'POST' });"],
      [
        'a fetch with a computed method',
        "await fetch('/x', { method: isEdit ? 'PATCH' : 'POST' });",
      ],
      ['an authClient call', 'await authClient.updateUser({ image: "" });'],
      ['a fetch with a shorthand method', "await fetch('/x', { method, body });"],
    ])('treats %s as a mutation', (_name, call) => {
      const body = `async function save() { try { ${call} } catch { setError('Failed'); } }`;

      expect(scan(component(body, RED_BOX))).toHaveLength(1);
    });

    it.each([
      ['apiClient.get', "await apiClient.get('/x');"],
      ['a bare fetch', "await fetch('/x');"],
      ['a fetch with GET', "await fetch('/x', { method: 'GET' });"],
      ['authClient.getSession', 'await authClient.getSession();'],
      ['authClient.useSession', 'authClient.useSession();'],
      ['authClient.listSessions', 'await authClient.listSessions();'],
    ])('does not report a load error: %s', (_name, call) => {
      const body = `async function load() { try { ${call} } catch { setError('Failed'); } }`;

      expect(scan(component(body, RED_BOX))).toEqual([]);
    });

    it("reports state set in a mutation's onError callback (better-auth)", () => {
      const body = `
        async function signIn() {
          await authClient.signIn.email({ email, password }, {
            onError: (ctx) => { setError(ctx.error.message); },
          });
        }`;

      expect(scan(component(body, RED_BOX))).toHaveLength(1);
    });

    it("reports state set in a .catch() on a mutation's promise chain", () => {
      const body = `
        function remove() {
          apiClient.delete('/x').then(() => refresh()).catch((err) => setError(String(err)));
        }`;

      expect(scan(component(body, RED_BOX))).toHaveLength(1);
    });

    it("does not report a .catch() on a load's promise chain", () => {
      const body = `
        function load() {
          apiClient.get('/x').then(setRows).catch(() => setError('Could not load'));
        }`;

      expect(scan(component(body, RED_BOX))).toEqual([]);
    });

    it("reports state set in an if on a mutation's result (a refusal answered, not thrown)", () => {
      const body = `
        async function change() {
          const { error: refused } = await authClient.changePassword({ newPassword });
          if (refused) { setError(refused.message); return; }
        }`;

      expect(scan(component(body, RED_BOX))).toHaveLength(1);
    });

    it("reports state set in the else of an if on a mutation's result", () => {
      const body = `
        async function send() {
          const res = await fetch('/x', { method: 'POST' });
          if (res.ok) { setSent(true); } else { setError('Failed to send'); }
        }`;

      expect(scan(component(body, RED_BOX))).toHaveLength(1);
    });

    it("reports state set in an if on a .then() callback's mutation result", () => {
      // No .catch and no await: the result arrives as the callback's parameter.
      const body = `
        function send() {
          fetch('/x', { method: 'POST' }).then((r) => {
            if (!r.ok) setError('Failed to send');
          });
        }`;

      expect(scan(component(body, RED_BOX))).toHaveLength(1);
    });

    it("does not report an if on a load's .then() result", () => {
      const body = `
        function load() {
          fetch('/x').then((r) => { if (!r.ok) setError('Could not load'); });
        }`;

      expect(scan(component(body, RED_BOX))).toEqual([]);
    });

    it('does not report a sign-in prompt read from authClient.useSession()', () => {
      const body = `
        const { data: session } = authClient.useSession();
        if (!session) setError('Please sign in');`;

      expect(scan(component(body, RED_BOX))).toEqual([]);
    });

    it("does not take another function's result of the same name for the mutation's", () => {
      // The export's `res` and the load's `res` are different bindings.
      const body = `
        async function exportAll() {
          const res = await fetch('/x/export', { method: 'POST' });
          return res;
        }
        async function load() {
          const res = await fetch('/x');
          if (!res.ok) { setError('Could not load'); }
        }`;

      expect(scan(component(body, RED_BOX))).toEqual([]);
    });

    it('does not count a setter call that clears the state', () => {
      const body = `
        async function save() {
          try { await apiClient.patch('/x'); } catch { setError(null); setError(''); setError(undefined); }
        }`;

      expect(scan(component(body, RED_BOX))).toEqual([]);
    });
  });

  describe('what counts as a box', () => {
    it.each([
      ['bg-destructive/10', '<div className="bg-destructive/10 p-3">{error}</div>'],
      ['text-destructive', '<p className="text-destructive text-sm">{error}</p>'],
      ['bg-red-50', '<div className="rounded bg-red-50 p-3">{error}</div>'],
      ['text-red-600', '<p className="text-sm text-red-600">{error}</p>'],
      ['a dark: variant', '<p className="text-sm dark:text-red-400">{error}</p>'],
      ['a template className', '<p className={`mt-2 ${size} text-red-600`}>{error}</p>'],
      ['a cn() className', "<p className={cn('mt-2', 'text-destructive')}>{error}</p>"],
    ])('reports a red element named by %s', (_name, jsx) => {
      expect(scan(component(CATCH_SAVE, `{error && ${jsx}}`))).toHaveLength(1);
    });

    it.each([
      ['{error.message}', '<p className="text-destructive">{error.message}</p>'],
      ['{error || fallback}', '<p className="text-destructive">{error || \'Failed\'}</p>'],
      ['{error ?? fallback}', '<p className="text-destructive">{error ?? \'Failed\'}</p>'],
      ['a nested span', '<div className="text-destructive"><span>{error}</span></div>'],
    ])('reports the state shown as %s', (_name, jsx) => {
      expect(scan(component(CATCH_SAVE, jsx))).toHaveLength(1);
    });

    it('reports a value derived from the state, to any depth', () => {
      const body = `${CATCH_SAVE}
        const shown = error || oauthMessage;
        const displayError = shown;`;
      const jsx = '<div className="text-destructive">{displayError}</div>';

      expect(scan(component(body, jsx))).toEqual([
        expect.objectContaining({ state: 'displayError' }),
      ]);
    });

    it.each([
      ['an indexed lookup', 'const shown = results[id];', '{shown.message}'],
      ['an object spread', 'const all = { ...error, x: 1 };', '{all.name}'],
      ['a ternary branch', "const shown = busy ? '' : error;", '{shown}'],
      ['a template', 'const shown = `Failed: ${error}`;', '{shown}'],
    ])('reports state carried through %s', (_name, decl, child) => {
      const body = `${CATCH_SAVE}
        const results = { a: error };
        const id = 'a';
        ${decl}`;

      expect(scan(component(body, `<p className="text-destructive">${child}</p>`))).toHaveLength(1);
    });

    it.each([
      ['a ternary condition', "const label = error ? 'Retry' : 'Save';"],
      ['a boolean of it', 'const label = !!error;'],
      ['the left of &&', "const label = error && 'Retry';"],
    ])('does not report a value the state only decides: %s', (_name, decl) => {
      // A destructive button whose label the failure picks is not the failure.
      const body = `${CATCH_SAVE}
        ${decl}`;
      const jsx = '<Button className="bg-destructive text-white">{label}</Button>';

      expect(scan(component(body, jsx))).toEqual([]);
    });

    it('names the innermost red element, once', () => {
      const jsx = `
        <div className="border-red-200 bg-red-50">
          <h3>Danger zone</h3>
          <div className="text-destructive">{error}</div>
        </div>`;

      const boxes = scan(component(CATCH_SAVE, jsx));

      expect(boxes).toHaveLength(1);
      expect(component(CATCH_SAVE, jsx).split('\n')[boxes[0].line - 1]).toContain(
        'className="text-destructive"'
      );
    });

    it('does not report the shared components, which draw the box themselves', () => {
      const jsx =
        '<div className="text-destructive"><SaveError failure={error} /><FormError message={error} /></div>';

      expect(scan(component(CATCH_SAVE, jsx))).toEqual([]);
    });

    it('does not report a flag that only picks what renders', () => {
      const jsx = '<div className="bg-red-50">{error ? <Retry /> : <Done />}</div>';

      expect(scan(component(CATCH_SAVE, jsx))).toEqual([]);
    });

    it('does not report the state shown without red', () => {
      const jsx = '<p className="text-muted-foreground">{error}</p>';

      expect(scan(component(CATCH_SAVE, jsx))).toEqual([]);
    });

    it('does not report red on a field message (state never set by a save)', () => {
      const jsx = '<p className="text-destructive">{errors.email?.message}</p>';

      expect(scan(component(CATCH_SAVE, jsx))).toEqual([]);
    });

    it('stops at a component boundary: a red wrapper outside a render callback is not the box', () => {
      const jsx =
        '<div className="bg-red-50">{rows.map((r) => <Row key={r.id} note={<p>{error}</p>} />)}</div>';

      expect(scan(component(CATCH_SAVE, jsx))).toEqual([]);
    });
  });

  describe('the inline marker, for a fork', () => {
    it('excuses a box with the marker and a reason on the line above', () => {
      const jsx = `
        {/* save-error-box-ignore: a run, not a save */}
        <p className="text-destructive">{error}</p>`;

      expect(scan(component(CATCH_SAVE, jsx))).toEqual([]);
    });

    it('excuses a box with the // form, inside parentheses where JSX braces do not parse', () => {
      const jsx = `
        {error && (
          // save-error-box-ignore: a run, not a save
          <p className="text-destructive">{error}</p>
        )}`;

      expect(scan(component(CATCH_SAVE, jsx))).toEqual([]);
    });

    it('does not excuse a marker with no reason', () => {
      const jsx = `
        {/* save-error-box-ignore: */}
        <p className="text-destructive">{error}</p>`;

      expect(scan(component(CATCH_SAVE, jsx))).toHaveLength(1);
    });

    it('does not excuse a box the marker is not directly above', () => {
      const jsx = `
        {/* save-error-box-ignore: a run, not a save */}
        <span />
        <p className="text-destructive">{error}</p>`;

      expect(scan(component(CATCH_SAVE, jsx))).toHaveLength(1);
    });
  });

  describe('exemptions', () => {
    const box = { path: 'components/run.tsx', line: 3, state: 'error' };

    it('drops a box an exemption covers, and reports an exemption nothing matches', () => {
      const report = applyExemptions([box], {
        'components/run.tsx#error': 'a run',
        'components/gone.tsx#error': 'a run',
      });

      expect(report).toEqual({ boxes: [], staleExemptions: ['components/gone.tsx#error'] });
    });

    it('keys on the state too: another state in an exempt file is still reported', () => {
      const report = applyExemptions([{ ...box, state: 'saveError' }], {
        'components/run.tsx#error': 'a run',
      });

      expect(report.boxes).toHaveLength(1);
    });

    it('gives every shipped exemption a reason', () => {
      for (const [key, reason] of Object.entries(BOX_EXEMPTIONS)) {
        expect(key).toMatch(/^(components|app)\/.+\.tsx#\w+$/);
        expect(reason.length).toBeGreaterThan(20);
      }
    });
  });

  it('formats a box with where it is and what it shows', () => {
    expect(formatBox({ path: 'components/x.tsx', line: 14, state: 'error' })).toBe(
      'components/x.tsx:14  renders `error` in a red box of its own'
    );
  });
});
