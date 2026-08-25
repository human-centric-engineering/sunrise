/**
 * Subject-access export smoke script.
 *
 * Proves what mocked unit tests cannot: that every manifest query actually
 * execute against real Postgres. The unit suite mocks Prisma, so it verifies
 * the *arguments* the manifest builds — the right `where`, the right `omit` —
 * but never that the resulting queries run. Type-checking catches a wrong
 * column name; it does not catch `omit` combined with `include` on a relation
 * load, or a `mode: 'insensitive'` filter on a column type that rejects it.
 *
 * Also asserts the property that matters most and is easiest to regress: no
 * credential material reaches the bundle. That check is a recursive sweep over
 * the whole serialised export rather than a per-table assertion, so a new
 * source added without an `omit` is caught here even if nobody thought to test
 * it directly.
 *
 * Read-only against user data: creates a throwaway subject with a conversation
 * and an API key, exports it, and removes what it created. Never touches seed
 * data and never exports a real user. That the subject is brand new is load
 * bearing, not incidental — it is what makes "every declared app section is
 * empty" a leak check rather than a formality.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to invoke
 * anywhere — it only does real work where a DB exists (CI's `validate` job,
 * which provisions Postgres + migrations + seeds, and locally with a running
 * DB). It must NOT be wired into `docker build` / `next build` (no DB there).
 *
 * Run with:
 *   npm run smoke:export
 *   npx tsx --env-file=.env.local scripts/smoke/export.ts
 */

import { CREDENTIAL_ACCOUNT_ISSUER } from '@/lib/auth/constants';
import { prisma } from '@/lib/db/client';
import { exportUserData, SubjectNotFoundError } from '@/lib/privacy/export-user';
import { SUBJECT_DATA_SOURCES } from '@/lib/privacy/export-sources';
import {
  getAppSubjectSources,
  getAppExcludedSubjectSources,
} from '@/lib/privacy/subject-source-registry';
import { isEmptySection } from '@/scripts/smoke/export-assertions';

const PREFIX = 'smoke-test-export';
const stamp = Date.now();

/** Credential values planted on the subject; none may appear in the bundle. */
const SESSION_TOKEN = `${PREFIX}-session-token-${stamp}`;
const PASSWORD_HASH = `${PREFIX}-password-hash-${stamp}`;
const KEY_HASH = `${PREFIX}-key-hash-${stamp}`;
const WEBHOOK_SECRET = `${PREFIX}-webhook-secret-${stamp}`;

/**
 * A third party's identifiers, planted on rows the inbound path attributes to
 * the subject. Neither may appear in the subject's own export.
 */
const THIRD_PARTY_PHONE = `+1555${String(stamp).slice(-7)}`;
const THIRD_PARTY_MESSAGE = `${PREFIX}-third-party-message-${stamp}`;

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

/**
 * Report something the run cannot assess, without failing it.
 *
 * The distinction matters for a fork: a failing `check` means "you have a bug",
 * and this means "this script cannot tell". Conflating them is how a fork ends
 * up with a red pipeline and no fork-owned way to green it — the shape of the
 * issues this whole change exists to fix.
 */
function warn(msg: string): void {
  console.log(`  ! ${msg}`);
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:export skipped — no database reachable (DATABASE_URL unset or DB down).');
    return;
  }

  let subjectUserId: string | null = null;
  let agentId: string | null = null;
  let contactId: string | null = null;
  let workflowId: string | null = null;

  try {
    const email = `${PREFIX}-subject-${stamp}@example.com`;

    // ADMIN so the export also covers an attribution source (a created agent).
    const subject = await prisma.user.create({
      data: { name: `${PREFIX} subject`, email, role: 'ADMIN' },
    });
    subjectUserId = subject.id;

    const agent = await prisma.aiAgent.create({
      data: {
        name: `${PREFIX} agent`,
        slug: `${PREFIX}-agent-${stamp}`,
        description: 'smoke',
        systemInstructions: 'smoke',
        model: '',
        createdBy: subject.id,
      },
    });
    agentId = agent.id;

    const conversation = await prisma.aiConversation.create({
      data: { userId: subject.id, agentId: agent.id, title: 'smoke convo' },
    });
    await prisma.aiMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: 'remember my postcode' },
    });

    // A third party's inbound traffic, written the way the inbound route writes
    // it since #502: system-owned, `userId: null`. It must not appear in this
    // subject's export — nor in anyone's, since no account owns it. Planted
    // against the same agent the subject owns, so a source that reached these
    // messages through the agent relation rather than the user's own would
    // surface here.
    const inboundConversation = await prisma.aiConversation.create({
      data: {
        userId: null,
        agentId: agent.id,
        title: `sms:${THIRD_PARTY_PHONE}`,
        channel: 'sms',
        provider: 'twilio',
        fromAddress: THIRD_PARTY_PHONE,
      },
    });
    await prisma.aiMessage.create({
      data: {
        conversationId: inboundConversation.id,
        role: 'user',
        content: THIRD_PARTY_MESSAGE,
      },
    });

    // Credential-bearing rows — each is a column the manifest must withhold.
    await prisma.session.create({
      data: {
        userId: subject.id,
        token: SESSION_TOKEN,
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: '203.0.113.7',
      },
    });
    await prisma.account.create({
      data: {
        userId: subject.id,
        // better-auth >= 1.7 keys identity on (issuer, accountId); a credential
        // row must carry this issuer and the owning user's id.
        issuer: CREDENTIAL_ACCOUNT_ISSUER,
        accountId: subject.id,
        providerId: 'credential',
        password: PASSWORD_HASH,
      },
    });
    await prisma.aiApiKey.create({
      data: {
        userId: subject.id,
        name: `${PREFIX} key`,
        keyHash: KEY_HASH,
        keyPrefix: 'sk_smoke',
      },
    });
    await prisma.aiWebhookSubscription.create({
      data: {
        createdBy: subject.id,
        channel: 'webhook',
        url: 'https://example.com/hook',
        secret: WEBHOOK_SECRET,
        events: ['workflow_failed'],
      },
    });

    // A first-party run and an inbound-triggered one. Only the first is the
    // subject's; the second carries a third party's message as
    // `inputData.trigger` and is system-owned, exactly as the inbound route
    // writes it.
    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} workflow`,
        slug: `${PREFIX}-workflow-${stamp}`,
        description: 'smoke',
        createdBy: subject.id,
      },
    });
    workflowId = workflow.id;

    await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'completed',
        inputData: { note: 'first-party run' },
        executionTrace: [],
        userId: subject.id,
      },
    });
    await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'completed',
        inputData: { trigger: { from: THIRD_PARTY_PHONE, text: THIRD_PARTY_MESSAGE } },
        executionTrace: [],
        triggerSource: 'inbound:sms',
        userId: null,
      },
    });

    // No FK to User — proves the by-email source resolves against real Postgres,
    // including the case-insensitive match.
    const contact = await prisma.contactSubmission.create({
      data: {
        name: `${PREFIX} contact`,
        email: email.toUpperCase(),
        subject: 'smoke',
        message: 'smoke enquiry',
      },
    });
    contactId = contact.id;

    // ---------------------------------------------------------------------
    console.log('\nexporting…');
    const bundle = await exportUserData({
      userId: subject.id,
      actorUserId: subject.id,
      reason: 'self_service',
    });

    // Every manifest source ran — this is the assertion the mocked suite can't
    // make, since a query that throws against real Postgres never reaches it.
    const sections = [...Object.keys(bundle.personalData), ...Object.keys(bundle.attributions)];
    check(
      sections.length === SUBJECT_DATA_SOURCES.length,
      `all ${SUBJECT_DATA_SOURCES.length} manifest sources ran against real Postgres`
    );

    check(bundle.account.id === subject.id, 'account row is the subject');
    check(bundle.personalData.conversations?.length === 1, 'conversation exported');

    const conversations = bundle.personalData.conversations as { messages: unknown[] }[];
    check(
      conversations[0].messages.length === 1,
      'messages load nested under the conversation (omit + include together)'
    );

    check(
      bundle.personalData.workflowExecutions?.length === 1,
      'first-party workflow run exported, inbound-triggered run excluded'
    );

    check(bundle.personalData.sessions?.length === 1, 'session exported');
    check(bundle.personalData.authProviders?.length === 1, 'linked sign-in method exported');
    check(bundle.personalData.apiKeys?.length === 1, 'API key metadata exported');
    check(
      bundle.personalData.contactSubmissions?.length === 1,
      'contact submission matched by email, case-insensitively'
    );
    check(bundle.attributions.agents?.length === 1, 'created agent exported as attribution');

    const [attributed] = bundle.attributions.agents as { label: string; id: string }[];
    check(
      Object.keys(attributed).sort().join(',') === 'createdAt,id,label',
      'attribution row carries id + label + date only, never the config'
    );

    // The property worth protecting above all others. A recursive sweep over the
    // serialised bundle, so a source added later without an `omit` fails here
    // even if no one wrote a test for it.
    const serialised = JSON.stringify(bundle);
    for (const [name, secret] of [
      ['session token', SESSION_TOKEN],
      ['password hash', PASSWORD_HASH],
      ['API key hash', KEY_HASH],
      ['webhook secret', WEBHOOK_SECRET],
    ] as const) {
      check(!serialised.includes(secret), `${name} is absent from the bundle`);
    }

    // A third party's identifiers must not reach the subject. Same recursive
    // sweep as the credentials above — it covers the whole bundle, including
    // nested messages and `inputData` JSON.
    //
    // Before #502 these rows carried the operator's `userId` and two explicit
    // filters kept them out. Now they carry none, so this pair asserts the
    // upstream fix end-to-end against real Postgres: system-owned rows are
    // unreachable from any subject's export because no subject owns them.
    check(
      !serialised.includes(THIRD_PARTY_PHONE),
      'a third party’s phone number is absent from the bundle'
    );
    check(
      !serialised.includes(THIRD_PARTY_MESSAGE),
      'a third party’s inbound message is absent from the bundle'
    );

    // The subject's own IP is personal data and SHOULD be there — proves the
    // sweep above is withholding credentials, not just emptying the export.
    check(serialised.includes('203.0.113.7'), 'the subject’s own IP address IS exported');
    check(serialised.includes('remember my postcode'), 'message content IS exported');

    // Nothing is withheld at row level any more, so nothing should claim to
    // be. A `scopeNote` surviving here would tell the subject their export was
    // narrowed when it wasn't — the silent-omission failure inverted.
    check(
      bundle.meta.exported.every((entry) => entry.scopeNote === undefined),
      'no exported source claims a narrowing'
    );

    check(
      bundle.meta.exported.length + bundle.meta.attribution.length === sections.length,
      'meta summarises every core source'
    );

    const declaredAppSources = getAppSubjectSources();

    // The app tier's half of the same claim, asserted against the SERIALISED
    // bundle.
    //
    // The in-memory comparison this replaced could not fail: `meta.app` is built
    // by mapping the same `getAppSubjectSources()` the script would have read
    // back, so it compared the registry with itself. What the subject actually
    // receives is JSON, and that is a different artifact — so the row counts are
    // recomputed here from the delivered payload rather than trusting the ones
    // the service wrote.
    //
    // What that catches, precisely: a miscount, a section missing from the
    // delivered JSON, and a value whose serialised form has a different size
    // (a `Date` becomes a string). It does NOT catch a `Map` or a `Set` — both
    // sides compute nought for those — nor `undefined`, which throws
    // `DeclaredAppSourceMissingError` long before here. The `warn` above is
    // what notices those shapes. An earlier version of this comment claimed
    // otherwise, which is the overclaim this branch keeps making.
    const delivered = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    const mismatched: string[] = [];
    for (const summary of delivered.meta.app) {
      const value = delivered.app[summary.section];
      const actualRows = Array.isArray(value) ? value.length : isEmptySection(value) ? 0 : 1;
      if (!Object.hasOwn(delivered.app, summary.section) || actualRows !== summary.rows) {
        mismatched.push(`${summary.section} (meta says ${summary.rows}, bundle has ${actualRows})`);
      }
    }
    check(
      mismatched.length === 0 && delivered.meta.app.length === declaredAppSources.length,
      mismatched.length > 0
        ? `meta.app disagrees with the delivered bundle for ${mismatched.join('; ')} — the ` +
            'subject is told about data that is not there, or given data that is miscounted'
        : delivered.meta.app.length !== declaredAppSources.length
          ? `meta.app describes ${delivered.meta.app.length} section(s) after serialisation, ` +
            `but ${declaredAppSources.length} were declared`
          : declaredAppSources.length === 0
            ? 'no app sources declared (vanilla Sunrise) — nothing to summarise'
            : `all ${declaredAppSources.length} declared app source(s) survive serialisation ` +
              'with row counts matching the delivered payload'
    );
    check(bundle.meta.excluded.length > 0, 'meta discloses the documented exclusions');

    // A fork tier's exclusions are disclosed on the same terms as core's, and
    // this too is checked against the delivered JSON rather than the in-memory
    // bundle — `meta.excluded` is spread from the same registry the script would
    // read back, so comparing the two in memory checks nothing. What is worth
    // proving here is that the reason a tier wrote reaches the subject verbatim.
    const declaredAppExclusions = getAppExcludedSubjectSources();
    const undisclosed = declaredAppExclusions
      .filter(
        (entry) =>
          !delivered.meta.excluded.some(
            (shown) => shown.model === entry.model && shown.reason === entry.reason
          )
      )
      .map((entry) => entry.model);
    check(
      undisclosed.length === 0,
      undisclosed.length > 0
        ? `app exclusion(s) ${undisclosed.join(', ')} were declared but are absent from ` +
            'meta.excluded — the subject is not told the table was withheld, or why'
        : declaredAppExclusions.length === 0
          ? 'no app exclusions declared (vanilla Sunrise) — nothing to disclose'
          : `all ${declaredAppExclusions.length} declared app exclusion(s) disclosed to the subject`
    );

    // FORK NOTE — this asserts your declarations, not their absence.
    //
    // It used to read `Object.keys(bundle.app).length === 0` ("app seam is
    // empty in vanilla Sunrise"), which implementing `collectAppSubjectData`
    // makes false by construction — and this script is not in `validate` or
    // `npm test`, so a fork found out from a red pipeline after a green local
    // run (#530).
    //
    // What replaces it is stronger in both directions. Reaching this line at
    // all proves every declared section arrived: `exportUserData()` throws
    // `DeclaredAppSourceMissingError` otherwise, and that throw has never run
    // against real Postgres until here. And the subject is synthetic — created
    // moments ago, owning nothing of yours — so a declared section with rows in
    // it means the collector matched a *stranger's*, which is the leak this
    // whole script exists to detect and which the old check could not see.
    // Split by shape. A declared section is documented as a row list, so a
    // non-empty ARRAY for a subject who owns nothing is a leak and says so. A
    // non-empty object is off-contract rather than incriminating — a fork
    // returning `{ count: 0, currency: 'GBP' }` is doing something the seam
    // permits and this check cannot reason about, and telling them they had
    // leaked a stranger's rows would be a false accusation.
    const leaked = declaredAppSources
      .filter((source) => {
        const value = bundle.app[source.section];
        return Array.isArray(value) && value.length > 0;
      })
      .map((source) => source.section);
    // Anything that is not an array, empty or not. `exportUserData()` tolerates
    // a non-list section deliberately — it must not break a fork that is
    // otherwise working — but this script is a diagnostic, and the shapes it
    // cannot reason about are exactly the ones that lose data quietly: a `Map`
    // serialises to `{}`, so the bundle stays internally consistent (meta says
    // nought rows, the payload holds nought rows) while the subject's data is
    // gone. Reporting the shape is the only place that gets caught.
    const unrecognised = declaredAppSources
      .filter((source) => !Array.isArray(bundle.app[source.section]))
      .map((source) => source.section);

    // A shape this script cannot assess is NOT a failure. `AppSubjectData` is
    // `Record<string, unknown>`, `countAppRows` handles a single-record object
    // deliberately, and `export-user.test.ts` pins that behaviour — so failing
    // here would hand a fork with a one-record `profile` section a red pipeline
    // and no fork-owned way to green it, which is exactly #530's shape. The
    // previous version of this check did precisely that.
    if (unrecognised.length > 0) {
      warn(
        `app section(s) ${unrecognised.join(', ')} returned something other than a row list, ` +
          'so the leak check cannot assess them. Core accepts that shape; return an array if ' +
          'you want this script to check the section for a stranger’s rows.'
      );
    }

    check(
      leaked.length === 0,
      leaked.length > 0
        ? // `check` prints its message on failure too, so the failing branch has to
          // describe the failure — otherwise a leak reports itself as "assertion
          // failed: all sections are empty", which reads as the opposite.
          `app section(s) ${leaked.join(', ')} returned rows for a subject created ` +
            'seconds ago who owns nothing — the collector is matching rows that are not theirs'
        : declaredAppSources.length === 0
          ? 'no app subject sources declared (vanilla Sunrise) — nothing to check'
          : `${declaredAppSources.length - unrecognised.length} of ` +
            `${declaredAppSources.length} declared app section(s) checked, and empty for a ` +
            'subject who owns none of them'
    );

    // A missing subject is a distinct, catchable failure — not a silent empty bundle.
    let notFound = false;
    try {
      await exportUserData({
        userId: 'smoke-nonexistent-user',
        actorUserId: subject.id,
        reason: 'admin_action',
      });
    } catch (error) {
      notFound = error instanceof SubjectNotFoundError;
    }
    check(notFound, 'a missing subject throws SubjectNotFoundError');

    console.log('\n✓ smoke:export passed');
  } finally {
    // Self-clean by tracked id. Sessions, accounts, conversations, API keys and
    // webhook subscriptions all cascade from the user; the agent, the workflow
    // (and its executions) and the contact submission do not — the workflow is
    // SetNull-retained on the user, so it outlives the delete below.
    if (contactId)
      await prisma.contactSubmission
        .deleteMany({ where: { id: contactId } })
        .catch(() => undefined);
    if (subjectUserId)
      await prisma.user.deleteMany({ where: { id: subjectUserId } }).catch(() => undefined);
    if (workflowId) {
      await prisma.aiWorkflowExecution.deleteMany({ where: { workflowId } }).catch(() => undefined);
      await prisma.aiWorkflow.deleteMany({ where: { id: workflowId } }).catch(() => undefined);
    }
    if (agentId) await prisma.aiAgent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch(async (err) => {
  console.error('\n✗ smoke:export failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
