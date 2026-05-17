/**
 * Zod `preprocess` helper for capabilities that consume a human_approval
 * step's output via `argsFrom`.
 *
 * The trace entry's output is a wrapped envelope —
 * `{ approved, notes, actor, approvalPayload }` — so the admin's
 * decision metadata (actor, notes) survives alongside the structured
 * payload that the downstream capability actually wants. Unwrapping
 * here lets each capability keep its existing top-level schema shape
 * (`{ models }`, `{ newModels }`, etc.) while transparently honouring
 * the wrapped envelope.
 *
 * Legacy callers (workflows that build args manually without the
 * approval envelope) still work — the helper is a no-op when there's
 * no `approvalPayload` key.
 */
export function unwrapApprovalPayload(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  const record = v as Record<string, unknown>;
  const payload = record.approvalPayload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return v;
  }
  // Payload keys take precedence over wrapper-level keys (`models`,
  // `newModels`, etc. always come from the admin's selection).
  return { ...record, ...(payload as Record<string, unknown>) };
}
