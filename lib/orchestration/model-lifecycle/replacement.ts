/**
 * Loading a proposed successor for `checkReplacement` (§136 t-1064).
 *
 * Two lookups because two writers name a successor differently: the admin API
 * by catalogue row id, the audit workflow by the vendor's model id (the
 * successor is often one the same audit run has just added, so it has no row
 * id the analysing model could have seen). Both resolve to the same shape.
 *
 * Provider models are global config, so neither read is tenant-scoped.
 */

import { prisma } from '@/lib/db/client';
import type { ReplacementCandidate } from '@/lib/orchestration/model-lifecycle/state';

const CANDIDATE_SELECT = {
  id: true,
  name: true,
  providerSlug: true,
  capabilities: true,
  isActive: true,
  retiresAt: true,
} as const;

/** The catalogue row `id`, as a replacement candidate, or `null` when there is none. */
export function findReplacementById(id: string): Promise<ReplacementCandidate | null> {
  return prisma.aiProviderModel.findUnique({ where: { id }, select: CANDIDATE_SELECT });
}

/** The row for the vendor's `modelId` on `providerSlug`, as a candidate, or `null`. */
export function findReplacementByModelId(
  providerSlug: string,
  modelId: string
): Promise<ReplacementCandidate | null> {
  return prisma.aiProviderModel.findUnique({
    where: { providerSlug_modelId: { providerSlug, modelId } },
    select: CANDIDATE_SELECT,
  });
}
