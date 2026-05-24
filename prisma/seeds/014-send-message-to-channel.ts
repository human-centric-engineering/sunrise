import type { SeedUnit } from '@/prisma/runner';

/**
 * Seed the `send_message_to_channel` capability row.
 *
 * Provider-agnostic capability — the LLM-visible function definition has
 * no vendor names. Per-agent bindings carry the provider-specific config
 * under `customConfig.providers.{twilio,meta,...}`. Recipe at
 * `.context/orchestration/recipes/sms-whatsapp-inbound-reply.md` walks
 * through the binding JSON.
 *
 * Idempotent — re-seeding only refreshes `isSystem: true` and never
 * overwrites admin edits to the function definition.
 */
const unit: SeedUnit = {
  name: '014-send-message-to-channel',
  async run({ prisma, logger }) {
    logger.info('💬 Seeding send_message_to_channel capability...');

    await prisma.aiCapability.upsert({
      where: { slug: 'send_message_to_channel' },
      update: { isSystem: true },
      create: {
        slug: 'send_message_to_channel',
        name: 'Send Message to Channel',
        description:
          'Reply to the end user on whichever channel they originally contacted us on (SMS, WhatsApp, future channels). The platform resolves the right provider and dispatch path automatically; the agent only chooses what to say.',
        category: 'external',
        executionType: 'internal',
        executionHandler: 'SendMessageToChannelCapability',
        functionDefinition: {
          name: 'send_message_to_channel',
          description:
            "Reply to the end-user on whichever channel they originally contacted us on (SMS, WhatsApp, or future channels). The platform automatically routes the message to the correct provider based on the conversation's recorded inbound channel. Use this when the agent needs to send a response back to a user who reached us via a third-party messaging channel.",
          parameters: {
            type: 'object',
            properties: {
              conversationId: {
                type: 'string',
                description:
                  'ID of the AiConversation to reply within. The conversation row carries the channel + provider + recipient address.',
              },
              message: {
                type: 'string',
                description:
                  'Plain-text message body. SMS: max 1600 chars. WhatsApp: max 4096 chars.',
                maxLength: 4096,
              },
              template: {
                type: 'object',
                description:
                  'WhatsApp pre-approved template — required when the 24-hour conversation window has expired. The template must be approved in Meta Business Manager before use.',
                properties: {
                  name: { type: 'string' },
                  languageCode: { type: 'string', description: 'BCP-47, e.g. `en_GB` or `en_US`.' },
                  components: {
                    type: 'array',
                    description:
                      'Optional template components (header / body / button parameter substitutions). See Meta Cloud API docs.',
                  },
                },
                required: ['name', 'languageCode'],
              },
              idempotencyKey: {
                type: 'string',
                description:
                  'Optional explicit dedup key. If omitted, the platform derives one from (conversationId, message, current-minute) so a workflow retry within the same minute does not send the message twice.',
              },
            },
            required: ['conversationId', 'message'],
          },
        },
        rateLimit: 60,
        isActive: true,
        isSystem: true,
      },
    });

    logger.info(
      '✅ Seeded send_message_to_channel capability (no agent bindings — see recipes/sms-whatsapp-inbound-reply.md)'
    );
  },
};

export default unit;
