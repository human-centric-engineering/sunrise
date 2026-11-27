/**
 * The billing page's path and query, with no imports, so a client component
 * can use them without pulling billing's server code into its bundle
 * (§139 t-1095, t-1096).
 */

/** The org-admin console's billing page, where the provider also sends an owner back to. */
export const ORG_BILLING_PAGE_PATH = '/admin/billing';

/**
 * What the billing page is opened with when the proxy sends a founder there
 * to take up the plan their signup chose (§139 t-1096), and the outcomes it
 * comes back with (`applied`, `dropped`, `failed`).
 */
export const SIGNUP_PLAN_QUERY = { key: 'signup', value: 'plan' } as const;

/** Where the proxy sends an owner whose org has a signup plan waiting. */
export const SIGNUP_PLAN_PAGE = `${ORG_BILLING_PAGE_PATH}?${SIGNUP_PLAN_QUERY.key}=${SIGNUP_PLAN_QUERY.value}`;
