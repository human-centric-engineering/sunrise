/**
 * Common Validation Schemas
 *
 * Reusable Zod schemas used across multiple domains to avoid duplication.
 * Import these instead of defining similar patterns multiple times.
 *
 * @example
 * ```ts
 * import { paginationQuerySchema, searchQuerySchema } from '@/lib/validations/common';
 *
 * const listSchema = z.object({
 *   ...paginationQuerySchema.shape,
 *   ...searchQuerySchema.shape,
 * });
 * ```
 */

import { z } from 'zod';

/**
 * Pagination query parameters
 *
 * Standard pagination with page/limit pattern.
 *
 * @example
 * ```ts
 * // GET /api/v1/users?page=2&limit=20
 * const { page, limit } = paginationQuerySchema.parse(searchParams);
 * const skip = (page - 1) * limit;
 * ```
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

/**
 * Sorting query parameters
 *
 * Generic sorting by field name and direction.
 *
 * @example
 * ```ts
 * // GET /api/v1/users?sortBy=createdAt&sortOrder=desc
 * const { sortBy, sortOrder } = sortingQuerySchema.parse(searchParams);
 * ```
 */
export const sortingQuerySchema = z.object({
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Search query parameter
 *
 * Generic search/filter query string.
 *
 * @example
 * ```ts
 * // GET /api/v1/users?q=john
 * const { q } = searchQuerySchema.parse(searchParams);
 * ```
 */
export const searchQuerySchema = z.object({
  q: z.string().trim().optional(),
});

/**
 * CUID validation
 *
 * Validates Collision-resistant Unique Identifiers (default Prisma ID format).
 * Uses Zod 4 syntax (z.cuid() instead of z.string().cuid()).
 *
 * @example
 * ```ts
 * const userId = cuidSchema.parse(params.id);
 * ```
 */
export const cuidSchema = z.cuid('Invalid ID format');

/**
 * UUID validation
 *
 * Validates Universally Unique Identifiers.
 * Uses Zod 4 syntax (z.uuid() instead of z.string().uuid()).
 *
 * @example
 * ```ts
 * const sessionId = uuidSchema.parse(params.id);
 * ```
 */
export const uuidSchema = z.uuid('Invalid UUID format');

/**
 * Non-empty string
 *
 * String that must contain at least one character after trimming.
 *
 * @example
 * ```ts
 * const name = nonEmptyStringSchema.parse(input);
 * ```
 */
export const nonEmptyStringSchema = z.string().trim().min(1, 'This field is required');

/**
 * URL validation
 *
 * Validates proper URL format (http/https).
 * Uses Zod 4 syntax (z.url() instead of z.string().url()).
 *
 * @example
 * ```ts
 * const website = urlSchema.parse(input);
 * ```
 */
export const urlSchema = z.url('Invalid URL format');

/**
 * Slug validation
 *
 * Validates URL-friendly slugs (lowercase alphanumeric with hyphens).
 *
 * @example
 * ```ts
 * const slug = slugSchema.parse('my-blog-post'); // Valid
 * const invalid = slugSchema.parse('My Blog Post'); // Invalid
 * ```
 */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens only');

/**
 * Combined list query schema
 *
 * Convenience schema combining pagination, sorting, and search.
 * Use this for standard list endpoints.
 *
 * @example
 * ```ts
 * const query = listQuerySchema.parse(searchParams);
 * // Returns: { page, limit, sortBy?, sortOrder, q? }
 * ```
 */
export const listQuerySchema = z.object({
  ...paginationQuerySchema.shape,
  ...sortingQuerySchema.shape,
  ...searchQuerySchema.shape,
});

/**
 * Pagination response metadata schema
 *
 * Validates the `meta` field returned by paginated API responses.
 * Use `parsePaginationMeta` for safe runtime extraction instead of `as` casts.
 */
export const paginationMetaSchema = z.object({
  page: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

/**
 * Safely parse an unknown value into PaginationMeta.
 *
 * @returns The validated pagination meta, or `null` if the value doesn't match.
 */
export function parsePaginationMeta(value: unknown): z.infer<typeof paginationMetaSchema> | null {
  const result = paginationMetaSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Type inference helpers
 *
 * Export inferred types for use in other files.
 */
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type SortingQuery = z.infer<typeof sortingQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
