-- t-992 (§127): the LLM privacy layer's embeddings policy, install-wide.
--
-- `allow` is both the value an existing settings row gets and the default for
-- a new one: embedding calls are counted and never masked, and nothing is
-- refused until an operator chooses `local_only`.

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "privacyEmbeddingsPolicy" TEXT NOT NULL DEFAULT 'allow';
