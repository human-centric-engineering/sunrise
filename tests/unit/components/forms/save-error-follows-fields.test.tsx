// @vitest-environment happy-dom

/**
 * A blocked save's summary follows the fields (t-1013)
 *
 * The owner's report, on the sign-up form: press Save with fields empty, and
 * "N fields need fixing." stays by Save after every field is fixed, until the
 * next press. With `useSaveFailure({ errors })`, a real react-hook-form form
 * lowers the count as fields are fixed and drops the summary when none are
 * left, without moving focus away from the field being typed in.
 *
 * @see lib/hooks/use-save-failure.ts
 * @see components/forms/form-error.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { SaveError } from '@/components/forms/form-error';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
});
type Values = z.infer<typeof schema>;

/** A form wired as the recipe in `.context/ui/form-errors.md` says, with the live errors or not. */
function SignupLike({ live, onSave }: { live: boolean; onSave: () => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { name: '', email: '' },
  });
  const save = useSaveFailure({ fallback: 'Could not save.', ...(live ? { errors } : {}) });
  return (
    <form method="post" noValidate onSubmit={save.submit(handleSubmit(onSave, save.invalid))}>
      <input aria-label="Name" {...register('name')} />
      {errors.name && <p>{errors.name.message}</p>}
      <input aria-label="Email" {...register('email')} />
      {errors.email && <p>{errors.email.message}</p>}
      <SaveError failure={save.failure} />
      <button type="submit">Create account</button>
    </form>
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('a blocked save, given the live field errors', () => {
  it('lowers the count as fields are fixed and goes when the last is, focus staying put', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SignupLike live onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('2 fields need fixing.');
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());

    await user.type(screen.getByLabelText('Name'), 'Ada');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.')
    );
    // Updating the count must not pull focus to the summary or another field.
    expect(screen.getByLabelText('Name')).toHaveFocus();

    await user.type(screen.getByLabelText('Email'), 'ada@example.com');

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps focus in the field when a fix is undone and the count goes back up', async () => {
    const user = userEvent.setup();
    render(<SignupLike live onSave={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());

    await user.click(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.')
    );
    await user.clear(screen.getByLabelText('Email'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('2 fields need fixing.')
    );
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });

  it('shows only the field message, not the summary, for a field broken after all were fixed', async () => {
    const user = userEvent.setup();
    render(<SignupLike live onSave={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

    await user.clear(screen.getByLabelText('Email'));

    expect(await screen.findByText('Invalid email address')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('without them, keeps the count from the press, as before', async () => {
    const user = userEvent.setup();
    render(<SignupLike live={false} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('2 fields need fixing.');
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');

    expect(screen.getByRole('alert')).toHaveTextContent('2 fields need fixing.');
  });
});
