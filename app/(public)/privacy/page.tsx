import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy - Sunrise',
  description: 'Privacy Policy for Sunrise. Learn how we collect, use, and protect your data.',
  openGraph: {
    title: 'Privacy Policy - Sunrise',
    description: 'Privacy Policy for Sunrise. Learn how we collect, use, and protect your data.',
  },
  twitter: {
    card: 'summary',
    title: 'Privacy Policy - Sunrise',
    description: 'Privacy Policy for Sunrise. Learn how we collect, use, and protect your data.',
  },
};

/**
 * Privacy Policy Page
 *
 * Placeholder privacy policy page.
 * Replace with your actual privacy policy content.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default function PrivacyPolicyPage() {
  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-8 text-4xl font-bold tracking-tight">Privacy Policy</h1>

        <div className="prose prose-neutral dark:prose-invert max-w-none">
          <p className="text-muted-foreground lead">Last updated: January 19, 2026</p>

          <section className="mt-8">
            <h2>Introduction</h2>
            <p>
              This is a placeholder privacy policy. Replace this content with your actual privacy
              policy that complies with applicable laws and regulations (GDPR, CCPA, etc.).
            </p>
          </section>

          <section className="mt-8">
            <h2>Information We Collect</h2>
            <p>Describe what personal information you collect, such as:</p>
            <ul>
              <li>Account information (name, email address)</li>
              <li>Usage data and analytics</li>
              <li>Cookies and tracking technologies</li>
              <li>Information from third-party services</li>
            </ul>
          </section>

          <section className="mt-8">
            <h2>How We Use Your Information</h2>
            <p>Explain how you use the collected information:</p>
            <ul>
              <li>Providing and improving our services</li>
              <li>Communicating with you</li>
              <li>Security and fraud prevention</li>
              <li>Legal compliance</li>
            </ul>
          </section>

          <section className="mt-8">
            <h2>Data Sharing and Disclosure</h2>
            <p>
              Describe when and with whom you share user data, including third-party service
              providers, legal requirements, and business transfers.
            </p>
          </section>

          <section className="mt-8">
            <h2>Your Rights</h2>
            <p>Outline the rights users have regarding their data:</p>
            <ul>
              <li>Access and portability</li>
              <li>Correction and deletion</li>
              <li>Opt-out of marketing</li>
              <li>Withdraw consent</li>
            </ul>
          </section>

          <section className="mt-8">
            <h2>Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy, please contact us at{' '}
              <a href="mailto:privacy@example.com" className="text-primary hover:underline">
                privacy@example.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
