import { eraseUser } from '@/lib/privacy/erase-user';
import { serviceAccountWhere, humanAdminWhere } from '@/lib/auth/account';
import { AUTH_BOOTSTRAP_ID } from '@/lib/auth/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * One-time reconciliation for databases seeded under Sunrise v0.0.1, which
 * created login-capable `admin@example.com` / `test@example.com` rows (issue
 * #278). This unit makes any existing database converge on "pure Sunrise
 * reality":
 *
 *  1. Erase the two legacy seed-artifact users — but ONLY when they are clearly
 *     artifacts (a `HUMAN` account with NO credential `Account`, i.e. nobody can
 *     actually log in as them). A real person who happens to use one of those
 *     emails (has a credential) is left untouched. Erasure routes through
 *     `eraseUser()` (the sanctioned path: cascade + SetNull + receipt).
 *  2. Re-point orphaned config ownership to the SERVICE config-owner. After the
 *     erase, the legacy users' config has `createdBy = null` (SetNull); on
 *     preview/prod the legacy users were already deleted, so their config is
 *     already null. Re-pointing `null → system owner` adopts all such orphaned
 *     config under the canonical owner. Safe because a null owner means the
 *     config is already unattributed — never a live user's row (live owners are
 *     non-null). Runtime `userId` fields (conversations, executions) are
 *     deliberately NOT touched: null there means "system-owned run".
 *  3. Mark the first-admin bootstrap complete iff a real human admin already
 *     exists, so an established instance can never re-open the bootstrap. On a
 *     human-less database (e.g. the fresh fork) the marker stays unset so the
 *     first real signup still becomes admin.
 *
 * Idempotent and effectively one-shot (its content hash pins it in
 * `SeedHistory`); a no-op on fresh databases where none of these rows exist.
 */
const LEGACY_SEED_EMAILS = ['admin@example.com', 'test@example.com'];

const unit: SeedUnit = {
  name: '019-reconcile-legacy-seed-users',
  async run({ prisma, logger }) {
    const systemOwner = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!systemOwner) {
      logger.warn('No SERVICE config-owner found — skipping legacy reconciliation', {
        hint: 'ensure 001-system-owner runs first',
      });
      return;
    }

    // 1. Erase legacy seed-artifact users (credential-less HUMAN rows only).
    for (const email of LEGACY_SEED_EMAILS) {
      const legacy = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          accountType: true,
          _count: { select: { accounts: true } },
        },
      });

      if (!legacy) continue;
      if (legacy.accountType !== 'HUMAN' || legacy._count.accounts > 0) {
        logger.info('Skipping non-artifact user with legacy seed email', { email });
        continue;
      }

      await eraseUser({
        userId: legacy.id,
        userEmail: legacy.email,
        actorUserId: systemOwner.id,
        reason: 'admin_action',
      });
      logger.info('Erased legacy seed user', { email });
    }

    // 2. Adopt orphaned (null-owned) config under the SERVICE owner. Each entry
    //    re-points one creator/uploader FK; runtime userId fields are excluded.
    const reassign: Array<{ table: string; run: () => Promise<{ count: number }> }> = [
      {
        table: 'aiWorkflow',
        run: () =>
          prisma.aiWorkflow.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiWorkflowVersion',
        run: () =>
          prisma.aiWorkflowVersion.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiWorkflowSchedule',
        run: () =>
          prisma.aiWorkflowSchedule.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiWorkflowTrigger',
        run: () =>
          prisma.aiWorkflowTrigger.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiAgent',
        run: () =>
          prisma.aiAgent.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiAgentProfile',
        run: () =>
          prisma.aiAgentProfile.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiAgentInviteToken',
        run: () =>
          prisma.aiAgentInviteToken.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiAgentVersion',
        run: () =>
          prisma.aiAgentVersion.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiAgentEmbedToken',
        run: () =>
          prisma.aiAgentEmbedToken.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiProviderConfig',
        run: () =>
          prisma.aiProviderConfig.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiProviderModel',
        run: () =>
          prisma.aiProviderModel.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiExperiment',
        run: () =>
          prisma.aiExperiment.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiEventHook',
        run: () =>
          prisma.aiEventHook.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'mcpExposedPrompt',
        run: () =>
          prisma.mcpExposedPrompt.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'mcpApiKey',
        run: () =>
          prisma.mcpApiKey.updateMany({
            where: { createdBy: null },
            data: { createdBy: systemOwner.id },
          }),
      },
      {
        table: 'aiKnowledgeDocument',
        run: () =>
          prisma.aiKnowledgeDocument.updateMany({
            where: { uploadedBy: null },
            data: { uploadedBy: systemOwner.id },
          }),
      },
    ];

    let adopted = 0;
    for (const { table, run } of reassign) {
      const { count } = await run();
      if (count > 0) {
        adopted += count;
        logger.info('Re-pointed orphaned config to SERVICE owner', { table, count });
      }
    }
    logger.info('Config ownership reconciliation complete', { adopted });

    // 3. Close the bootstrap on established instances (a real human admin
    //    already exists). Leave it open on human-less databases.
    const humanAdminCount = await prisma.user.count({ where: humanAdminWhere });
    if (humanAdminCount > 0) {
      await prisma.authBootstrap.upsert({
        where: { id: AUTH_BOOTSTRAP_ID },
        update: {},
        create: { id: AUTH_BOOTSTRAP_ID },
      });
      logger.info('Marked first-admin bootstrap complete (human admin present)');
    }
  },
};

export default unit;
