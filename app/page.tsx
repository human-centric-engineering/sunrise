export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 w-full max-w-5xl items-center justify-center font-mono text-sm">
        <h1 className="text-4xl font-bold text-center mb-4">
          Welcome to Sunrise
        </h1>
        <p className="text-center text-lg mb-8">
          A production-ready Next.js starter template
        </p>
        <div className="flex justify-center gap-4">
          <a
            href="/dashboard"
            className="rounded-lg border border-transparent px-5 py-3 transition-colors hover:border-gray-300 hover:bg-gray-100 hover:dark:border-neutral-700 hover:dark:bg-neutral-800/30"
          >
            Dashboard
          </a>
          <a
            href="/login"
            className="rounded-lg border border-transparent px-5 py-3 transition-colors hover:border-gray-300 hover:bg-gray-100 hover:dark:border-neutral-700 hover:dark:bg-neutral-800/30"
          >
            Login
          </a>
        </div>
      </div>
    </main>
  )
}
