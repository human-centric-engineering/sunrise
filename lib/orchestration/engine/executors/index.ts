/**
 * Executor barrel.
 *
 * Importing this module triggers the `registerStepType()` side-effects
 * in every executor file, so a consumer only needs:
 *
 *   import '@/lib/orchestration/engine/executors';
 *
 * before calling `getExecutor()` or `OrchestrationEngine.execute()`.
 */

import '@/lib/orchestration/engine/executors/llm-call';
import '@/lib/orchestration/engine/executors/tool-call';
import '@/lib/orchestration/engine/executors/chain';
import '@/lib/orchestration/engine/executors/route';
import '@/lib/orchestration/engine/executors/parallel';
import '@/lib/orchestration/engine/executors/reflect';
import '@/lib/orchestration/engine/executors/plan';
import '@/lib/orchestration/engine/executors/human-approval';
import '@/lib/orchestration/engine/executors/rag-retrieve';
import '@/lib/orchestration/engine/executors/guard';
import '@/lib/orchestration/engine/executors/evaluate';
import '@/lib/orchestration/engine/executors/external-call';
import '@/lib/orchestration/engine/executors/agent-call';
import '@/lib/orchestration/engine/executors/notification';
import '@/lib/orchestration/engine/executors/orchestrator';
