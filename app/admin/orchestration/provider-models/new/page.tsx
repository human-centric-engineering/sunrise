import { redirect } from 'next/navigation';

/**
 * Legacy "New Provider Model" route.
 *
 * Replaced by the Discover models dialog mounted on the matrix list
 * page (Phase F). Operators landing here from a stale link or a
 * cached browser tab get bounced to the new entry point.
 *
 * The free-text form itself is still mounted on
 * /admin/orchestration/provider-models/[id] for editing existing
 * rows — only the create entry point has moved.
 */
export default function NewProviderModelRedirect(): never {
  redirect('/admin/orchestration/providers?tab=models');
}
