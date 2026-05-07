/**
 * Inbound triggers — vendor-neutral primitive for receiving requests from
 * third-party systems and starting workflow executions.
 *
 * See `.context/orchestration/inbound-triggers.md` for the full guide.
 */

export type {
  InboundAdapter,
  NormalisedTriggerPayload,
  VerifyContext,
  VerifyFailureReason,
  VerifyResult,
} from '@/lib/orchestration/inbound/types';

export {
  getInboundAdapter,
  listInboundChannels,
  registerInboundAdapter,
  resetInboundAdapters,
} from '@/lib/orchestration/inbound/registry';

export { GenericHmacAdapter } from '@/lib/orchestration/inbound/adapters/generic-hmac';
export { PostmarkAdapter } from '@/lib/orchestration/inbound/adapters/postmark';
export { SlackAdapter } from '@/lib/orchestration/inbound/adapters/slack';

export {
  bootstrapInboundAdapters,
  resetBootstrapState,
} from '@/lib/orchestration/inbound/bootstrap';
