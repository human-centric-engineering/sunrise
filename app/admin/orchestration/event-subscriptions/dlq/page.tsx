import { redirect } from 'next/navigation';

/**
 * The dead-letter queue moved from its own route to a tab on the
 * Event Subscriptions page. This redirect preserves any external
 * links (docs, bookmarks, the earlier commit on this branch) so they
 * land on the correct tab.
 */
export default function DlqRedirectPage() {
  redirect('/admin/orchestration/event-subscriptions?tab=dlq');
}
