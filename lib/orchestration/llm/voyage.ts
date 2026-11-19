/**
 * Voyage AI Provider
 *
 * Embedding-focused provider built by ex-Anthropic researchers.
 * Voyage's API is OpenAI-compatible for chat (if ever needed), but
 * its embeddings endpoint supports extra parameters:
 *
 *   - `input_type`: 'document' | 'query' — improves retrieval quality
 *   - `output_dimension`: truncate to match the pgvector column width
 *
 * This provider delegates `chat()`, `chatStream()` and `listModels()` to an
 * inner `OpenAiCompatibleProvider` pointing at `https://api.voyageai.com/v1`.
 * The `embed()` method is custom to pass Voyage-specific parameters, and
 * `testConnection()` / `testKey()` make one embedding call, since Voyage has
 * no model list.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { z } from 'zod';
import { logger } from '@/lib/logging';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  embeddingTimeoutMs,
  ProviderError,
  fetchWithTimeout,
  KEY_TEST_TIMEOUT_MS,
  withRetry,
  type LlmProvider,
  type ProviderTestResult,
} from '@/lib/orchestration/llm/provider';
import { OpenAiCompatibleProvider } from '@/lib/orchestration/llm/openai-compatible';
import type {
  EmbedManyOptions,
  EmbedManyResult,
  EmbedOptions,
  LlmMessage,
  LlmOptions,
  LlmResponse,
  ModelInfo,
  ProviderConfig,
  StreamChunk,
} from '@/lib/orchestration/llm/types';

/** Voyage API base URL. */
const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

/** How much of a failed key test's response is kept for the log. */
const KEY_TEST_DETAIL_LIMIT = 500;

/**
 * The most of a key test's response that is read: room for one embedding of
 * one word (about 20 KB as JSON at 1,024 dimensions) many times over.
 */
const KEY_TEST_BODY_LIMIT = 256 * 1024;

/** Default embedding model. */
const DEFAULT_EMBEDDING_MODEL = 'voyage-3';

/**
 * Target dimension for embeddings. Matches the pgvector `vector(1536)`
 * column so vectors can be stored without a schema migration.
 */
const TARGET_DIMENSIONS = 1536;

/**
 * The embeddings response, as far as `embedMany` reads it. Validated rather
 * than cast: this is a vendor's body, and a proxy in front of Voyage (a
 * configured `baseUrl`) can return anything.
 */
const voyageEmbeddingsResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  usage: z.object({ total_tokens: z.number().optional() }).optional(),
});

export class VoyageProvider implements LlmProvider {
  public readonly name: string;
  public readonly isLocal: boolean = false;

  private readonly apiKey: string;
  /**
   * Where `embedMany` posts. The row's `baseUrl` when set (a proxy or a
   * regional endpoint), else Voyage's own host. `embed` has always used the
   * fixed host; the knowledge embedder honoured the row, and `embedMany` is
   * what replaced it, so it keeps that behaviour. The provider manager
   * SSRF-checks a configured `baseUrl` before this class is built.
   */
  private readonly embedBaseUrl: string;
  private readonly inner: OpenAiCompatibleProvider;
  private readonly embeddingModel: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) {
      throw new ProviderError('VoyageProvider requires an apiKey', {
        code: 'missing_api_key',
        retriable: false,
      });
    }

    this.name = config.name;
    this.apiKey = config.apiKey;
    this.embedBaseUrl = (config.baseUrl ?? VOYAGE_BASE_URL).replace(/\/+$/, '');
    this.embeddingModel = DEFAULT_EMBEDDING_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

    // Delegate chat/stream/models to OpenAI-compatible layer
    this.inner = new OpenAiCompatibleProvider({
      name: config.name,
      baseUrl: config.baseUrl ?? VOYAGE_BASE_URL,
      apiKey: config.apiKey,
      isLocal: false,
    });
  }

  chat(messages: LlmMessage[], options: LlmOptions): Promise<LlmResponse> {
    return this.inner.chat(messages, options);
  }

  chatStream(messages: LlmMessage[], options: LlmOptions): AsyncIterable<StreamChunk> {
    return this.inner.chatStream(messages, options);
  }

  /**
   * Generate an embedding using the Voyage-specific API.
   *
   * Sends `input_type` and `output_dimension` for optimal retrieval
   * quality and schema compatibility.
   */
  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    const inputType = options?.inputType ?? 'document';

    return withRetry(
      async () => {
        const url = `${VOYAGE_BASE_URL}/embeddings`;

        logger.debug('Voyage embed request', {
          model: this.embeddingModel,
          inputType,
          textLength: text.length,
        });

        const response = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: this.embeddingModel,
              input: text,
              input_type: inputType,
              output_dimension: TARGET_DIMENSIONS,
            }),
          },
          this.timeoutMs
        );

        if (!response.ok) {
          const errorText = await response.text();
          let message = errorText;
          try {
            const parsed = JSON.parse(errorText) as { detail?: string };
            if (parsed.detail) message = parsed.detail;
          } catch {
            // use raw text
          }
          throw new ProviderError(`Voyage embed failed (${response.status}): ${message}`, {
            code: `http_${response.status}`,
            status: response.status,
            retriable: response.status === 429 || response.status >= 500,
          });
        }

        const body = (await response.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        const first = body.data[0];
        if (!first) {
          throw new ProviderError('Voyage embedding response contained no vectors', {
            code: 'empty_response',
            retriable: false,
          });
        }

        return first.embedding;
      },
      {
        maxRetries: this.maxRetries,
        isLocal: false,
        operation: 'voyage.embeddings',
      }
    );
  }

  /**
   * Embed a batch through Voyage's embeddings API (t-740).
   *
   * Always sends `input_type` (default `document`), and `output_dimension`
   * only when the caller passes `dimensions` — the knowledge embedder always
   * does for Voyage, so it sends what it sent before the move. Redirects are
   * refused by `fetchWithTimeout`.
   */
  async embedMany(texts: string[], options: EmbedManyOptions): Promise<EmbedManyResult> {
    const inputType = options.inputType ?? 'document';

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(
          `${this.embedBaseUrl}/embeddings`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: options.model,
              input: texts,
              input_type: inputType,
              // Only when asked, per the embedMany contract: a fixed-width
              // Voyage model can reject it. The knowledge embedder always
              // asks for Voyage, so its requests are unchanged.
              ...(options.dimensions !== undefined ? { output_dimension: options.dimensions } : {}),
            }),
          },
          embeddingTimeoutMs(this.timeoutMs, options.inputType)
        );

        if (!response.ok) {
          const message = voyageErrorDetail(await response.text());
          throw new ProviderError(`Voyage embed failed (${response.status}): ${message}`, {
            code: `http_${response.status}`,
            status: response.status,
            retriable: response.status === 429 || response.status >= 500,
          });
        }

        const parsed = voyageEmbeddingsResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new ProviderError('Voyage embeddings response did not match the expected shape', {
            code: 'invalid_response',
            retriable: false,
          });
        }

        return {
          embeddings: [...parsed.data.data]
            .sort((a, b) => a.index - b.index)
            .map((d) => d.embedding),
          ...(parsed.data.usage?.total_tokens !== undefined
            ? { inputTokens: parsed.data.usage.total_tokens }
            : {}),
        };
      },
      {
        maxRetries: this.maxRetries,
        isLocal: false,
        operation: 'voyage.embeddings.batch',
      }
    );
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  /**
   * The same check as {@link testKey}, for the platform's own provider test
   * (§137 t-1056). Voyage has no model list, so asking for one, as the inner
   * OpenAI-compatible provider would, fails every Voyage row with 404.
   */
  testConnection(): Promise<ProviderTestResult> {
    return this.testKey();
  }

  /**
   * The key alone (§137 t-1056): one embedding of one word, at the row's
   * host. Voyage has no model list (`GET /models` answers 404 to any key),
   * and its embeddings call refuses a wrong key with 401. Billed, a token or
   * two. One attempt: a key test is not retried. Passes only on a 2xx whose
   * body is an embeddings answer, so a proxy that answers anything with 200
   * does not pass a key. The call and the reading of its body are each held
   * to {@link KEY_TEST_TIMEOUT_MS}, and at most {@link KEY_TEST_BODY_LIMIT} of
   * the body is read.
   */
  async testKey(): Promise<ProviderTestResult> {
    try {
      const response = await fetchWithTimeout(
        `${this.embedBaseUrl}/embeddings`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.embeddingModel,
            input: ['ping'],
            input_type: 'query',
          }),
        },
        KEY_TEST_TIMEOUT_MS
      );
      const text = await readKeyTestBody(response, KEY_TEST_BODY_LIMIT, KEY_TEST_TIMEOUT_MS);
      if (response.ok) {
        if (voyageEmbeddingsResponseSchema.safeParse(safeJsonParse(text)).success) {
          return { ok: true, models: [this.embeddingModel] };
        }
        return {
          ok: false,
          models: [],
          error: `Voyage key test got an answer that is not an embeddings response (${response.status})`,
        };
      }
      const reason = voyageErrorDetail(text).slice(0, KEY_TEST_DETAIL_LIMIT);
      return {
        ok: false,
        models: [],
        error: `Voyage key test failed (${response.status})${reason ? `: ${reason}` : ''}`,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, models: [], error };
    }
  }
}

/** Voyage's own reason from an error body: its `detail`, else the body as sent. */
function voyageErrorDetail(text: string): string {
  const parsed = z.object({ detail: z.string() }).safeParse(safeJsonParse(text));
  return parsed.success ? parsed.data.detail : text;
}

/**
 * A key test's response body, read within `ms` and at most `maxBytes`.
 * `fetchWithTimeout` stops timing once the headers arrive, so a host that
 * sends them and then stalls or floods the body would otherwise hold the test
 * open or fill memory. Read through a reader of its own, so that past either
 * limit the body is cancelled, not left streaming; what was read is answered.
 */
async function readKeyTestBody(response: Response, maxBytes: number, ms: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text().catch(() => '');
  const deadline = Date.now() + ms;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  try {
    while (size <= maxBytes) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
      });
      const next = await Promise.race([reader.read(), timedOut]).finally(() => clearTimeout(timer));
      if (next === null) break;
      if (next.done) {
        finished = true;
        break;
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } catch {
    // A failed read answers what was read before it.
  }
  if (!finished) void reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.length) break;
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** `JSON.parse` that answers `undefined` for a non-JSON body instead of throwing. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
