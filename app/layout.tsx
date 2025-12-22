import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/hooks/use-theme';
import { ErrorHandlingProvider } from './error-handling-provider';

export const metadata: Metadata = {
  title: 'Sunrise - Next.js Starter',
  description:
    'A production-ready Next.js starter template designed for rapid application development',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const stored = localStorage.getItem('theme');
                  if (stored === 'light' || stored === 'dark') {
                    document.documentElement.classList.add(stored);
                  } else {
                    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                    const theme = prefersDark ? 'dark' : 'light';
                    document.documentElement.classList.add(theme);
                    localStorage.setItem('theme', theme);
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body>
        <ErrorHandlingProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </ErrorHandlingProvider>
      </body>
    </html>
  );
}
