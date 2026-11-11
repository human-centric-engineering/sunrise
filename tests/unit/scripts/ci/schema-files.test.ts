/**
 * The shared schema reader and tier rule every schema guard relies on. A wrong
 * answer here is a wrong answer in all of them at once, and in the direction
 * that hides a model: a guard that never reads a file passes on it.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_SCHEMA_FILES,
  SCHEMA_DIR,
  isForkOwnedSchemaFile,
  schemaDir,
  listSchemaFiles,
  readSchemaFiles,
  schemaTierOf,
} from '@/scripts/ci/schema-files';

describe('schemaTierOf', () => {
  it('gives core exactly the top-level files on the allowlist', () => {
    expect(schemaTierOf('auth.prisma')).toBe('core');
    expect(schemaTierOf('platform.prisma')).toBe('core');
    // A fork folder reusing a core file name is still the fork's.
    expect(schemaTierOf('app/auth.prisma')).toBe('app');
  });

  it("treats any other file as a fork tier's, whatever it is named (#533)", () => {
    expect(schemaTierOf('app.prisma')).toBe('app');
    expect(schemaTierOf('app-billing.prisma')).toBe('app');
    expect(schemaTierOf('billing.prisma')).toBe('app');
    expect(isForkOwnedSchemaFile('billing.prisma')).toBe(true);
    expect(isForkOwnedSchemaFile('tenancy.prisma')).toBe(false);
  });

  it('gives the framework tier a top-level file or folder named framework or framework-*', () => {
    expect(schemaTierOf('framework-modules.prisma')).toBe('framework');
    expect(schemaTierOf('framework/modules.prisma')).toBe('framework');
    expect(schemaTierOf('framework-modules/deep/modules.prisma')).toBe('framework');
    expect(schemaTierOf('frameworks.prisma')).toBe('app');
  });

  it("leaves a leaf's own folders the app's, whatever they are called inside it", () => {
    // Only the top level decides, so a leaf cannot move a model into its upstream's zone.
    expect(schemaTierOf('app/framework-adapters/sync.prisma')).toBe('app');
    expect(schemaTierOf('misc/framework-tasks.prisma')).toBe('app');
  });

  it('reads Windows separators the same way', () => {
    expect(schemaTierOf('framework\\modules.prisma')).toBe('framework');
  });
});

describe('listSchemaFiles / readSchemaFiles', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reads every .prisma file at any depth, sorted, with / separators', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'schema-files-'));
    mkdirSync(path.join(dir, 'app', 'widgets'), { recursive: true });
    writeFileSync(path.join(dir, 'auth.prisma'), 'model User {\n}\n');
    writeFileSync(path.join(dir, 'app', 'widgets', 'widget.prisma'), 'model AppWidget {\n}\n');
    writeFileSync(path.join(dir, 'app', 'notes.md'), 'not a schema');

    expect(listSchemaFiles(dir)).toEqual(['app/widgets/widget.prisma', 'auth.prisma']);
    expect(readSchemaFiles(dir)).toEqual([
      { name: 'app/widgets/widget.prisma', contents: 'model AppWidget {\n}\n' },
      { name: 'auth.prisma', contents: 'model User {\n}\n' },
    ]);
  });

  it('skips a folder whose name ends in .prisma instead of crashing on it', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'schema-files-'));
    mkdirSync(path.join(dir, 'billing.prisma'));
    writeFileSync(path.join(dir, 'billing.prisma', 'invoice.prisma'), 'model Invoice {\n}\n');

    expect(listSchemaFiles(dir)).toEqual(['billing.prisma/invoice.prisma']);
    expect(readSchemaFiles(dir)).toHaveLength(1);
  });

  it('defaults to prisma/schema under the current directory at call time', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'schema-files-'));
    mkdirSync(path.join(dir, 'prisma', 'schema'), { recursive: true });
    writeFileSync(path.join(dir, 'prisma', 'schema', 'only.prisma'), 'model Only {\n}\n');
    const start = process.cwd();
    try {
      process.chdir(dir);
      // Not the directory the module was imported from: a synthetic cwd applies.
      expect(listSchemaFiles()).toEqual(['only.prisma']);
      expect(schemaDir()).not.toBe(SCHEMA_DIR);
    } finally {
      process.chdir(start);
    }
  });

  it('lists every core file on the allowlist from the real schema', () => {
    // A renamed or removed core file would otherwise leave its models treated as
    // a fork's, out of core's stricter rules. This is the one place it is held.
    const onDisk = new Set(readdirSync(SCHEMA_DIR));
    const missing = [...CORE_SCHEMA_FILES].filter((f) => !onDisk.has(f)).sort();
    expect(
      missing,
      'CORE_SCHEMA_FILES names a file that is not in prisma/schema. If you renamed or removed ' +
        'a core schema file, update CORE_SCHEMA_FILES in scripts/ci/schema-files.ts to match.'
    ).toEqual([]);
    expect(listSchemaFiles()).toEqual(expect.arrayContaining([...CORE_SCHEMA_FILES]));
  });
});
