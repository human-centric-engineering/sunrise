/**
 * Admin nav registry (fork-readiness seam).
 *
 * Lets an app built on Sunrise add its own admin sidebar sections without
 * editing `components/admin/admin-sidebar.tsx`. The sidebar renders the core
 * sections followed by everything registered here.
 *
 * **Registration must be synchronous and module-import-time.** The sidebar is
 * a `'use client'` component that reads this registry during render — it is NOT
 * async and does not fetch. An app registers its sections at import time (the
 * same place it wires capabilities / erasure hooks), so the registry is fully
 * populated before the sidebar first renders, on both server and client. Do
 * NOT make registration async or DB-driven; that would force the sidebar
 * itself to become async, a far larger change.
 *
 * Sections are keyed by `title`, so re-registration under HMR or repeated
 * module imports replaces rather than duplicates — mirroring the
 * capability / erasure-hook registries.
 *
 * @see components/admin/admin-sidebar.tsx — the consumer that renders these
 */

import type { ComponentType, ReactNode } from 'react';
import type { AdminTier } from '@/lib/auth/admin-tier';

/** A single navigable link in the admin sidebar. */
export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  description: string;
  /** When true, the item is active only on an exact pathname match. */
  exact?: boolean;
  /** Optional numeric badge (e.g. pending-approval count). */
  badge?: number;
  /**
   * `'org'` when the page this links to is an org-tier surface (§111 t-810),
   * so the sidebar shows it to an org OWNER/ADMIN as well as a platform admin.
   * Absent — every item that has not opted in, a fork's included — the item
   * is the platform's, and an org admin does not see it.
   *
   * This decides what the sidebar SHOWS, not what opens: the page must also
   * be listed in `ORG_TIER_ADMIN_PAGES` (`lib/auth/admin-tier.ts`), and the
   * routes it calls declared `withAdminAuth(…, { tier: 'org' })`. An item
   * marked here over a page that is not is a link an org admin follows to a
   * redirect.
   */
  tier?: AdminTier;
}

/** A collapsible group of items nested inside a section. */
export interface NavSubgroup {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  items: NavItem[];
}

/**
 * A top-level sidebar section. A section holds either a flat `items` list or
 * `subgroups` (collapsible nested groups) — the core "AI Orchestration"
 * section uses subgroups; most use `items`.
 */
export interface NavSection {
  title: string;
  /**
   * Optional custom-rendered header for this section. When set, the sidebar
   * renders this node in place of the default uppercase `title` label (e.g. a
   * fork's brand wordmark). `title` is still required — it remains the React
   * key, the registry's dedupe key, and the section heading's accessible name,
   * so a custom node can never degrade a11y.
   */
  titleNode?: ReactNode;
  items?: NavItem[];
  subgroups?: NavSubgroup[];
}

const appSections = new Map<string, NavSection>();

/**
 * Register an admin nav section. Call at module-import time. Idempotent by
 * `title` — re-registering the same title replaces the prior section (safe
 * under HMR / repeated module imports). App sections render after the core
 * sections, in first-registration order.
 *
 * Use a `title` distinct from the core sidebar sections ("Overview",
 * "Management", "AI Orchestration", "System"). The sidebar keys rendered
 * sections by `title`, and the dedupe here spans app sections only — a title
 * that collides with a core section yields two siblings with the same React key.
 */
export function registerNavSection(section: NavSection): void {
  appSections.set(section.title, section);
}

/** All registered app sections, in first-registration order. */
export function getRegisteredNavSections(): NavSection[] {
  return [...appSections.values()];
}

/** Test-only: clear the registry so each test starts from a known state. */
export function __resetNavRegistryForTests(): void {
  appSections.clear();
}
