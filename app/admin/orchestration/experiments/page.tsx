import { redirect } from 'next/navigation';

/**
 * Experiments now live under the Testing page (evaluations tab).
 * Redirect any direct visits here.
 */
export default function ExperimentsRedirect() {
  redirect('/admin/orchestration/evaluations?tab=experiments');
}
