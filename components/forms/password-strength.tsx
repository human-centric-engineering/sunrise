'use client'

import { calculatePasswordStrength } from '@/lib/utils/password-strength'

interface PasswordStrengthProps {
  password: string
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
  const strength = calculatePasswordStrength(password)

  if (!password) {
    return null
  }

  return (
    <div className="space-y-2">
      {/* Progress bar */}
      <div className="h-2 w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${strength.color}`}
          style={{ width: `${strength.percentage}%` }}
        />
      </div>

      {/* Strength label */}
      <p className="text-xs text-muted-foreground">
        Password strength: <span className="font-medium">{strength.label}</span>
      </p>
    </div>
  )
}
