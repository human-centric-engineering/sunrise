/**
 * Node major-version consistency check — CLI.
 *
 * The rules, and why this is needed at all, live in
 * `scripts/ci/node-version.ts`. This file only reads the four files and hands
 * their contents over, so importing the rules never touches the filesystem.
 *
 * Usage:
 *   npm run check:node-version
 */

import { readFileSync } from 'fs';

import {
  checkNodeVersion,
  formatResult,
  parseDockerfileMajor,
  parseEnginesMajor,
  parseNvmrc,
  type NodeVersionSource,
} from '@/scripts/ci/node-version';

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const pkgRaw = read('package.json');
let enginesNode: string | undefined;
try {
  enginesNode = (JSON.parse(pkgRaw) as { engines?: { node?: string } }).engines?.node;
} catch {
  enginesNode = undefined;
}

const nvmrc = read('.nvmrc');
const dockerfile = read('Dockerfile');
const dockerfileDev = read('Dockerfile.dev');

const sources: NodeVersionSource[] = [
  { label: '.nvmrc', major: parseNvmrc(nvmrc), raw: nvmrc.trim() },
  {
    label: 'Dockerfile',
    major: parseDockerfileMajor(dockerfile),
    raw:
      dockerfile
        .split('\n')
        .find((l) => /^\s*FROM\s+node:/i.test(l))
        ?.trim() ?? '(no FROM node: line)',
  },
  {
    label: 'Dockerfile.dev',
    major: parseDockerfileMajor(dockerfileDev),
    raw:
      dockerfileDev
        .split('\n')
        .find((l) => /^\s*FROM\s+node:/i.test(l))
        ?.trim() ?? '(no FROM node: line)',
  },
  {
    label: 'package.json engines.node',
    major: parseEnginesMajor(enginesNode),
    raw: enginesNode ?? '(absent)',
  },
];

const result = checkNodeVersion(sources);
const agreed = sources.find((s) => s.major !== null)?.major ?? null;

// `process.exitCode`, not `process.exit()` — stderr is asynchronous when it is
// a pipe, which it is under both `npm run` and GitHub Actions, and exiting
// discards whatever is still queued.
process.exitCode = formatResult(result, agreed);
