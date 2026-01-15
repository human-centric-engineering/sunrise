import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AppHeader } from '@/components/layouts/app-header';
import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="bg-background min-h-screen">
      <AppHeader logoHref="/" />

      <main className="flex flex-col items-center justify-center px-8 py-16">
        <div className="z-10 w-full max-w-3xl items-center justify-center space-y-6 text-center">
          <h1 className="text-5xl font-bold tracking-tight">Welcome to Sunrise</h1>
          <p className="text-muted-foreground max-w-2xl text-xl">
            A production-ready Next.js starter template designed for rapid application development
            with AI assistance
          </p>

          <div className="flex justify-center gap-4 pt-4">
            <Button asChild>
              <Link href="/dashboard">Dashboard</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/login">Login</Link>
            </Button>
          </div>

          <div className="grid max-w-2xl grid-cols-1 gap-4 pt-8 md:grid-cols-2">
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
      </main>
    </div>
  );
}
