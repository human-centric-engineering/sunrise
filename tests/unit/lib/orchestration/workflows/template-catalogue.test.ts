/**
 * System-workflow slugs in the template catalogue (t-729).
 *
 * The backup importer recognises the seed's system workflows by slug, because
 * the row's `isSystem` flag is invisible when the row is absent or another
 * org's. These pin which slugs that is, and that the rule does not bleed into
 * the built-in templates, which have their own (different) import rule. Which
 * seeds write system workflows is pinned in
 * `tests/unit/prisma/seeds/system-workflow-slugs.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import {
  BUILTIN_TEMPLATE_SLUGS,
  isSystemWorkflowSlug,
} from '@/lib/orchestration/workflows/template-catalogue';
import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';

describe('isSystemWorkflowSlug', () => {
  it('recognises the provider-model audit the 010 seed owns', () => {
    expect(PROVIDER_MODEL_AUDIT_TEMPLATE.slug).toBe('tpl-provider-model-audit');
    expect(isSystemWorkflowSlug('tpl-provider-model-audit')).toBe(true);
  });

  it('does not claim an ordinary workflow slug', () => {
    expect(isSystemWorkflowSlug('onboarding-flow')).toBe(false);
  });

  it('does not claim a built-in template: those import under their own rule', () => {
    expect(BUILTIN_TEMPLATE_SLUGS.size).toBeGreaterThan(0);
    for (const slug of BUILTIN_TEMPLATE_SLUGS) {
      expect(isSystemWorkflowSlug(slug)).toBe(false);
    }
  });
});
