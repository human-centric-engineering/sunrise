/**
 * Config-health types — the admin "is critical configuration present?" check.
 *
 * A check reports **presence only**: whether an operationally-critical setting is configured, never
 * its value. See `lib/config-health/checks.ts` for the registry and `run.ts` for evaluation. The
 * report is surfaced in the admin dashboard (`components/admin/config-health-banner.tsx`).
 */

export type ConfigHealthSeverity = 'critical' | 'warning' | 'info';

/** A single registered check. `detect` MUST return a boolean presence signal, never a secret value. */
export interface ConfigHealthCheck {
  /** Stable id (often the env var name, e.g. `CRON_SECRET`). */
  key: string;
  /** Human label for the admin UI. */
  label: string;
  severity: ConfigHealthSeverity;
  /** What breaks when this is missing. */
  description: string;
  /** How the operator fixes it. */
  remediation: string;
  /** Optional `.context/**` doc path for deeper reading. */
  docsPath?: string;
  /** Only evaluated/flagged in production (e.g. `CRON_SECRET` — dev uses the in-process ticker). */
  productionOnly?: boolean;
  /** Optional relevance gate (e.g. the serverless DB-pooler check only applies on Vercel). */
  applicable?: () => boolean;
  /** Presence check — booleans only, never the underlying value. May hit the DB (async). */
  detect: () => boolean | Promise<boolean>;
}

/** A check after evaluation — serialisable, value-free; safe to send to the client. */
export interface EvaluatedConfigCheck {
  key: string;
  label: string;
  severity: ConfigHealthSeverity;
  description: string;
  remediation: string;
  docsPath?: string;
  /** Whether the setting is configured. `true` (never flagged) when `applicable` is false. */
  present: boolean;
  /** Whether the check applies in the current environment/platform. */
  applicable: boolean;
}

/** The full report. `summary` counts only APPLICABLE + UNMET checks by severity (+ `ok`). */
export interface ConfigHealthReport {
  environment: 'production' | 'development' | 'test';
  platform: 'vercel' | 'other';
  checks: EvaluatedConfigCheck[];
  summary: { critical: number; warning: number; info: number; ok: number };
}
