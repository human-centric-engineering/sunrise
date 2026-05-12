/**
 * Knowledge Base Page Constants
 *
 * Type-safe constants for the knowledge base page tabs.
 * Used by the useTrackedUrlTabs hook and KnowledgeView component.
 */

export const KNOWLEDGE_TABS = {
  MANAGE: 'manage',
  TAGS: 'tags',
  EXPLORE: 'explore',
  VISUALIZE: 'visualize',
  ERRORS: 'errors',
} as const;

export const KNOWLEDGE_TAB_VALUES = Object.values(KNOWLEDGE_TABS);

export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[keyof typeof KNOWLEDGE_TABS];

/**
 * Default tab when no URL parameter is present or value is invalid
 */
export const DEFAULT_KNOWLEDGE_TAB: KnowledgeTab = KNOWLEDGE_TABS.MANAGE;

/**
 * Page titles for each knowledge base tab
 * Used by useTrackedUrlTabs to update document.title on tab change
 */
export const KNOWLEDGE_TAB_TITLES: Record<KnowledgeTab, string> = {
  [KNOWLEDGE_TABS.MANAGE]: 'Manage - Knowledge Base - Sunrise',
  [KNOWLEDGE_TABS.TAGS]: 'Tags - Knowledge Base - Sunrise',
  [KNOWLEDGE_TABS.EXPLORE]: 'Explore - Knowledge Base - Sunrise',
  [KNOWLEDGE_TABS.VISUALIZE]: 'Visualize - Knowledge Base - Sunrise',
  [KNOWLEDGE_TABS.ERRORS]: 'Errors - Knowledge Base - Sunrise',
};
