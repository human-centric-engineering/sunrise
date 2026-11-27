/**
 * The HTTP answer for a refused checkout or portal (§139 t-1094), shared by
 * the two routes so a client branches on one set of reasons.
 */

import { errorResponse } from '@/lib/api/responses';
import type { BillingCheckoutError, BillingCheckoutErrorCode } from '@/lib/billing/checkout';

const ANSWER: Record<BillingCheckoutErrorCode, { code: string; status: number }> = {
  BILLING_OFF: { code: 'CONFLICT', status: 409 },
  UNKNOWN_PLAN: { code: 'VALIDATION_ERROR', status: 400 },
  NOT_PURCHASABLE: { code: 'CONFLICT', status: 409 },
  PRICE_MISSING: { code: 'CONFLICT', status: 409 },
  ALREADY_SUBSCRIBED: { code: 'CONFLICT', status: 409 },
  NO_CUSTOMER: { code: 'CONFLICT', status: 409 },
  ORG_NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
};

export function billingErrorResponse(error: BillingCheckoutError): Response {
  const { code, status } = ANSWER[error.code];
  if (error.code === 'UNKNOWN_PLAN') {
    // A VALIDATION_ERROR's details are fields (lib/api/errors.ts).
    return errorResponse(error.message, {
      code,
      status,
      details: { errors: [{ path: 'planKey', message: error.message }] },
    });
  }
  return errorResponse(error.message, {
    code,
    status,
    details: { reason: error.code.toLowerCase() },
  });
}
