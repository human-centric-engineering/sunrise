import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WaitlistLinkAction } from '@/components/waitlist/waitlist-link-action';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Leave the waitlist',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * Waitlist — leave page (§125 t-977). Every waitlist email links here.
 *
 * Shows a button and erases nothing until it is pressed (see
 * `<WaitlistLinkAction>`). Served whatever the waitlist config says: no
 * switch may stop someone leaving the list.
 */
export default async function WaitlistLeavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';

  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <Card className="mx-auto max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold">Leave the waitlist</CardTitle>
          <CardDescription>
            This removes your address and your answers from the {BRAND.name} waitlist. It can&apos;t
            be undone, but you can join again later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WaitlistLinkAction
            action="leave"
            token={token}
            copy={{
              buttonLabel: 'Remove me from the list',
              doneMessage: "You're off the list. We've deleted your entry.",
              failureMessage: "We couldn't remove you. Try the link again later.",
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
