/**
 * Type-safe assertion helpers for tests
 *
 * Purpose: Eliminate "possibly undefined" TypeScript errors by providing
 * reusable type guards that narrow types while providing better error messages
 * than non-null assertions (!).
 *
 * WHY: TypeScript strict mode flags optional property access. Instead of
 * using ! everywhere or disabling strict checks, these helpers provide
 * type-safe assertions with clear error messages.
 */

/**
 * Assert value is defined (non-null, non-undefined)
 * Throws if assertion fails, narrows type if succeeds
 *
 * @param value - Value to check
 * @param message - Optional custom error message
 * @throws Error if value is null or undefined
 *
 * @example
 * ```typescript
 * const user = await getUser();
 * assertDefined(user, 'User not found');
 * // TypeScript now knows user is non-null
 * expect(user.email).toBe('test@example.com');
 * ```
 */
export function assertDefined<T>(value: T, message?: string): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(message ?? 'Expected value to be defined, got null/undefined');
  }
}

/**
 * Assert object has a specific property
 * Narrows type to include property
 *
 * @param obj - Object to check
 * @param property - Property name to check for
 * @param message - Optional custom error message
 * @throws Error if property doesn't exist
 *
 * @example
 * ```typescript
 * const data = JSON.parse(response);
 * assertHasProperty(data, 'user');
 * // TypeScript now knows data.user exists
 * expect(data.user.email).toBe('test@example.com');
 * ```
 */
export function assertHasProperty<T, K extends string>(
  obj: T,
  property: K,
  message?: string
): asserts obj is T & Record<K, unknown> {
  if (!(property in (obj as object))) {
    throw new Error(
      message ?? `Expected object to have property '${property}', but it was missing`
    );
  }
}

/**
 * Assert value is of a specific type
 * Provides runtime type checking with TypeScript type narrowing
 *
 * @param value - Value to check
 * @param typeName - Expected type name
 * @param message - Optional custom error message
 * @throws Error if value is not of expected type
 *
 * @example
 * ```typescript
 * const result = await apiCall();
 * assertType(result, 'object');
 * // TypeScript knows result is an object
 * ```
 */
export function assertType(
  value: unknown,
  typeName: 'string' | 'number' | 'boolean' | 'object' | 'function',
  message?: string
): void {
  const actualType = typeof value;
  if (actualType !== typeName) {
    throw new Error(message ?? `Expected type '${typeName}', but got '${actualType}'`);
  }
}

/**
 * Assert array is not empty
 * Narrows type to non-empty array
 *
 * @param arr - Array to check
 * @param message - Optional custom error message
 * @throws Error if array is empty
 *
 * @example
 * ```typescript
 * const users = await getUsers();
 * assertNonEmptyArray(users);
 * // TypeScript knows users[0] exists
 * expect(users[0].email).toBeDefined();
 * ```
 */
export function assertNonEmptyArray<T>(arr: T[], message?: string): asserts arr is [T, ...T[]] {
  if (arr.length === 0) {
    throw new Error(message ?? 'Expected non-empty array, but got empty array');
  }
}

/**
 * Assert object matches expected structure
 * Useful for validating parsed JSON responses
 *
 * @param obj - Object to check
 * @param properties - Array of required property names
 * @param message - Optional custom error message
 * @throws Error if any property is missing
 *
 * @example
 * ```typescript
 * const data = JSON.parse(responseBody);
 * assertHasProperties(data, ['id', 'email', 'name']);
 * // TypeScript knows data has id, email, and name
 * ```
 */
export function assertHasProperties<T, K extends string>(
  obj: T,
  properties: K[],
  message?: string
): asserts obj is T & Record<K, unknown> {
  const missingProps = properties.filter((prop) => !(prop in (obj as object)));

  if (missingProps.length > 0) {
    throw new Error(
      message ??
        `Expected object to have properties [${properties.join(', ')}], but missing: [${missingProps.join(', ')}]`
    );
  }
}

/**
 * Assert value is a specific instance type
 * Useful for checking Error types
 *
 * @param value - Value to check
 * @param constructor - Expected constructor
 * @param message - Optional custom error message
 * @throws Error if value is not an instance of constructor
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   assertInstanceOf(error, ValidationError);
 *   expect(error.code).toBe('VALIDATION_ERROR');
 * }
 * ```
 */
export function assertInstanceOf<T>(
  value: unknown,
  constructor: new (...args: unknown[]) => T,
  message?: string
): asserts value is T {
  if (!(value instanceof constructor)) {
    throw new Error(
      message ??
        `Expected instance of ${constructor.name}, but got ${value?.constructor.name ?? typeof value}`
    );
  }
}

/**
 * Type-safe JSON parse for test responses
 * Parses response body and returns typed result
 *
 * @param response - Response object to parse
 * @returns Parsed JSON as type T
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/users');
 * const data = await parseJSON<{ users: User[] }>(response);
 * expect(data.users).toHaveLength(3);
 * ```
 */
export async function parseJSON<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Assert response is successful (2xx status code)
 *
 * @param response - Response to check
 * @param message - Optional custom error message
 * @throws Error if response status is not 2xx
 */
export async function assertSuccessResponse(response: Response, message?: string): Promise<void> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      message ?? `Expected successful response (2xx), but got ${response.status}: ${body}`
    );
  }
}

/**
 * Assert response has error status (4xx or 5xx)
 *
 * @param response - Response to check
 * @param expectedStatus - Optional specific status code to expect
 * @param message - Optional custom error message
 * @throws Error if response status is not an error status
 */
export function assertErrorResponse(
  response: Response,
  expectedStatus?: number,
  message?: string
): void {
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(message ?? `Expected status ${expectedStatus}, but got ${response.status}`);
  }

  if (response.ok) {
    throw new Error(message ?? `Expected error response (4xx/5xx), but got ${response.status}`);
  }
}
