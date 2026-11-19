/**
 * The workflow builder's model-override picker, for an editor's tests
 * (§136 t-1068).
 *
 * Two providers offering the same id, so a test that picks one shows the pin
 * names the provider it chose.
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/model-override-field.tsx
 */

import type { ReactElement } from 'react';
import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

import {
  ModelOptionsProvider,
  type ModelOption,
} from '@/components/admin/orchestration/workflow-builder/block-editors/model-override-field';

export const MODEL_OPTIONS: ModelOption[] = [
  { providerSlug: 'openai', modelId: 'gpt-4o', name: 'GPT-4o' },
  { providerSlug: 'microsoft', modelId: 'gpt-4o', name: 'GPT-4o' },
];

/** `ui` with {@link MODEL_OPTIONS} on offer to its model-override pickers. */
export function withModels(ui: ReactElement): ReactElement {
  return <ModelOptionsProvider models={MODEL_OPTIONS}>{ui}</ModelOptionsProvider>;
}

/** Open the picker whose trigger has `id` and choose the option named `name`. */
export async function pickModel(user: UserEvent, id: string, name: string | RegExp): Promise<void> {
  const trigger = document.getElementById(id);
  if (!trigger) throw new Error(`No model picker #${id}`);
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name }));
}

/** What the picker whose trigger has `id` shows as chosen. */
export function pickedModel(id: string): string {
  const trigger = document.getElementById(id);
  if (!trigger) throw new Error(`No model picker #${id}`);
  return trigger.textContent ?? '';
}
