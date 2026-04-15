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
 * This provider delegates `chat()`, `chatStream()`, `listModels()`, and
 * `testConnection()` to an inner `OpenAiCompatibleProvider` pointing at
 * `https://api.voyageai.com/v1`. The `embed()` method is custom to pass
 * Voyage-specific parameters.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  ProviderError,
  fetchWithTimeout,
  withRetry,
  type LlmProvider,
  type ProviderTestResult,
} from './provider';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type {
  EmbedOptions,
  LlmMessage,
  LlmOptions,
  LlmResponse,
  ModelInfo,
  ProviderConfig,
  StreamChunk,
} from './types';

/** Voyage API base URL. */
const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

/** Default embedding model. */
const DEFAULT_EMBEDDING_MODEL = 'voyage-3';

/**
 * Target dimension for embeddings. Matches the pgvector `vector(1536)`
 * column so vectors can be stored without a schema migration.
 */
const TARGET_DIMENSIONS = 1536;

export class VoyageProvider implements LlmProvider {
  public readonly name: string;
  public readonly isLocal: boolean = false;

  private readonly apiKey: string;
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
    this.embeddingModel = DEFAULT_EMBEDDING_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

    // Delegate chat/stream/models/test to OpenAI-compatible layer
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

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  testConnection(): Promise<ProviderTestResult> {
    return this.inner.testConnection();
  }
}
