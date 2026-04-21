import { redirect } from 'next/navigation';

/**
 * Redirect to the Providers page with the Model Matrix tab.
 * The provider-models list is now a tab within /admin/orchestration/providers.
 * Sub-routes (new, [id]) still work independently.
 */
export default function ProviderModelsRedirect() {
  redirect('/admin/orchestration/providers?tab=models');
}
