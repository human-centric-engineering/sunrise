/**
 * Password Strength Calculator
 *
 * Calculates password strength based on multiple criteria:
 * - Length
 * - Character variety (uppercase, lowercase, numbers, special chars)
 * - Common patterns
 */

export interface PasswordStrength {
  score: number // 0-4
  label: 'Weak' | 'Fair' | 'Good' | 'Strong' | 'Very Strong'
  color: string
  percentage: number
}

export function calculatePasswordStrength(password: string): PasswordStrength {
  if (!password) {
    return { score: 0, label: 'Weak', color: 'bg-gray-300', percentage: 0 }
  }

  let score = 0

  // Length bonus
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (password.length >= 16) score++

  // Character variety
  if (/[a-z]/.test(password)) score++ // lowercase
  if (/[A-Z]/.test(password)) score++ // uppercase
  if (/[0-9]/.test(password)) score++ // numbers
  if (/[^a-zA-Z0-9]/.test(password)) score++ // special chars

  // Penalize common patterns
  if (/^[a-z]+$/.test(password)) score-- // all lowercase
  if (/^[A-Z]+$/.test(password)) score-- // all uppercase
  if (/^[0-9]+$/.test(password)) score-- // all numbers
  if (/(.)\1{2,}/.test(password)) score-- // repeated characters (aaa, 111)
  if (/^(123|abc|qwerty|password)/i.test(password)) score -= 2 // common sequences

  // Normalize score to 0-4 range
  score = Math.max(0, Math.min(4, score))

  // Map score to label and color
  const strengthMap: Record<number, Omit<PasswordStrength, 'score' | 'percentage'>> = {
    0: { label: 'Weak', color: 'bg-red-500' },
    1: { label: 'Weak', color: 'bg-red-500' },
    2: { label: 'Fair', color: 'bg-orange-500' },
    3: { label: 'Good', color: 'bg-yellow-500' },
    4: { label: 'Strong', color: 'bg-green-500' },
  }

  const strength = strengthMap[score]
  const percentage = (score / 4) * 100

  return {
    score,
    ...strength,
    percentage,
  }
}
