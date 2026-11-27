/**
 * The billing page's path and query, with no imports, so a client component
 * can use them without pulling billing's server code into its bundle
 * (§139 t-1095, t-1096).
 */

/** The org-admin console's billing page, where the provider also sends an owner back to. */
export const ORG_BILLING_PAGE_PATH = '/admin/billing';

/**
 * What the billing page is opened with when a signup goes on to start the
 * paid plan it chose (§139 t-1096), and the outcomes it comes back with
 * (`applied`, `dropped`, `failed`).
 */
export const SIGNUP_PLAN_QUERY = { key: 'signup', value: 'plan' } as const;

/**
 * Where a signup that chose a paid plan goes on to once the person is signed
 * in: the page that starts its checkout.
 */
export const SIGNUP_PLAN_PAGE = `${ORG_BILLING_PAGE_PATH}?${SIGNUP_PLAN_QUERY.key}=${SIGNUP_PLAN_QUERY.value}`;

/**
 * The verification callback's query parameter naming where the signup goes
 * on to (`/verify-email/callback?next=…`).
 */
export const SIGNUP_NEXT_PARAM = 'next';

/**
 * Where a signup may go on to from the verification callback, from its
 * `next` parameter: {@link SIGNUP_PLAN_PAGE} only, so the link cannot be
 * turned into a redirect to anywhere else. `null` for the landing route.
 */
export function signupNextOf(next: string | null): string | null {
  return next === SIGNUP_PLAN_PAGE ? SIGNUP_PLAN_PAGE : null;
}
