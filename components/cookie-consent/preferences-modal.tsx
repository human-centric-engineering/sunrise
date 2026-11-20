'use client';

/**
 * Cookie Preferences Modal Component
 *
 * Dialog for managing cookie preferences with category toggles.
 * Can be opened after initial consent to change preferences.
 *
 * Features:
 * - Shows all cookie categories with descriptions
 * - Essential cookies are shown but not toggleable
 * - Optional cookies can be toggled on/off
 * - Save/Cancel functionality
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useConsent, COOKIE_CATEGORIES } from '@/lib/consent';

interface PreferencesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Inner content component that resets state when modal opens
 * Uses key prop on parent to reset state cleanly
 */
function PreferencesContent({
  initialOptional,
  onSave,
  onCancel,
}: {
  initialOptional: boolean;
  onSave: (optional: boolean) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('cookies');
  const tc = useTranslations('common');
  const [optionalEnabled, setOptionalEnabled] = useState(initialOptional);

  const handleSave = () => {
    onSave(optionalEnabled);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('preferences.title')}</DialogTitle>
        <DialogDescription>{t('preferences.description')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        {COOKIE_CATEGORIES.map((category) => {
          const name = t(`categories.${category.id}.name`);
          return (
            <div key={category.id} className="flex items-start justify-between gap-4">
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{name}</span>
                  {category.required && (
                    <span className="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 text-xs">
                      {t('preferences.required')}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground text-sm">
                  {t(`categories.${category.id}.description`)}
                </p>
              </div>

              <div className="pt-0.5">
                {category.required ? (
                  // Essential cookies - always on, disabled switch
                  <Switch
                    checked={true}
                    disabled
                    aria-label={t('preferences.switchRequired', { name })}
                  />
                ) : (
                  // Optional cookies - toggleable
                  <Switch
                    checked={optionalEnabled}
                    onCheckedChange={setOptionalEnabled}
                    aria-label={t('preferences.switchOptional', { name })}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <DialogFooter className="gap-2 sm:gap-0">
        <Button variant="outline" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button onClick={handleSave}>{t('preferences.save')}</Button>
      </DialogFooter>
    </>
  );
}

export function PreferencesModal({ open, onOpenChange }: PreferencesModalProps) {
  const { consent, updateConsent } = useConsent();

  const handleSave = (optional: boolean) => {
    updateConsent(optional);
    onOpenChange(false);
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Use key to reset the content state when modal opens */}
        <PreferencesContent
          key={open ? 'open' : 'closed'}
          initialOptional={consent.optional}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      </DialogContent>
    </Dialog>
  );
}
