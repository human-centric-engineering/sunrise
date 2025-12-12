import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Sunrise - Next.js Starter',
  description: 'A production-ready Next.js starter template designed for rapid application development',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
