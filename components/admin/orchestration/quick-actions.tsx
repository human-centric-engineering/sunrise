/**
 * Quick actions row (Phase 4 Session 4.1)
 *
 * Server component. Four plain `<Link>`s styled as buttons — no JS.
 * The target routes for rows 2-4 don't exist yet in 4.1; they land in
 * later sessions (Agents 4.2, Workflows 4.3, Knowledge 4.5). Clicking
 * today produces a 404 via the parent admin error boundary.
 */

import Link from 'next/link';
import { BookOpen, GitBranch, MessagesSquare, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface QuickAction {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const actions: QuickAction[] = [
  { href: '/admin/orchestration/agents/new', label: 'Create agent', icon: UserPlus },
  { href: '/admin/orchestration/workflows/new', label: 'Create workflow', icon: GitBranch },
  { href: '/admin/orchestration/knowledge', label: 'Upload docs', icon: BookOpen },
  { href: '/admin/orchestration/conversations', label: 'Open chat', icon: MessagesSquare },
];

export function QuickActions() {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map(({ href, label, icon: Icon }) => (
        <Button key={href} asChild variant="outline" size="sm">
          <Link href={href}>
            <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
            {label}
          </Link>
        </Button>
      ))}
    </div>
  );
}
