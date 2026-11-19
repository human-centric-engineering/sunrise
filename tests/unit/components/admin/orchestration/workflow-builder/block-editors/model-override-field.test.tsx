// @vitest-environment happy-dom

/**
 * Unit Tests: ModelOverrideField (§136 t-1068)
 *
 * Test Coverage:
 * - One option per provider's model, labelled with its provider; a shared id gives two options
 * - Picking an option reports the `provider::model` pin
 * - Picking "The default chat model" reports undefined
 * - A current value the catalogue does not list is kept and shown as itself
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/model-override-field.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ModelOverrideField,
  toModelOptions,
} from '@/components/admin/orchestration/workflow-builder/block-editors/model-override-field';
import { pickModel, pickedModel, withModels } from '@/tests/helpers/model-options';

function renderField(value: string | undefined, onChange = vi.fn()) {
  render(withModels(<ModelOverrideField id="mo" value={value} onChange={onChange} />));
  return onChange;
}

describe('ModelOverrideField', () => {
  it('offers the default, then one option per provider, so a shared model id is two options', async () => {
    const user = userEvent.setup();
    renderField(undefined);

    await user.click(document.getElementById('mo') as HTMLElement);

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'The default chat model',
      'GPT-4o (openai)',
      'GPT-4o (microsoft)',
    ]);
  });

  it('shows the default option as chosen when there is no override', () => {
    renderField(undefined);
    expect(pickedModel('mo')).toBe('The default chat model');
  });

  it('reports the picked option as a pin naming its provider, not the model id alone', async () => {
    const user = userEvent.setup();
    const onChange = renderField(undefined);

    await pickModel(user, 'mo', 'GPT-4o (microsoft)');

    expect(onChange).toHaveBeenCalledExactlyOnceWith('microsoft::gpt-4o');
  });

  it('shows a stored pair as the provider-labelled option', () => {
    renderField('microsoft::gpt-4o');
    expect(pickedModel('mo')).toBe('GPT-4o (microsoft)');
  });

  it('reports undefined when the default option is picked, clearing the override', async () => {
    const user = userEvent.setup();
    const onChange = renderField('openai::gpt-4o');

    await pickModel(user, 'mo', 'The default chat model');

    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('keeps a stored bare id and shows it as its own option', async () => {
    const user = userEvent.setup();
    renderField('gpt-4o');

    expect(pickedModel('mo')).toBe('gpt-4o (by model id, no provider)');
    await user.click(document.getElementById('mo') as HTMLElement);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'The default chat model',
      'gpt-4o (by model id, no provider)',
      'GPT-4o (openai)',
      'GPT-4o (microsoft)',
    ]);
  });

  it('keeps a stored pair the catalogue no longer lists and says so', async () => {
    const user = userEvent.setup();
    renderField('azure::gpt-4o');

    expect(pickedModel('mo')).toBe('gpt-4o (azure, not offered here)');
    await user.click(document.getElementById('mo') as HTMLElement);
    expect(screen.getAllByRole('option')[1].textContent).toBe('gpt-4o (azure, not offered here)');
  });

  it('uses the defaultLabel for the no-override option', async () => {
    const user = userEvent.setup();
    render(
      withModels(
        <ModelOverrideField
          id="mo"
          value={undefined}
          onChange={vi.fn()}
          defaultLabel="The judge model"
        />
      )
    );

    expect(pickedModel('mo')).toBe('The judge model');
    await user.click(document.getElementById('mo') as HTMLElement);
    expect(screen.getAllByRole('option')[0].textContent).toBe('The judge model');
  });
});

describe('toModelOptions', () => {
  it('keeps only rows whose provider is set up and active, as the default-models form offers', () => {
    expect(
      toModelOptions([
        { providerSlug: 'openai', modelId: 'gpt-4o', name: 'GPT-4o', configuredActive: true },
        { providerSlug: 'google', modelId: 'gemini', name: 'Gemini', configuredActive: false },
        { providerSlug: 'groq', modelId: 'llama', name: 'Llama' },
      ])
    ).toEqual([{ providerSlug: 'openai', modelId: 'gpt-4o', name: 'GPT-4o' }]);
  });
});
