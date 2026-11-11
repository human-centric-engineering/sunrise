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

  it('gives the framework tier any file or folder named framework or framework-*', () => {
    expect(schemaTierOf('framework-modules.prisma')).toBe('framework');
    expect(schemaTierOf('framework/modules.prisma')).toBe('framework');
    expect(schemaTierOf('framework-modules/modules.prisma')).toBe('framework');
    expect(schemaTierOf('modules/framework/tasks.prisma')).toBe('framework');
    expect(schemaTierOf('misc/framework-tasks.prisma')).toBe('framework');
    expect(schemaTierOf('frameworks.prisma')).toBe('app');
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

  it('lists every core file on the allowlist from the real schema', () => {
    // A renamed or removed core file would otherwise leave its models treated as a fork's.
    const onDisk = new Set(readdirSync(SCHEMA_DIR));
    expect([...CORE_SCHEMA_FILES].filter((f) => !onDisk.has(f))).toEqual([]);
    expect(listSchemaFiles()).toEqual(expect.arrayContaining([...CORE_SCHEMA_FILES]));
  });
});
