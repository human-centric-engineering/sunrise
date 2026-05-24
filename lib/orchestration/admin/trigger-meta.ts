import { z } from 'zod';

const TriggersListMetaSchema = z.object({
  enabledChannels: z.array(z.string()),
});

export function parseEnabledChannelsFromMeta(meta: unknown): string[] {
  const parsed = TriggersListMetaSchema.safeParse(meta);
  return parsed.success ? parsed.data.enabledChannels : [];
}
