/**
 * Tests for the Node major-version consistency rules.
 *
 * @see scripts/ci/node-version.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  checkNodeVersion,
  formatResult,
  parseDockerfileMajor,
  parseEnginesMajor,
  parseNvmrc,
  type NodeVersionSource,
} from '@/scripts/ci/node-version';

function source(label: string, major: number | null, raw = ''): NodeVersionSource {
  return { label, major, raw };
}

describe('parseNvmrc', () => {
  it('reads a bare major', () => {
    expect(parseNvmrc('24\n')).toBe(24);
  });

  it('reads a v-prefixed and dotted version', () => {
    expect(parseNvmrc('v24.9.0\n')).toBe(24);
  });

  it('ignores trailing blank lines and surrounding whitespace', () => {
    expect(parseNvmrc('  24  \n\n')).toBe(24);
  });

  it('returns null for something that is not a version', () => {
    expect(parseNvmrc('lts/hydrogen\n')).toBeNull();
    expect(parseNvmrc('')).toBeNull();
  });
});

describe('parseDockerfileMajor', () => {
  it('reads the major from a FROM line with a stage alias', () => {
    expect(parseDockerfileMajor('# comment\nFROM node:24-alpine AS base\n')).toBe(24);
  });

  it('reads it without an alias', () => {
    expect(parseDockerfileMajor('FROM node:24-alpine\n')).toBe(24);
  });

  it('is not tied to alpine — a fork on another base still gets checked', () => {
    // Skipping non-alpine bases would silently exempt exactly the forks most
    // likely to drift.
    expect(parseDockerfileMajor('FROM node:24-bookworm-slim AS base\n')).toBe(24);
  });

  it('takes the first FROM node: line when several stages exist', () => {
    expect(parseDockerfileMajor('FROM node:24-alpine AS base\nFROM base AS deps\n')).toBe(24);
  });

  it('returns null when no FROM node: line is present', () => {
    expect(parseDockerfileMajor('FROM nginx:alpine\n')).toBeNull();
  });
});

describe('parseEnginesMajor', () => {
  it('reads the floor from a >= range', () => {
    expect(parseEnginesMajor('>=24')).toBe(24);
    expect(parseEnginesMajor('>=24.0.0')).toBe(24);
  });

  it('returns null when engines is absent', () => {
    expect(parseEnginesMajor(undefined)).toBeNull();
  });
});

describe('checkNodeVersion', () => {
  it('passes when every source agrees', () => {
    const result = checkNodeVersion([
      source('.nvmrc', 24),
      source('Dockerfile', 24),
      source('Dockerfile.dev', 24),
      source('package.json engines.node', 24),
    ]);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('fails when the Dockerfile lags a bumped .nvmrc — the motivating drift', () => {
    // CI would go green on 26 while the shipped image still builds 24.
    const result = checkNodeVersion([
      source('.nvmrc', 26),
      source('Dockerfile', 24),
      source('Dockerfile.dev', 26),
      source('package.json engines.node', 26),
    ]);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('Dockerfile=24');
    expect(result.problems[0]).toContain('.nvmrc=26');
  });

  it('fails an unparseable source rather than skipping it', () => {
    // "Cannot read it" and "it disagrees" have identical consequences when
    // nobody is watching the file.
    const result = checkNodeVersion([
      source('.nvmrc', 24),
      source('Dockerfile', null, 'FROM node:${TAG}'),
      source('Dockerfile.dev', 24),
      source('package.json engines.node', 24),
    ]);

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('Dockerfile');
    expect(result.problems[0]).toContain('could not read');
  });

  it('reports the unparseable source and the disagreement separately', () => {
    const result = checkNodeVersion([
      source('.nvmrc', 26),
      source('Dockerfile', 24),
      source('Dockerfile.dev', null, '(no FROM node: line)'),
      source('package.json engines.node', 24),
    ]);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
  });

  it('does not flag a single source as disagreeing with itself', () => {
    expect(checkNodeVersion([source('.nvmrc', 24)]).ok).toBe(true);
  });
});

describe('formatResult', () => {
  // This is the function that becomes the gate's exit code. Without these,
  // `checkNodeVersion` could keep returning `ok: false` on drift while an edit
  // here returned 0 — the CI step would go green and all the tests above would
  // stay green with it.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a NON-ZERO exit code when the check failed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(formatResult({ ok: false, problems: ['Dockerfile=24, .nvmrc=26'] }, null)).not.toBe(0);
  });

  it('returns 0 when the check passed', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(formatResult({ ok: true, problems: [] }, 24)).toBe(0);
  });

  it('prints every problem, so a second disagreement is not hidden by the first', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    formatResult({ ok: false, problems: ['first problem', 'second problem'] }, null);

    const printed = error.mock.calls.flat().join('\n');
    expect(printed).toContain('first problem');
    expect(printed).toContain('second problem');
  });

  it('reports the agreed major on success so the log says what it agreed on', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    formatResult({ ok: true, problems: [] }, 24);

    expect(log.mock.calls.flat().join('\n')).toContain('24');
  });
});
