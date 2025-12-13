import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { ThemeToggle } from '@/components/theme-toggle'
import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-8">
      <div className="w-full flex justify-end p-4">
        <ThemeToggle />
      </div>

      <div className="flex flex-col items-center justify-center flex-1">
        <div className="z-10 w-full max-w-3xl items-center justify-center text-center space-y-6">
          <h1 className="text-5xl font-bold tracking-tight">
            Welcome to Sunrise
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl">
            A production-ready Next.js starter template designed for rapid
            application development with AI assistance
          </p>

          <div className="flex justify-center gap-4 pt-4">
            <Button asChild>
              <Link href="/dashboard">Dashboard</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/login">Login</Link>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-8 max-w-2xl">
            <Card>
              <CardHeader>
                <CardTitle>Next.js 16</CardTitle>
                <CardDescription>
                  Built with the latest Next.js App Router and React Server Components
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>TypeScript</CardTitle>
                <CardDescription>
                  Full type safety with strict mode enabled throughout
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </div>
    </main>
  )
}
