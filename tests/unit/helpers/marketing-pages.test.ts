/**
 * The classifier the static-pages test uses to skip a fork's taken-over
 * marketing page (#1317). Fixtures are written to a temp checkout so the
 * file-system half is exercised too, not just the source match.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKETING_PAGES,
  isForkShim,
  isPlatformMarketingPage,
  marketingPageFile,
} from '@/tests/helpers/marketing-pages';

const SECTION_6_SHIM = [
  '// app:shim — replaced by app-owned content; keep this line on upstream merges',
  "export { default, metadata } from '@/components/app/marketing/contact-page';",
].join('\n');

describe('isForkShim', () => {
  it('recognises the §6 shim exactly as CUSTOMIZATION.md prints it', () => {
    expect(isForkShim(SECTION_6_SHIM)).toBe(true);
  });

  it.each([
    ["export { default, metadata } from '@/components/app/marketing/terms-page';"],
    ['export { default } from "@/components/framework/marketing/privacy";'],
    ["export { default, generateMetadata } from '@/lib/app/pages/about';"],
    ["export {\n  default,\n  generateMetadata,\n} from '@/components/app/about-page';"],
    ["export { default, metadata } from '@/components/app';"],
  ])('recognises a re-export of the page from a fork tier without the marker: %s', (src) => {
    expect(isForkShim(src)).toBe(true);
  });

  // The marker is a note for whoever merges, not evidence: a platform page's
  // comment can mention it.
  it('leaves a page that carries the app:shim marker but re-exports nothing alone', () => {
    const src = [
      '// A fork replaces this file with an // app:shim re-export (CUSTOMIZATION.md §6).',
      'export default async function AboutPage() { return null; }',
    ].join('\n');
    expect(isForkShim(src)).toBe(false);
  });

  // `export *` never re-exports `default`, so the file still has its own page.
  it('leaves a page with its own default and an `export *` from a fork tier alone', () => {
    const src = [
      "export * from '@/components/app/about-extras';",
      'export default async function AboutPage() { return null; }',
    ].join('\n');
    expect(isForkShim(src)).toBe(false);
  });

  it('leaves a platform page that only imports a fork component alone', () => {
    const src = [
      "import { Banner } from '@/components/app/banner';",
      'export async function generateMetadata() { return {}; }',
      'export default async function ContactPage() { return <Banner />; }',
    ].join('\n');
    expect(isForkShim(src)).toBe(false);
  });

  it('leaves a re-export of something other than the page alone', () => {
    expect(isForkShim("export { metadata } from '@/components/app/marketing/seo';")).toBe(false);
  });

  it('leaves a fork default re-exported under another name alone', () => {
    const src = [
      "export { default as AboutHero } from '@/components/app/about-hero';",
      'export default async function AboutPage() { return null; }',
    ].join('\n');
    expect(isForkShim(src)).toBe(false);
  });

  it.each([
    ["// export { default, metadata } from '@/components/app/marketing/about';"],
    ["/* export { default, metadata } from '@/components/app/marketing/about'; */"],
  ])('leaves a commented-out shim line alone: %s', (src) => {
    expect(isForkShim(src)).toBe(false);
  });

  it('leaves a re-export from a tier-like platform path alone', () => {
    expect(isForkShim("export { default } from '@/components/appendix/about';")).toBe(false);
  });

  it('leaves a re-export from a platform path alone', () => {
    expect(isForkShim("export { default } from '@/components/marketing/contact-page';")).toBe(
      false
    );
  });
});

describe('isPlatformMarketingPage', () => {
  let root: string;
  const FORK = ['components/app'];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'marketing-pages-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (page: (typeof MARKETING_PAGES)[number], src: string) => {
    const file = marketingPageFile(page, root);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, src);
  };

  describe('in a fork (a tier declared)', () => {
    it('is true for a page that is the platform’s own', () => {
      write('privacy', 'export default async function PrivacyPage() { return null; }');
      expect(isPlatformMarketingPage('privacy', { root, tiers: FORK })).toBe(true);
    });

    it('is false for a page the fork has shimmed', () => {
      write('contact', SECTION_6_SHIM);
      expect(isPlatformMarketingPage('contact', { root, tiers: FORK })).toBe(false);
    });

    it('is false for a page the fork has deleted', () => {
      expect(isPlatformMarketingPage('about', { root, tiers: FORK })).toBe(false);
    });
  });

  // Upstream nothing is skipped: a moved or re-exported page fails its checks.
  describe('in Sunrise (no tier declared)', () => {
    it('is true for a page that has gone missing', () => {
      expect(isPlatformMarketingPage('about', { root, tiers: [] })).toBe(true);
    });

    it('is true for a page that re-exports from a fork tier', () => {
      write('contact', SECTION_6_SHIM);
      expect(isPlatformMarketingPage('contact', { root, tiers: [] })).toBe(true);
    });
  });

  it('resolves pages from this checkout, not the runner’s working directory', () => {
    expect(marketingPageFile('about')).toBe(
      path.resolve(__dirname, '..', '..', '..', 'app', '(public)', 'about', 'page.tsx')
    );
  });
});
