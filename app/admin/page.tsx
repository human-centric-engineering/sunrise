import { redirect } from 'next/navigation';

/**
 * Admin Index Page (Phase 4.4)
 *
 * Redirects to the overview page.
 */
export default function AdminIndexPage() {
  redirect('/admin/overview');
}
