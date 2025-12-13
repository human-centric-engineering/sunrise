import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/hooks/use-theme'

export const metadata: Metadata = {
  title: 'Sunrise - Next.js Starter',
  description:
    'A production-ready Next.js starter template designed for rapid application development',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
