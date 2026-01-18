import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail, Clock, Github } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ContactForm } from '@/components/forms/contact-form';

export const metadata: Metadata = {
  title: 'Contact - Sunrise',
  description:
    'Get in touch with the Sunrise team. Questions, feedback, or just want to say hello? We would love to hear from you.',
  openGraph: {
    title: 'Contact - Sunrise',
    description:
      'Get in touch with the Sunrise team. Questions, feedback, or just want to say hello? We would love to hear from you.',
  },
};

/**
 * Contact Page
 *
 * Two-column layout with contact form and additional contact information.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default function ContactPage() {
  return (
    <div className="container mx-auto px-4 py-16 md:py-24">
      <div className="mx-auto max-w-5xl">
        {/* Page Header */}
        <div className="mb-12 text-center">
          <h1 className="mb-4 text-4xl font-bold tracking-tight">Get in Touch</h1>
          <p className="text-muted-foreground mx-auto max-w-2xl text-lg">
            Have a question about Sunrise? Want to discuss a custom implementation? Or just want to
            say hello? We&apos;d love to hear from you.
          </p>
        </div>

        {/* Two-column layout */}
        <div className="grid gap-8 lg:grid-cols-5">
          {/* Contact Form - takes 3 columns */}
          <div className="lg:col-span-3">
            <Card>
              <CardHeader>
                <CardTitle>Send a Message</CardTitle>
                <CardDescription>
                  Fill out the form below and we&apos;ll get back to you as soon as possible.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ContactForm />
              </CardContent>
            </Card>
          </div>

          {/* Contact Info - takes 2 columns */}
          <div className="space-y-6 lg:col-span-2">
            {/* Email */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-lg">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Email</CardTitle>
                    <CardDescription>For general inquiries</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <a href="mailto:hello@example.com" className="text-primary hover:underline">
                  hello@example.com
                </a>
              </CardContent>
            </Card>

            {/* Response Time */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-lg">
                    <Clock className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Response Time</CardTitle>
                    <CardDescription>When to expect a reply</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-muted-foreground text-sm">
                  We typically respond within 1-2 business days. For urgent matters, please mention
                  &quot;URGENT&quot; in the subject line.
                </p>
              </CardContent>
            </Card>

            {/* GitHub */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-lg">
                    <Github className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">GitHub</CardTitle>
                    <CardDescription>Issues and discussions</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-muted-foreground mb-2 text-sm">
                  For bug reports and feature requests, open an issue on GitHub.
                </p>
                <a
                  href="https://github.com/human-centric-engineering/sunrise/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary text-sm hover:underline"
                >
                  Open an Issue
                </a>
              </CardContent>
            </Card>

            {/* Support Options */}
            <Card className="border-primary/50 bg-primary/5">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Need Priority Support?</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-muted-foreground mb-3 text-sm">
                  Our Pro Support package includes dedicated email support, priority bug fixes, and
                  architecture review sessions.
                </p>
                <Link href="/#pricing" className="text-primary text-sm font-medium hover:underline">
                  View Support Options
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
