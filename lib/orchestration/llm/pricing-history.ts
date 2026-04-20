/**
 * Pricing History — fetches and caches historical LLM pricing data.
 *
 * Primary source: llm-prices.com/historical-v1.json (Simon Willison)
 * — free, no auth, Cloudflare Pages hosted, ~129 entries across 14 vendors.
 *
 * Each entry has `from_date` / `to_date` fields showing when a price was
 * valid. When a provider changes pricing, a new entry is added with the
 * old entry's `to_date` set. We parse this into per-model timelines.
 *
 * Fallback: if the fetch fails, we return an empty result so the UI
 * degrades gracefully (shows "no history available" rather than crashing).
 *
 * Cache: 24-hour in-memory TTL, matching the model registry refresh cadence.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';

const SOURCE_URL = 'https://www.llm-prices.com/historical-v1.json';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single pricing period for a model from llm-prices.com */
export interface PricingHistoryEntry {
  id: string;
  vendor: string;
  name: string;
  /** Cost per 1M input tokens (USD) */
  input: number;
  /** Cost per 1M output tokens (USD) */
  output: number;
  /** Cost per 1M cached input tokens (USD), null if not applicable */
  inputCached: number | null;
  /** ISO date when this price took effect (inclusive) */
  fromDate: string;
  /** ISO date when this price ended (exclusive), null if current */
  toDate: string | null;
}

/** Timeline for a single model — sorted array of pricing periods */
export interface ModelPricingTimeline {
  id: string;
  vendor: string;
  name: string;
  /** Pricing periods sorted by fromDate ascending */
  periods: Array<{
    input: number;
    output: number;
    inputCached: number | null;
    fromDate: string;
    toDate: string | null;
  }>;
}

/** The full pricing history dataset */
export interface PricingHistoryData {
  /** All entries keyed by model id */
  timelines: Map<string, ModelPricingTimeline>;
  /** When this data was fetched */
  fetchedAt: number;
  /** Whether the data came from the live source or is empty (fallback) */
  source: 'live' | 'fallback';
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheState {
  data: PricingHistoryData;
  fetchedAt: number;
}

let cache: CacheState | null = null;
let inflightFetch: Promise<PricingHistoryData> | null = null;

// ---------------------------------------------------------------------------
// Raw response shape from llm-prices.com
// ---------------------------------------------------------------------------

interface RawEntry {
  id: string;
  vendor: string;
  name: string;
  input: number;
  output: number;
  input_cached?: number | null;
  from_date: string;
  to_date: string | null;
}

interface RawResponse {
  prices: RawEntry[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseResponse(raw: RawResponse): Map<string, ModelPricingTimeline> {
  const timelines = new Map<string, ModelPricingTimeline>();

  for (const entry of raw.prices) {
    if (!entry.id || typeof entry.input !== 'number') continue;

    // Key by vendor+id to avoid collisions across providers
    const key = `${entry.vendor}/${entry.id}`;
    let timeline = timelines.get(key);
    if (!timeline) {
      timeline = {
        id: entry.id,
        vendor: entry.vendor,
        name: entry.name,
        periods: [],
      };
      timelines.set(key, timeline);
    }

    timeline.periods.push({
      input: entry.input,
      output: entry.output,
      inputCached: entry.input_cached ?? null,
      fromDate: entry.from_date,
      toDate: entry.to_date,
    });
  }

  // Sort periods ascending by fromDate
  for (const timeline of timelines.values()) {
    timeline.periods.sort((a, b) => a.fromDate.localeCompare(b.fromDate));
  }

  return timelines;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function emptyData(): PricingHistoryData {
  return { timelines: new Map(), fetchedAt: 0, source: 'fallback' };
}

async function fetchPricingHistory(): Promise<PricingHistoryData> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(SOURCE_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn('Pricing history fetch failed', { status: response.status });
      return emptyData();
    }

    const raw: unknown = await response.json();

    // Basic shape validation
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('prices' in raw) ||
      !Array.isArray((raw as RawResponse).prices)
    ) {
      logger.warn('Pricing history: unexpected response shape');
      return emptyData();
    }

    const timelines = parseResponse(raw as RawResponse);
    const data: PricingHistoryData = {
      timelines,
      fetchedAt: Date.now(),
      source: 'live',
    };

    logger.info('Pricing history loaded', {
      modelCount: timelines.size,
      entryCount: (raw as RawResponse).prices.length,
    });

    return data;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn('Pricing history fetch timed out');
    } else {
      logger.warn('Pricing history fetch error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return emptyData();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the pricing history data. Returns cached data if fresh (< 24h),
 * otherwise fetches from llm-prices.com. Never throws — returns empty
 * data on failure so the UI can degrade gracefully.
 *
 * Deduplicates concurrent callers via `inflightFetch`.
 */
export async function getPricingHistory(options?: {
  force?: boolean;
}): Promise<PricingHistoryData> {
  const now = Date.now();

  // Return cached if fresh
  if (!options?.force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  // Deduplicate concurrent fetches
  if (inflightFetch) return inflightFetch;

  inflightFetch = (async () => {
    const data = await fetchPricingHistory();
    cache = { data, fetchedAt: Date.now() };
    inflightFetch = null;
    return data;
  })();

  return inflightFetch;
}

/**
 * Look up the pricing timeline for a specific model.
 *
 * Matching strategy (in order of preference):
 * 1. Exact vendor/id key
 * 2. Exact id match (any vendor)
 * 3. Normalized match (strip punctuation)
 * 4. Family match — find the closest ancestor in the same model family
 *    e.g. `claude-opus-4-6` → `claude-opus-4-5` → `claude-opus-4`
 *
 * Returns null if no history is available for this model.
 */
export function getModelTimeline(
  data: PricingHistoryData,
  modelId: string,
  vendor?: string
): ModelPricingTimeline | null {
  // 1. Try exact vendor/id key
  if (vendor) {
    const exact = data.timelines.get(`${vendor}/${modelId}`);
    if (exact) return exact;
  }

  // 2. Try id-only match (iterate — small dataset so this is fine)
  for (const timeline of data.timelines.values()) {
    if (timeline.id === modelId) return timeline;
  }

  // 3. Try normalized match (e.g. "claude-opus-4-6" matching "claude-opus-4-6")
  const normalized = modelId.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const timeline of data.timelines.values()) {
    const timelineNorm = timeline.id.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (timelineNorm === normalized) return timelineNorm ? timeline : null;
  }

  // 4. Family match — find closest ancestor by progressively trimming
  //    version segments. e.g. "claude-opus-4-6" tries:
  //    "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4", "claude-opus"
  //    Also handles dot versions: "claude-sonnet-4.6" → "claude-sonnet-4.5"
  const candidates: ModelPricingTimeline[] = [];
  const vendorFilter = vendor?.toLowerCase();

  for (const timeline of data.timelines.values()) {
    if (vendorFilter && timeline.vendor.toLowerCase() !== vendorFilter) continue;

    // Check if model IDs share a common family prefix
    const modelBase = extractFamilyBase(modelId);
    const timelineBase = extractFamilyBase(timeline.id);
    if (modelBase && timelineBase && modelBase === timelineBase) {
      candidates.push(timeline);
    }
  }

  if (candidates.length > 0) {
    // Sort by most recent fromDate (prefer newest version's history)
    candidates.sort((a, b) => {
      const aLast = a.periods[a.periods.length - 1]?.fromDate ?? '';
      const bLast = b.periods[b.periods.length - 1]?.fromDate ?? '';
      return bLast.localeCompare(aLast);
    });
    return candidates[0];
  }

  return null;
}

/**
 * Extract the "family base" from a model ID for fuzzy matching.
 *
 * Strategy: extract known model family names (claude-opus, claude-sonnet,
 * claude-haiku, gpt-4o, gpt-4o-mini, etc.) by removing pure-numeric
 * version segments while preserving alphanumeric ones like "4o".
 *
 * Examples:
 *   "claude-opus-4-6" → "claude-opus"
 *   "claude-3-opus" → "claude-opus"
 *   "claude-3.5-sonnet" → "claude-sonnet"
 *   "claude-sonnet-4.5" → "claude-sonnet"
 *   "gpt-4o" → "gpt-4o" (4o is not purely numeric)
 *   "gpt-4o-mini" → "gpt-4o-mini"
 *   "gpt-4.1" → "gpt"
 */
function extractFamilyBase(id: string): string | null {
  // Split on hyphens, filter out segments that are purely numeric
  // or match version patterns like "3.5", "4.6", "4"
  const segments = id.split('-');
  const nonVersion = segments.filter((seg) => {
    // Pure number: "3", "4", "5", "6"
    if (/^\d+$/.test(seg)) return false;
    // Version with dot: "3.5", "4.6", "4.1"
    if (/^\d+\.\d+$/.test(seg)) return false;
    return true;
  });

  const result = nonVersion.join('-').toLowerCase();
  return result.length > 2 ? result : null;
}

/**
 * Serialise the pricing history data for passing from server to client.
 * Converts the Map to a plain array since Maps don't survive JSON serialisation.
 */
export function serialisePricingHistory(data: PricingHistoryData): SerializedPricingHistory {
  return {
    timelines: Array.from(data.timelines.values()),
    fetchedAt: data.fetchedAt,
    source: data.source,
  };
}

/**
 * Deserialise the pricing history data on the client side.
 */
export function deserialisePricingHistory(
  serialized: SerializedPricingHistory
): PricingHistoryData {
  const timelines = new Map<string, ModelPricingTimeline>();
  for (const t of serialized.timelines) {
    timelines.set(`${t.vendor}/${t.id}`, t);
  }
  return {
    timelines,
    fetchedAt: serialized.fetchedAt,
    source: serialized.source,
  };
}

/** JSON-safe shape for server→client transfer */
export interface SerializedPricingHistory {
  timelines: ModelPricingTimeline[];
  fetchedAt: number;
  source: 'live' | 'fallback';
}

/**
 * Reset internal cache. Test-only.
 */
export function __resetCacheForTests(): void {
  cache = null;
  inflightFetch = null;
}
