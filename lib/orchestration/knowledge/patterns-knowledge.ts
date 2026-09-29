/**
 * The platform's patterns knowledge: what an org's copy of it is (§116 t-726).
 *
 * The pattern advisor and the quiz master search one document, "Agentic
 * Design Patterns", built from the committed
 * `prisma/seeds/data/chunks/chunks.json`. A copy belongs to one org. The
 * platform-agent reconcile writes one into an org one of whose agents declares
 * the patterns tag, which in core is the install org alone (t-733), with
 * `materialisePatternsKnowledge` in `seeder.ts`. It is then ordinary knowledge
 * of that org's.
 *
 * Constants only, so the platform-agent registry can fold the document's
 * identity into its digest without loading the chunk file.
 */

export const PATTERNS_DOCUMENT_NAME = 'Agentic Design Patterns';

export const PATTERNS_DOCUMENT_FILE_NAME = 'agentic-design-patterns.md';

/** The managed tag on the document, which the two agents are granted. */
export const PATTERNS_TAG_SLUG = 'agentic-design-patterns';

/**
 * The slug the committed `chunks.json` gives the document:
 * `slugify(name)-<first 8 of the content hash>`, as for any upload.
 *
 * It is part of the platform-agent registry's digest, so a change to it makes
 * the maintenance job reconcile every org once. A test recomputes it from the
 * file: editing `chunks.json` fails that test until this is updated.
 */
export const PATTERNS_DOCUMENT_SLUG = 'agentic-design-patterns-d0eb6ede';
