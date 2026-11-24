/**
 * A fork policy that admits an org's OWNERs to platform routes (t-1032).
 *
 * Since t-1032 a platform admin acting in a customer org is presented as
 * their org role there, so the default policy refuses them on every
 * platform-tier route before the handler runs. The refusals those routes make
 * of their own — "only from the install org" for shared settings, caps,
 * switches and per-org usage — still guard whoever a fork's policy admits
 * from a customer org. This is that fork, for tests that pin those refusals:
 * an org OWNER is admitted at every tier and sees every subject, as a
 * platform admin did; everyone else gets the default answer.
 *
 * Call `__resetAuthorizationPolicyForTests()` (`lib/auth/authorization.ts`)
 * between tests.
 */
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
} from '@/lib/auth/authorization';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

export function registerForkAdmittingOrgOwners(): void {
  registerAuthorizationPolicy({
    ...DEFAULT_AUTHORIZATION_POLICY,
    canAdminister: (viewer, resource, scope) =>
      viewer.orgRole === ORG_OWNER_ROLE
        ? Promise.resolve(true)
        : DEFAULT_AUTHORIZATION_POLICY.canAdminister(viewer, resource, scope),
    subjectScope: (viewer, scope) =>
      viewer.orgRole === ORG_OWNER_ROLE
        ? Promise.resolve({})
        : DEFAULT_AUTHORIZATION_POLICY.subjectScope(viewer, scope),
  });
}
