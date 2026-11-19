/**
 * The platform's part of a cost figure (§137): all of it, less the part on
 * organisations' own AI keys, which the vendor bills to the org.
 *
 * The two come from separate sums, so a figure that is all own-key spend can
 * subtract to a float residue (`-1e-17`) rather than zero. Anything within a
 * millionth of a cent of zero is read as zero, so a chart's "no spend" state
 * and a table's `$0.00` still show.
 */

const RESIDUE_USD = 1e-8;

export function platformSpend(total: number, ownKey: number): number {
  const platform = total - ownKey;
  return Math.abs(platform) < RESIDUE_USD ? 0 : platform;
}
