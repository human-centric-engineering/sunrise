import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  ProviderForm,
  type ProviderRowWithStatus,
} from '@/components/admin/orchestration/provider-form';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';

export const metadata: Metadata = {
  title: 'Edit provider · AI Orchestration',
  description: 'Edit an existing LLM provider configuration.',
};

export default async function EditProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let row;
  try {
    row = await prisma.aiProviderConfig.findUnique({ where: { id } });
  } catch (err) {
    logger.error('edit provider page: provider fetch failed', err, { id });
    row = null;
  }

  if (!row) notFound();

  const provider: ProviderRowWithStatus = {
    ...row,
    apiKeyPresent: isApiKeyEnvVarSet(row.apiKeyEnvVar),
  };

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/providers" className="hover:underline">
          Providers
        </Link>
        {' / '}
        <span>{provider.name}</span>
      </nav>

      <ProviderForm mode="edit" provider={provider} />
    </div>
  );
}
