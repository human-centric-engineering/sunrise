import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service - Sunrise',
  description: 'Terms of Service for Sunrise. Read our terms and conditions for using the service.',
  openGraph: {
    title: 'Terms of Service - Sunrise',
    description:
      'Terms of Service for Sunrise. Read our terms and conditions for using the service.',
  },
  twitter: {
    card: 'summary',
    title: 'Terms of Service - Sunrise',
    description:
      'Terms of Service for Sunrise. Read our terms and conditions for using the service.',
  },
};

/**
 * Terms of Service Page
 *
 * Placeholder terms of service page.
 * Replace with your actual terms of service content.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default function TermsOfServicePage() {
  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-8 text-4xl font-bold tracking-tight">Terms of Service</h1>

        <div className="prose prose-neutral dark:prose-invert max-w-none">
          <p className="text-muted-foreground lead">Last updated: January 19, 2026</p>

          <section className="mt-8">
            <h2>Agreement to Terms</h2>
            <p>
              This is a placeholder terms of service. Replace this content with your actual terms
              that define the legal agreement between you and your users.
            </p>
          </section>

          <section className="mt-8">
            <h2>Use of Service</h2>
            <p>Define acceptable use of your service:</p>
            <ul>
              <li>Eligibility requirements (age, jurisdiction)</li>
              <li>Account registration and security</li>
              <li>Prohibited activities</li>
              <li>User-generated content policies</li>
            </ul>
          </section>

          <section className="mt-8">
            <h2>Intellectual Property</h2>
            <p>
              Describe ownership of content, trademarks, and intellectual property rights. Include
              information about the MIT license if applicable to your open-source components.
            </p>
          </section>

          <section className="mt-8">
            <h2>Payment Terms</h2>
            <p>If applicable, outline:</p>
            <ul>
              <li>Pricing and billing</li>
              <li>Refund policy</li>
              <li>Subscription terms</li>
              <li>Price changes</li>
            </ul>
          </section>

          <section className="mt-8">
            <h2>Limitation of Liability</h2>
            <p>
              Include standard limitation of liability clauses appropriate for your jurisdiction and
              service type. Consult with a legal professional for proper wording.
            </p>
          </section>

          <section className="mt-8">
            <h2>Termination</h2>
            <p>
              Explain the conditions under which accounts may be terminated and what happens to user
              data upon termination.
            </p>
          </section>

          <section className="mt-8">
            <h2>Changes to Terms</h2>
            <p>
              Describe how users will be notified of changes to these terms and when changes become
              effective.
            </p>
          </section>

          <section className="mt-8">
            <h2>Contact Us</h2>
            <p>
              If you have questions about these Terms of Service, please contact us at{' '}
              <a href="mailto:legal@example.com" className="text-primary hover:underline">
                legal@example.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
