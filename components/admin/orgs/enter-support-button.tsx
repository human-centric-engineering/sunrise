'use client';

/**
 * Enter as support (§121 t-824)
 *
 * Switches the platform admin's session into an org that has an open support
 * grant, then loads the admin console there. The switch route checks the
 * grant again, as entry does on every request after it. The grant can end
 * between the list loading and the click, or stop admitting because the OWNER
 * who granted it has left. Either way the refusal is shown here and nothing
 * changes.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export function EnterSupportButton({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter() {
    setEntering(true);
    setError(null);
    try {
      await apiClient.post(API.ORGS.SWITCH, { body: { orgId } });
      window.location.assign('/admin');
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not enter the organisation');
      setEntering(false);
    }
  }

  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={() => void enter()}
        disabled={entering}
        aria-label={`Enter ${orgName} as support`}
      >
        {entering ? 'Entering…' : 'Enter as support'}
      </Button>
      {error && <span className="text-destructive text-xs">{error}</span>}
    </div>
  );
}
