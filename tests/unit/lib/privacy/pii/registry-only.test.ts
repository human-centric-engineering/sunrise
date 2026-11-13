/**
 * Core's detectors are reached only through the privacy registry (§127,
 * t-989).
 *
 * The registry is where a detector gets its timeout, its validation, its
 * failure handling, and where an app can replace it by id. A core module that
 * imported a tier and called it directly would skip all four, and an app's
 * replacement would silently not apply there. So:
 *
 * - only `lib/privacy/adapters/core-defaults.ts` may import a tier's detector
 *   module (outside `lib/privacy/pii/` itself);
 * - only `lib/privacy/adapters/run.ts` may call `.detect(`;
 * - only `core-defaults.ts` may build core's token strategy, so an app's
 *   replacement (`registerPrivacyTokenStrategy()`) cannot be bypassed.
 *
 * This reads the tree, so it is declared in `ALWAYS_RUN_TESTS`: a new caller
 * in some unrelated module would not select it by module graph.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  __resetPrivacyAdaptersForTests,
  getPrivacyAdapters,
} from '@/lib/privacy/adapters/registry';
import { KNOWN_VALUES_DETECTOR_ID } from '@/lib/privacy/pii/known-values';
import { LISTS_DETECTOR_ID } from '@/lib/privacy/pii/lists';
import { RULES_DETECTOR_ID } from '@/lib/privacy/pii/rules';

vi.mock('@/lib/app/privacy-adapters', () => ({ initAppPrivacyAdapters: () => undefined }));

const ROOT = process.cwd();
const SCANNED_DIRS = ['lib', 'app', 'components', 'scripts'];

const DETECTOR_MODULE = /['"]@\/lib\/privacy\/pii\/(?:rules|known-values|lists)['"]/;
const DETECT_CALL = /\.detect\s*\(/;
/** Building core's token strategy directly would bypass an app's replacement. */
const STRATEGY_CALL = /\bstatelessTokenStrategy\s*\(/;

const MAY_IMPORT_DETECTORS = (file: string) =>
  file === 'lib/privacy/adapters/core-defaults.ts' || file.startsWith('lib/privacy/pii/');
/**
 * Files whose `.detect(` is some other object's method, not a privacy
 * detector's. The scan matches on the name, so each is listed with what it
 * calls; a privacy detector called from one of them would still be wrong.
 */
const NOT_A_PRIVACY_DETECTOR: Readonly<Record<string, string>> = {
  // `ConfigHealthCheck.detect()`: whether a setting is present (#865).
  'lib/config-health/run.ts': 'config-health presence check',
};
const MAY_CALL_DETECT = (file: string) =>
  file === 'lib/privacy/adapters/run.ts' || Object.hasOwn(NOT_A_PRIVACY_DETECTOR, file);
const MAY_BUILD_STRATEGY = (file: string) =>
  file === 'lib/privacy/adapters/core-defaults.ts' || file === 'lib/privacy/pii/token-strategy.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|mts|cts|js|mjs)$/.test(entry) && !/\.test\./.test(entry)) out.push(path);
  }
  return out;
}

/** Every line breaking the rule, as `file:line: text`. */
function violations(files: readonly { file: string; source: string }[]): string[] {
  const out: string[] = [];
  for (const { file, source } of files) {
    source.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (DETECTOR_MODULE.test(line) && !MAY_IMPORT_DETECTORS(file)) {
        out.push(`${file}:${i + 1}: imports a detector module: ${trimmed}`);
      }
      if (DETECT_CALL.test(line) && !MAY_CALL_DETECT(file)) {
        out.push(`${file}:${i + 1}: calls a detector directly: ${trimmed}`);
      }
      if (STRATEGY_CALL.test(line) && !MAY_BUILD_STRATEGY(file)) {
        out.push(`${file}:${i + 1}: builds the token strategy directly: ${trimmed}`);
      }
    });
  }
  return out;
}

describe('core detectors are reached only through the registry', () => {
  it('the scanner reports an import and a direct call when it sees them', () => {
    expect(
      violations([
        {
          file: 'lib/orchestration/chat/something.ts',
          source: [
            "import { rulesDetector } from '@/lib/privacy/pii/rules';",
            'const spans = await rulesDetector().detect({ text }, ctx);',
            'const session = statelessTokenStrategy().createSession({ scopeId });',
            "// import { listsDetector } from '@/lib/privacy/pii/lists'; — comments are fine",
          ].join('\n'),
        },
        {
          file: 'lib/privacy/adapters/core-defaults.ts',
          source: "import { rulesDetector } from '@/lib/privacy/pii/rules';",
        },
        { file: 'lib/privacy/adapters/run.ts', source: 'detector.detect({ text }, ctx)' },
      ])
    ).toEqual([
      "lib/orchestration/chat/something.ts:1: imports a detector module: import { rulesDetector } from '@/lib/privacy/pii/rules';",
      'lib/orchestration/chat/something.ts:2: calls a detector directly: const spans = await rulesDetector().detect({ text }, ctx);',
      'lib/orchestration/chat/something.ts:3: builds the token strategy directly: const session = statelessTokenStrategy().createSession({ scopeId });',
    ]);
  });

  it('no file in the tree breaks the rule', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((path) => ({
      file: relative(ROOT, path).split('\\').join('/'),
      source: readFileSync(path, 'utf8'),
    }));
    // A scan of nothing would pass: make sure it saw the files it is about.
    expect(files.map((f) => f.file)).toEqual(
      expect.arrayContaining([
        'lib/privacy/adapters/core-defaults.ts',
        'lib/privacy/adapters/run.ts',
      ])
    );
    expect(violations(files)).toEqual([]);
  });

  it('core registers all three tiers, required, in tier order', () => {
    __resetPrivacyAdaptersForTests();
    const { detectors, coreFailure } = getPrivacyAdapters();
    expect(coreFailure).toBeNull();
    expect(detectors.map((d) => [d.id, d.core, d.required, d.egress])).toEqual([
      [RULES_DETECTOR_ID, true, true, 'in_process'],
      [KNOWN_VALUES_DETECTOR_ID, true, true, 'in_process'],
      [LISTS_DETECTOR_ID, true, true, 'in_process'],
    ]);
  });
});
