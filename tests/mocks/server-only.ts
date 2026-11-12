/**
 * Test stub for `server-only`, aliased in `vitest.config.ts`.
 *
 * `import 'server-only'` marks a module that must never reach a client bundle:
 * the Next build fails as soon as a client graph imports it. Vitest has no copy
 * of the package (Next resolves it internally at build time), so without this
 * stub a marked module could not be imported by its own tests, and marking it
 * would cost its tests. The guarantee is the build's, so an empty module here
 * gives nothing away.
 *
 * See `.context/security/overview.md` (production `script-src` never allows
 * eval) for why a module gets marked.
 */

export {};
