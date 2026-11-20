'use client';

import { useTranslations } from 'next-intl';
import {
  calculatePasswordStrength,
  type PasswordStrength as Strength,
} from '@/lib/utils/password-strength';

/** The catalogue key for each strength the calculator returns. */
const LEVEL_KEYS = {
  Weak: 'weak',
  Fair: 'fair',
  Good: 'good',
  Strong: 'strong',
  'Very Strong': 'veryStrong',
} as const satisfies Record<Strength['label'], string>;

interface PasswordStrengthProps {
  password: string;
}

/**
 * Password Strength Meter Component
 *
 * Displays a visual indicator of password strength with:
 * - Progress bar showing strength level
 * - Text label (Weak, Fair, Good, Strong)
 * - Color coding (red → orange → yellow → green)
 *
 * Usage:
 * ```tsx
 * <PasswordStrength password={passwordValue} />
 * ```
 */
export function PasswordStrength({ password }: PasswordStrengthProps) {
  const t = useTranslations('forms.passwordStrength');
  const strength = calculatePasswordStrength(password);

  if (!password) {
    return null;
  }

  return (
    <div className="space-y-2">
      {/* Progress bar */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={`h-full transition-all duration-300 ${strength.color}`}
          style={{ width: `${strength.percentage}%` }}
        />
      </div>

      {/* Strength label */}
      <p className="text-muted-foreground text-xs">
        {t.rich('label', {
          level: t(`levels.${LEVEL_KEYS[strength.label]}`),
          value: (chunks) => <span className="font-medium">{chunks}</span>,
        })}
      </p>
    </div>
  );
}
