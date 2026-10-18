/**
 * `run`, rejected with "`label` timed out after N ms" if it has not settled
 * within `ms`. The signal it is handed aborts at that moment, and when
 * `cancelled` aborts — at once if it already has. The race ends the wait even
 * if `run` ignores its signal.
 *
 * Used by the webhook dispatcher's email channel (t-808) and the workflow
 * notification step (t-841), which both bound a Resend send.
 */
export async function withTimeout<T>(
  ms: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
  cancelled?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const onCancel = (): void => controller.abort();
  // A listener added to a signal that has already aborted never fires.
  if (cancelled?.aborted) controller.abort();
  else cancelled?.addEventListener('abort', onCancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    cancelled?.removeEventListener('abort', onCancel);
  }
}
