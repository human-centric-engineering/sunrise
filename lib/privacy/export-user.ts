/**
 * Right-of-access service (GDPR Art. 15) — the other half of `eraseUser()`.
 *
 * Assembles one data subject's record into a single JSON bundle: their account
 * row, every core table that holds their data, the config they authored, any
 * erasure receipts naming them, and whatever the app declares through
 * `lib/app/data-export.ts`.
 *
 * The hard part of an access request is not serialising rows, it is knowing
 * *which* rows — so this service owns none of that decision. It walks
 * {@link SUBJECT_DATA_SOURCES}, the manifest that a build-breaking test holds
 * level with `prisma/schema/*.prisma`. Adding a table here is not a thing you
 * can forget to do; the test fails until the manifest names it.
 *
 * **A partial export is worse than no export.** A bundle that silently dropped
 * one source would still look like a complete answer to the subject receiving
 * it, so nothing here is best-effort: any source that throws fails the whole
 * export. That is the opposite of the erasure path, where hook failures are
 * swallowed so app trouble can never block a deletion — the asymmetry is
 * deliberate, and it follows from which failure the subject can detect.
 *
 * @see lib/privacy/export-sources.ts — the manifest and its coverage guard
 * @see lib/privacy/subject-source-registry.ts — where a fork tier declares its
 *      own sources and exclusions; both reach the subject through `meta`
 * @see lib/privacy/erase-user.ts — the Art. 17 counterpart
 * @see .context/privacy/data-export.md — the guide
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isMultiTenant, runAsSystem } from '@/lib/tenancy/context';
import { collectAppSubjectData, type AppSubjectData } from '@/lib/app/data-export';
import {
  SUBJECT_DATA_SOURCES,
  EXCLUDED_SOURCES,
  type ExcludedSource,
  type SourceDisposition,
  type SubjectQuery,
} from '@/lib/privacy/export-sources';
import {
  getAppSubjectSources,
  getAppExcludedSubjectSources,
  appSubjectDeclarationsFailed,
} from '@/lib/privacy/subject-source-registry';

/**
 * Bundle format version. Bump on any breaking change to the shape below — a
 * fork's downstream tooling reads this to know what it is parsing.
 */
export const EXPORT_FORMAT_VERSION = 1;

export type ExportReason = 'self_service' | 'admin_action';

export interface ExportUserParams {
  /** Id of the data subject to export. */
  userId: string;
  /** Who asked (the subject themselves, or an admin acting on a request). */
  actorUserId: string;
  reason: ExportReason;
}

/** What one source contributed, echoed back so the subject can audit the scope. */
export interface ExportedSourceSummary {
  model: string;
  section: string;
  description: string;
  /** Present when the source returns only some of the subject's matching rows, and why. */
  scopeNote?: string;
  rows: number;
}

/**
 * What one app-tier source contributed. The core equivalent for tables declared
 * through `registerAppSubjectSources()`.
 *
 * Kept in its own list rather than folded into {@link SubjectExportMeta.exported}
 * because the two are read differently: an `exported` entry's `section` is a key
 * of `personalData`, an `attribution` entry's is a key of `attributions`, and
 * these are keys of `app`. Folding them together would leave a reader looking up
 * a section in the wrong object.
 */
export interface AppSourceSummary {
  model: string;
  /** Key this source occupies under the bundle's `app`. */
  section: string;
  disposition: SourceDisposition;
  description: string;
  rows: number;
}

export interface SubjectExportMeta {
  formatVersion: number;
  generatedAt: string;
  subjectUserId: string;
  /** Core sources returned in full, with row counts. Sections of `personalData`. */
  exported: ExportedSourceSummary[];
  /** Core sources returned as id + label + date only. Sections of `attributions`. */
  attribution: ExportedSourceSummary[];
  /** Tables deliberately left out, with the reason — core's and the app tier's. */
  excluded: ExcludedSource[];
  /**
   * App-tier sources a fork declared, with row counts. Sections of `app`.
   * Empty in vanilla Sunrise, where nothing is declared.
   */
  app: AppSourceSummary[];
}

export interface SubjectExport {
  meta: SubjectExportMeta;
  /** The subject's account record. */
  account: Record<string, unknown>;
  /** The subject's own data, keyed by section. */
  personalData: Record<string, unknown[]>;
  /** Config the subject created — identity of each thing, not its contents. */
  attributions: Record<string, unknown[]>;
  /** Erasure receipts naming this subject. Normally empty for a live account. */
  erasureReceipts: unknown[];
  /** App-owned data, from the `lib/app/data-export.ts` seam. Empty in vanilla Sunrise. */
  app: AppSubjectData;
}

/** Raised when the subject has no account row. */
export class SubjectNotFoundError extends Error {
  constructor(userId: string) {
    super(`No user with id ${userId}`);
    this.name = 'SubjectNotFoundError';
  }
}

/**
 * Raised when a tier's `initAppSubjectSources()` threw, so what its tables hold
 * is unknown.
 *
 * The collector is a separate static import and keeps working, so continuing
 * would hand the subject app rows that `meta.app` describes none of, with the
 * tier's exclusions missing from `meta.excluded` — a bundle contradicting its
 * own manifest. Refusing is the same call the module makes everywhere else: a
 * partial export is worse than no export, because only this failure is visible.
 */
export class AppSubjectDeclarationsUnavailableError extends Error {
  constructor() {
    super(
      'initAppSubjectSources() threw, so this app tier’s subject-data declarations ' +
        'are unknown and the export cannot be certified complete. Fix the seam in ' +
        'lib/app/data-export.ts — the failure was logged by ' +
        'lib/privacy/subject-source-registry.ts.'
    );
    this.name = 'AppSubjectDeclarationsUnavailableError';
  }
}

/**
 * Raised when a tier declared a subject source whose section the collector did
 * not produce — the app half of "a partial export is worse than no export".
 *
 * This throws rather than logging because the two parties who could notice
 * cannot: the subject has no way to tell a missing section from a table they
 * have no rows in, and the operator sending the bundle has no way either. The
 * declaration in `initAppSubjectSources()` is the only statement of what the
 * answer should contain, so a bundle that contradicts it is not an answer.
 *
 * Fix it in the collector, not by deleting the declaration: return the key with
 * an empty array when the subject owns nothing.
 */
export class DeclaredAppSourceMissingError extends Error {
  /** Sections that were declared but absent from `collectAppSubjectData()`. */
  readonly sections: string[];

  constructor(sections: string[]) {
    super(
      `collectAppSubjectData() did not return declared section(s): ${sections.join(', ')}. ` +
        'Every source registered through registerAppSubjectSources() must produce its ' +
        'section — return an empty array when the subject has no rows, rather than ' +
        'omitting the key. See lib/app/data-export.ts.'
    );
    this.name = 'DeclaredAppSourceMissingError';
    this.sections = sections;
  }
}

/**
 * Row count for one app section.
 *
 * The documented shape for a declared section is a row list, and that is what a
 * count means. Anything else is one record or none — deliberately not a number
 * invented to fill the field, since the count is shown to the subject as the
 * size of what they received.
 */
function countAppRows(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'object') return Object.keys(value).length === 0 ? 0 : 1;
  return 1;
}

/** One manifest source and the rows it returned for the subject. */
interface SourceResult {
  source: (typeof SUBJECT_DATA_SOURCES)[number];
  rows: unknown[];
}

/**
 * Build one data subject's export bundle.
 *
 * Every source runs against the live database — there is no caching and no
 * partial result. Volume is unbounded by design: a subject with a long
 * conversation history gets all of it, because truncating an access response
 * without saying so is the failure this whole path exists to avoid. Callers
 * that need to bound the response should stream or paginate at the transport,
 * not drop rows here.
 *
 * @throws {SubjectNotFoundError} if no user row matches `userId`
 */
export async function exportUserData(params: ExportUserParams): Promise<SubjectExport> {
  const { userId, actorUserId, reason } = params;

  const account = await prisma.user.findUnique({ where: { id: userId } });
  if (!account) {
    throw new SubjectNotFoundError(userId);
  }

  const subject: SubjectQuery = { userId, email: account.email };

  // Run every source, then split by disposition. A rejection here propagates:
  // an export that quietly lost a section would be indistinguishable, to the
  // person reading it, from one that had nothing to show.
  //
  // At `multi`, read across every org, as the audited system scope (§107
  // t-748). A person can belong to several orgs, and leave some, so their
  // data has no one org to enter. The self-service and admin routes run
  // inside the session's active org, and the `org_isolation` policy ANDed
  // every read below with it, so the bundle silently held that org's
  // conversations, memories and executions and no other's; an admin API key
  // enters no org, and the reads threw. The bypass is safe here because every
  // `fetch` in `export-sources.ts` filters on the subject (`userId`,
  // `createdBy`, `uploadedBy`, `actorId`, the account's email), so it widens
  // the answer to the person's rows in every org, not to anyone else's. The
  // app collector runs inside the same scope, for the same reason.
  //
  // One source at a time there, as the org export reads (t-735): each read
  // is its own transaction holding a pooled connection, and starting every
  // source at once can exhaust the pool. At `single` there is one org and no
  // policy, so nothing is entered and the sources still run together — a
  // collector or helper reading the implicit install org keeps working.
  const { results, app } = isMultiTenant()
    ? await runAsSystem('subject data export: one person’s rows in every org', async () => {
        const fetched: SourceResult[] = [];
        for (const source of SUBJECT_DATA_SOURCES) {
          fetched.push({ source, rows: await source.fetch(subject) });
        }
        return { results: fetched, app: await collectAppSubjectData(subject) };
      })
    : {
        results: await Promise.all(
          SUBJECT_DATA_SOURCES.map(async (source) => ({
            source,
            rows: await source.fetch(subject),
          }))
        ),
        app: await collectAppSubjectData(subject),
      };

  const personalData: Record<string, unknown[]> = {};
  const attributions: Record<string, unknown[]> = {};
  const exported: ExportedSourceSummary[] = [];
  const attribution: ExportedSourceSummary[] = [];

  for (const { source, rows } of results) {
    const summary: ExportedSourceSummary = {
      model: source.model,
      section: source.section,
      description: source.description,
      // Only present on narrowed sources — a row count with no note means the
      // subject received every row that matched them.
      ...(source.scopeNote ? { scopeNote: source.scopeNote } : {}),
      rows: rows.length,
    };

    if (source.disposition === 'export') {
      personalData[source.section] = rows;
      exported.push(summary);
    } else {
      attributions[source.section] = rows;
      attribution.push(summary);
    }
  }

  // Receipts are keyed by `subjectUserId` with no FK, so they survive the user
  // row. A live subject normally has none; one appears only if an id was
  // reused, which is worth showing rather than hiding.
  const erasureReceipts = await prisma.dataErasureReceipt.findMany({
    where: { subjectUserId: userId },
    orderBy: { erasedAt: 'asc' },
  });

  // Hold the collector to what the tier declared. Extra sections are fine — a
  // fork may export a derived view that is not a table — but a declared one
  // that never arrived is a short answer wearing the shape of a complete one.
  //
  // Compared against `undefined` rather than tested with `Object.hasOwn`: the
  // promise is about the bundle the subject *receives*, and `JSON.stringify`
  // drops a key whose value is `undefined`. `{ invoices: undefined }` owns the
  // key and serialises to `{}`, so a `hasOwn` check passes while the delivered
  // export is short exactly the section it just certified. `null` is left
  // alone — it survives serialisation, so the section is disclosed.
  // Refuse before reading the declarations, not after: if the init threw they
  // are empty, and every check below would pass vacuously on a bundle nobody
  // can certify.
  if (appSubjectDeclarationsFailed()) {
    throw new AppSubjectDeclarationsUnavailableError();
  }

  const declaredAppSources = getAppSubjectSources();
  const undelivered = declaredAppSources
    .filter(
      // `Object.hasOwn` first: a bare `[section] === undefined` reads the
      // prototype chain, so a section declared as `constructor` or `toString`
      // slips through as "delivered" and `countAppRows` then reports a
      // fabricated count for a key the JSON does not contain. The `undefined`
      // test still runs after it, because an own key holding `undefined` is
      // dropped by `JSON.stringify` and is equally undelivered.
      (source) => !Object.hasOwn(app, source.section) || app[source.section] === undefined
    )
    .map((source) => source.section);
  if (undelivered.length > 0) {
    throw new DeclaredAppSourceMissingError(undelivered);
  }

  const totalRows =
    results.reduce((sum, { rows }) => sum + rows.length, 0) + erasureReceipts.length;

  logger.info('Subject data export generated', {
    userId,
    actorUserId,
    reason,
    sources: results.length,
    totalRows,
    appSections: Object.keys(app).length,
  });

  // Summarise the app tier on the same terms as core. Without this the subject
  // receives sections under `app` that the bundle's own manifest never mentions
  // — no description of what a section is, no row count — while `meta` reads as
  // a complete summary and names the tables that were *withheld*. The
  // `description` each tier is required to write has nowhere else to go.
  const appSummaries: AppSourceSummary[] = declaredAppSources.map((source) => ({
    model: source.model,
    section: source.section,
    disposition: source.disposition,
    description: source.description,
    rows: countAppRows(app[source.section]),
  }));

  return {
    meta: {
      formatVersion: EXPORT_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      subjectUserId: userId,
      exported,
      attribution,
      app: appSummaries,
      // Core's exclusions AND the fork tier's. A table withheld from an export
      // is disclosed with its reason so the subject can see the boundary of
      // what they received rather than having to infer it — and that has to
      // hold for a fork's tables too, or a fork install's bundle states the
      // boundary for core's half and stays silent about the other. The
      // exclusion path is otherwise the only accounting option with nothing
      // holding it to anything after the build.
      excluded: [...EXCLUDED_SOURCES, ...getAppExcludedSubjectSources()],
    },
    account,
    personalData,
    attributions,
    erasureReceipts,
    app,
  };
}
