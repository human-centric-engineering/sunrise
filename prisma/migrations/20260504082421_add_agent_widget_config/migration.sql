-- AlterTable: per-agent embed-widget appearance + copy.
-- See widgetConfigSchema and DEFAULT_WIDGET_CONFIG in lib/validations/orchestration.ts.
-- null = use defaults; partial overrides are merged at read time via resolveWidgetConfig().
ALTER TABLE "ai_agent" ADD COLUMN "widgetConfig" JSONB;
