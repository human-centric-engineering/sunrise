/**
 * React Flow `nodeTypes` map.
 *
 * Exporting a frozen object at module scope (rather than rebuilding it
 * inside the canvas component) is the React Flow recommended pattern —
 * it prevents unnecessary re-renders of the custom node components.
 */

import { PatternNode } from './pattern-node';

export const nodeTypes = {
  pattern: PatternNode,
} as const;
