/**
 * The Prisma schema files, and which tier owns each one.
 *
 * Every guard that reads `prisma/schema` from disk reads it through here, so
 * they all see the same files and agree on whose each one is. Before this
 * there were five readers with three tier rules between them: an allowlist in
 * the export guard, `framework-*` in the tenancy guard, file-name patterns in
 * the zone guard. A fork file could be a fork's in one guard and core's in the
 * next.
 *
 * **Subfolders count.** Prisma loads `.prisma` files from every subfolder of
 * `prisma/schema`, so a guard that only listed the top level missed a fork
 * model kept in `prisma/schema/app/widgets.prisma`. A guard that misses a
 * model passes on it, so a `User`-linked model there shipped missing from the
 * subject-access export with the suite green. `listSchemaFiles` walks the whole
 * tree.
 *
 * Paths are relative to `prisma/schema`, with `/` separators on every OS.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** `prisma/schema` under the current directory, read when called. */
export function schemaDir(): string {
  return path.join(process.cwd(), 'prisma', 'schema');
}

/** `prisma/schema` under the directory this process started in. */
export const SCHEMA_DIR = schemaDir();

/**
 * Sunrise's own schema files. **Everything else in `prisma/schema/` belongs to a
 * fork tier**, whatever it is named and however deep it sits.
 *
 * Stated as an allowlist rather than a pattern for the fork-reserved names,
 * because core knows its own files exactly and cannot know what a fork will
 * call theirs. Matching only `app.prisma` and `framework-*.prisma` left a fork
 * that splits its domain across `app-billing.prisma` classified as core-owned,
 * held to core's rules, and unable to satisfy them from fork-owned code (#533).
 * Core keeps its files at the top level, so an entry is a bare file name.
 *
 * Adding a core schema file means adding it here. Until it is listed its
 * models are treated as a fork tier's, and the export guard's drift checks say
 * so.
 */
export const CORE_SCHEMA_FILES: ReadonlySet<string> = new Set([
  'auth.prisma',
  'base.prisma',
  'mcp.prisma',
  'orchestration-agents.prisma',
  'orchestration-conversations.prisma',
  'orchestration-evaluation.prisma',
  'orchestration-knowledge.prisma',
  'orchestration-ops.prisma',
  'orchestration-providers.prisma',
  'orchestration-workflows.prisma',
  'tenancy.prisma',
  // Sunrise's own app-domain models (ContactSubmission, FeatureFlag,
  // AuthBootstrap) live here, NOT in the fork-reserved app.prisma.
  'platform.prisma',
]);

export type SchemaTier = 'core' | 'framework' | 'app';

/** A `framework` or `framework-*` file or folder name, without `.prisma`. */
const FRAMEWORK_NAME = /^framework(-.+)?$/;

/**
 * The tier that owns `file`, a path relative to `prisma/schema`.
 *
 * Core is exactly `CORE_SCHEMA_FILES`. Any other file is a fork's. It is the
 * framework tier's when its top-level name, the file itself or the folder it
 * sits in directly under `prisma/schema`, is `framework` or `framework-*` (as
 * `lib/framework/` is). Otherwise it is the app tier's, so a leaf's
 * `billing.prisma`, `app/widgets.prisma` and `app/framework-adapters/x.prisma`
 * are all the app's. Only the top level decides, so a leaf naming a folder of
 * its own cannot move its models into its upstream's zone.
 */
export function schemaTierOf(file: string): SchemaTier {
  const segments = file.split(/[\\/]/);
  if (segments.length === 1 && CORE_SCHEMA_FILES.has(file)) return 'core';
  return FRAMEWORK_NAME.test(segments[0].replace(/\.prisma$/, '')) ? 'framework' : 'app';
}

/** Whether a schema file belongs to a fork tier rather than to Sunrise. */
export function isForkOwnedSchemaFile(file: string): boolean {
  return schemaTierOf(file) !== 'core';
}

/**
 * Every `.prisma` file under `dir`, at any depth, relative to it and sorted.
 * A folder whose name ends in `.prisma` is not a file and is left out, so it
 * cannot crash every guard with EISDIR.
 */
export function listSchemaFiles(dir: string = schemaDir()): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.prisma'))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

export interface SchemaFile {
  /** Path relative to `prisma/schema`, `/`-separated. */
  name: string;
  contents: string;
}

/** Every `.prisma` file under `dir` with its contents, in `listSchemaFiles` order. */
export function readSchemaFiles(dir: string = schemaDir()): SchemaFile[] {
  return listSchemaFiles(dir).map((name) => ({
    name,
    contents: readFileSync(path.join(dir, name), 'utf8'),
  }));
}
