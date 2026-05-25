/**
 * Welch's two-sample t-test.
 *
 * Used by the experiment compare view (Phase 2.5) to decide whether
 * two variants' per-case grader scores differ to a degree that's
 * unlikely under the null hypothesis of "same underlying performance".
 *
 * **Caveat the UI surfaces.** Welch's t-test assumes the per-sample
 * mean is approximately normally distributed. Rubric scores on a
 * `[0, 1]` scale frequently aren't — they pile up at the ends. The
 * Central Limit Theorem rescues us when N is large enough (~30+ per
 * variant), and the tooltip + doc are explicit that small-N variant
 * comparisons should be read with extra caution. A permutation-test
 * fallback was considered and rejected — ~10× the implementation cost
 * for marginal accuracy improvement at sample sizes a partner pilot
 * would realistically generate.
 *
 * Returns `null` for the test statistic and p-value when either
 * sample has fewer than 2 values (a single-value sample has zero
 * variance, so the test statistic is undefined).
 */

export interface WelchResult {
  /** Test statistic. Null when either sample has <2 values. */
  t: number | null;
  /** Degrees of freedom (Welch–Satterthwaite). Null on insufficient samples. */
  df: number | null;
  /** Two-sided p-value in [0, 1]. Null on insufficient samples. */
  p: number | null;
  /** Sample sizes for each group, exposed so the UI can warn on small N. */
  n1: number;
  n2: number;
}

export function welchTTest(a: number[], b: number[]): WelchResult {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) {
    return { t: null, df: null, p: null, n1, n2 };
  }

  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = sampleVariance(a, m1);
  const v2 = sampleVariance(b, m2);

  // Welch test statistic: difference of means / pooled SE under unequal variance.
  const seSquared = v1 / n1 + v2 / n2;
  // Floating-point: a constant sample like [0.7, 0.7, 0.7] doesn't
  // accumulate exactly zero variance, but anything below 1e-12 should
  // be treated as no signal — the t-statistic is ill-defined either way.
  if (seSquared < 1e-12) {
    return { t: null, df: null, p: null, n1, n2 };
  }
  const t = (m1 - m2) / Math.sqrt(seSquared);

  // Welch–Satterthwaite degrees of freedom.
  const dfNum = (v1 / n1 + v2 / n2) ** 2;
  const dfDen = (v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1);
  const df = dfNum / dfDen;

  const p = twoSidedPValue(t, df);

  return { t, df, p, n1, n2 };
}

function mean(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

function sampleVariance(xs: number[], m: number): number {
  let total = 0;
  for (const x of xs) total += (x - m) ** 2;
  return total / (xs.length - 1);
}

/**
 * Two-sided p-value for a t-distribution with `df` degrees of freedom.
 *
 * Implemented via the regularised incomplete beta function:
 *     P(|T| > t) = I_x(df/2, 1/2),  x = df / (df + t^2)
 *
 * `incompleteBeta` uses the standard Lentz continued-fraction expansion
 * — converges in under 50 iterations for any realistic (t, df) pair we'd
 * surface in the UI. No external libs.
 */
export function twoSidedPValue(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  // Symmetric distribution — two-sided is the area in *both* tails.
  return clamp01(incompleteBeta(df / 2, 0.5, x));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 1;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Regularised incomplete beta function I_x(a, b). Source: Numerical
 * Recipes §6.4 (Lentz's algorithm). Adapted to TypeScript with
 * defensive bailouts so we never divide by zero on degenerate inputs.
 */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

const FPMIN = 1e-300;
const EPS = 3e-7;
const MAX_ITER = 200;

function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * Lanczos approximation for log Γ(x). Accurate to ~10⁻¹⁰ for x > 0,
 * which is well below any precision the UI cares about for p-values.
 * Constants are JS-double-truncated where the literal in the original
 * Numerical Recipes table exceeded double precision.
 */
function logGamma(x: number): number {
  /* eslint-disable no-loss-of-precision -- Numerical Recipes' Lanczos
     constants are specified beyond double precision; JS truncates them
     to the nearest representable value, which is the standard practice
     in every reference impl (R, scipy, NR-in-C). The truncation error is
     well below our 10^-7 t-test convergence target. */
  const coef = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    1.208650973866179e-3, -5.395239384953e-6,
  ];
  /* eslint-enable no-loss-of-precision */
  const xx = x;
  let y = xx;
  let tmp = xx + 5.5;
  tmp -= (xx + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of coef) {
    y += 1;
    ser += c / y;
  }
  return -tmp + Math.log((2.5066282746310007 * ser) / xx);
}
