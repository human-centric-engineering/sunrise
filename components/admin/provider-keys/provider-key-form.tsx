'use client';

/**
 * Save an AI key for one provider, or replace the saved one (§137 t-1045).
 *
 * Puts to `PUT /api/v1/orgs/[id]/provider-keys/[providerId]`, which tests the
 * key with one cheap call to the vendor before it stores it: a key that fails
 * is not saved, and the reason shows beside Save. The key is never shown
 * again once it is saved; the page shows its last four characters.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError, SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { saveProviderKeySchema } from '@/lib/validations/tenancy';

type KeyFormData = z.infer<typeof saveProviderKeySchema>;

const SERVER_FIELDS: Partial<Record<string, keyof KeyFormData>> = { apiKey: 'apiKey' };

export interface ProviderKeyFormProps {
  orgId: string;
  providerConfigId: string;
  providerName: string;
  /** A key is saved already, so this one replaces it. */
  replaces: boolean;
  /** Called after a save, and on Cancel. */
  onDone: () => void;
}

export function ProviderKeyForm({
  orgId,
  providerConfigId,
  providerName,
  replaces,
  onDone,
}: ProviderKeyFormProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<KeyFormData>({
    resolver: zodResolver(saveProviderKeySchema),
    mode: 'onTouched',
    defaultValues: { apiKey: '' },
  });
  const save = useSaveFailure({
    fallback: 'The key could not be saved. Try again.',
    fields: SERVER_FIELDS,
    setError,
    errors,
  });
  const inputId = `provider-key-${providerConfigId}`;

  const onSubmit = async (data: KeyFormData) => {
    setSubmitting(true);
    try {
      await apiClient.put(API.ORGS.providerKey(orgId, providerConfigId), { body: data });
      reset();
      onDone();
      router.refresh();
    } catch (err) {
      save.report(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      method="post"
      onSubmit={save.submit(handleSubmit(onSubmit, save.invalid))}
      className="space-y-3"
      noValidate
    >
      <div className="space-y-2">
        <Label htmlFor={inputId} className="flex items-center gap-1">
          {replaces ? `New ${providerName} key` : `${providerName} key`}{' '}
          <FieldHelp title="Your organisation’s own key">
            <p>
              Paste an API key from your organisation&apos;s own {providerName} account. Your
              organisation&apos;s calls to {providerName} then go out on it, and {providerName}{' '}
              bills that account.
            </p>
            <p className="mt-2">
              Before it is saved, the key is tried with one small request to {providerName}. A key
              that fails is not saved. Once saved, it is never shown again: only its last four
              characters are.
            </p>
            {replaces && (
              <p className="mt-2">
                Saving replaces the current key: this organisation&apos;s calls use the new key
                within a minute. Use this when a key has leaked or you are moving to a new one.
              </p>
            )}
          </FieldHelp>
        </Label>
        <Input
          id={inputId}
          type="password"
          // Not "off": browsers ignore it on a password field and fill in the
          // admin's own login, which would then be sent to the vendor.
          autoComplete="new-password"
          spellCheck={false}
          {...register('apiKey')}
        />
        <FormError message={errors.apiKey?.message} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={submitting}>
          <KeyRound className="mr-2 h-4 w-4" />
          {submitting ? 'Testing and saving…' : replaces ? 'Test and replace' : 'Test and save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={onDone}>
          Cancel
        </Button>
      </div>
      <SaveError failure={save.failure} />
    </form>
  );
}
