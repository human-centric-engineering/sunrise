/**
 * API Request Validation Utilities
 *
 * Reusable validation functions for API routes using Zod schemas.
 * These utilities parse and validate request data, throwing ValidationError
 * for invalid input that can be caught and handled by handleAPIError.
 */

import { z } from 'zod'
import { NextRequest } from 'next/server'
import { ValidationError } from './errors'

/**
 * Validate and parse request JSON body
 *
 * Parses the request body as JSON and validates it against a Zod schema.
 * Throws ValidationError if the body is invalid.
 *
 * @param request - The Next.js request object
 * @param schema - Zod schema to validate against
 * @returns Parsed and validated data
 * @throws ValidationError if validation fails
 *
 * @example
 * ```typescript
 * export async function POST(request: NextRequest) {
 *   try {
 *     const data = await validateRequestBody(request, createUserSchema)
 *     // data is now type-safe based on the schema
 *   } catch (error) {
 *     return handleAPIError(error)
 *   }
 * }
 * ```
 */
export async function validateRequestBody<T>(
  request: NextRequest,
  schema: z.ZodSchema<T>
): Promise<T> {
  try {
    const body = (await request.json()) as unknown
    return schema.parse(body)
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Transform Zod errors into ValidationError
      throw new ValidationError('Invalid request body', {
        errors: error.issues.map((err: z.ZodIssue) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      })
    }

    // JSON parsing error
    throw new ValidationError('Invalid JSON in request body')
  }
}

/**
 * Validate query parameters
 *
 * Validates URL search parameters against a Zod schema.
 * Useful for GET requests with query params.
 *
 * @param searchParams - URLSearchParams from request.nextUrl.searchParams
 * @param schema - Zod schema to validate against
 * @returns Parsed and validated query parameters
 * @throws ValidationError if validation fails
 *
 * @example
 * ```typescript
 * export async function GET(request: NextRequest) {
 *   try {
 *     const { searchParams } = request.nextUrl
 *     const query = validateQueryParams(searchParams, listUsersQuerySchema)
 *     // query is now type-safe
 *   } catch (error) {
 *     return handleAPIError(error)
 *   }
 * }
 * ```
 */
export function validateQueryParams<T>(
  searchParams: URLSearchParams,
  schema: z.ZodSchema<T>
): T {
  try {
    // Convert URLSearchParams to plain object
    const params: Record<string, string> = {}
    searchParams.forEach((value, key) => {
      params[key] = value
    })

    return schema.parse(params)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError('Invalid query parameters', {
        errors: error.issues.map((err: z.ZodIssue) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      })
    }

    throw new ValidationError('Failed to parse query parameters')
  }
}

/**
 * Parse and validate pagination parameters
 *
 * Extracts page and limit from query params, validates them,
 * and calculates skip value for Prisma queries.
 *
 * Defaults: page=1, limit=20, max limit=100
 *
 * @param searchParams - URLSearchParams from request.nextUrl.searchParams
 * @returns Validated pagination params with calculated skip value
 *
 * @example
 * ```typescript
 * export async function GET(request: NextRequest) {
 *   const { searchParams } = request.nextUrl
 *   const { page, limit, skip } = parsePaginationParams(searchParams)
 *
 *   const users = await prisma.user.findMany({
 *     skip,
 *     take: limit
 *   })
 * }
 * ```
 */
export function parsePaginationParams(searchParams: URLSearchParams): {
  page: number
  limit: number
  skip: number
} {
  // Parse page (default: 1, min: 1)
  const pageParam = searchParams.get('page')
  const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1

  // Parse limit (default: 20, min: 1, max: 100)
  const limitParam = searchParams.get('limit')
  const limit = limitParam ? Math.min(100, Math.max(1, parseInt(limitParam, 10))) : 20

  // Calculate skip for Prisma
  const skip = (page - 1) * limit

  // Validate that page and limit are valid numbers
  if (isNaN(page) || isNaN(limit)) {
    throw new ValidationError('Invalid pagination parameters', {
      page: isNaN(page) ? ['Must be a valid number'] : undefined,
      limit: isNaN(limit) ? ['Must be a valid number'] : undefined,
    })
  }

  return { page, limit, skip }
}
