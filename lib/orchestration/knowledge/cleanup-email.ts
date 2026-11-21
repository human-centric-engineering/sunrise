import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import { sendEmail } from '@/lib/email/send';
import { CleanupReady } from '@/emails/cleanup-ready';
import { emailLocaleForUser } from '@/lib/email/locale';
import { emailTranslator } from '@/lib/email/translate';
import type { DocumentSizeClass } from '@/lib/orchestration/knowledge/size-report';

interface SendCleanupReadyEmailOpts {
  userId: string;
  documentId: string;
  documentName: string;
  sizeClass: DocumentSizeClass;
  sizeTokens: number;
}

// Confirmation email fired when a cleanup session is created — gives the
// admin a bookmarkable URL back to the cleanup chat if they navigate away
// (close tab, refresh and lose the URL, or just want to come back later).
// Fire-and-forget from the caller via `void`; a failure here does not
// abort the cleanup session itself.
export async function sendCleanupReadyEmail(opts: SendCleanupReadyEmailOpts): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: opts.userId },
      select: { email: true },
    });
    if (!user?.email) return;
    const cleanupUrl = `${env.BETTER_AUTH_URL}/admin/orchestration/knowledge/${opts.documentId}/cleanup`;
    const where = await emailLocaleForUser(opts.userId);
    await sendEmail({
      to: user.email,
      subject: emailTranslator(where, 'emails.cleanupReady')('subject', {
        name: opts.documentName,
      }),
      react: CleanupReady({
        documentName: opts.documentName,
        cleanupUrl,
        sizeClass: opts.sizeClass,
        sizeTokens: opts.sizeTokens,
        ...where,
      }),
    });
  } catch (err) {
    logger.warn('cleanup-ready email failed', { err, documentId: opts.documentId });
  }
}
