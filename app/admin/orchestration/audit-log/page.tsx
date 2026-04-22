import type { Metadata } from 'next';

import { AuditLogView } from '@/components/admin/orchestration/audit-log/audit-log-view';

export const metadata: Metadata = {
  title: 'Audit Log · AI Orchestration',
  description:
    'Track admin configuration changes across agents, workflows, knowledge, and settings.',
};

export default function AuditLogPage() {
  return <AuditLogView />;
}
