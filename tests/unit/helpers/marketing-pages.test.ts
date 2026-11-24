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
    ["export * from '@/lib/app/pages/about';"],
    ["export {\n  default,\n  generateMetadata,\n} from '@/components/app/about-page';"],
  ])('recognises a re-export of the page from a fork tier without the marker: %s', (src) => {
    expect(isForkShim(src)).toBe(true);
  });

  it('recognises the app:shim marker on its own', () => {
    expect(isForkShim("// app:shim\nexport { default } from './mine';")).toBe(true);
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

  it('leaves a re-export from a platform path alone', () => {
    expect(isForkShim("export { default } from '@/components/marketing/contact-page';")).toBe(
      false
    );
  });
});

describe('isPlatformMarketingPage', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'marketing-pages-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const write = (page: (typeof MARKETING_PAGES)[number], src: string) => {
    const file = marketingPageFile(page, cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, src);
  };

  it('is true for a page that is the platform’s own', () => {
    write('privacy', 'export default async function PrivacyPage() { return null; }');
    expect(isPlatformMarketingPage('privacy', cwd)).toBe(true);
  });

  it('is false for a page a fork has shimmed', () => {
    write('contact', SECTION_6_SHIM);
    expect(isPlatformMarketingPage('contact', cwd)).toBe(false);
  });

  it('is false for a page a fork has deleted', () => {
    expect(isPlatformMarketingPage('about', cwd)).toBe(false);
  });
});
