export function phi(z: number): number {
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  const x = -z / Math.SQRT2;
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  const erfc = x >= 0 ? y : 2 - y;
  return 0.5 * erfc;
}

export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = phi(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export const Z975 = normalQuantile(0.975);

export function wilson(k: number, n: number, z = Z975): [number, number] {
  if (n === 0) return [NaN, NaN];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}
export const binomPmf = (k: number, n: number, p = 0.5): number =>
  Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));

export function mcnemarOneSided(favoured: number, against: number): { exact_p: number; mid_p: number } {
  const n = favoured + against;
  if (n === 0) return { exact_p: 1, mid_p: 1 };
  let upper = 0;
  for (let k = favoured; k <= n; k++) upper += binomPmf(k, n);
  return { exact_p: Math.min(1, upper), mid_p: Math.min(1, upper - 0.5 * binomPmf(favoured, n)) };
}

export function tangoStatistic(x12: number, x21: number, n: number, delta: number): number {
  const A = 2 * n;
  const B = -x12 - x21 + (2 * n - x12 + x21) * delta;
  const C = -x21 * delta * (1 - delta);
  const q21 = (Math.sqrt(Math.max(0, B * B - 4 * A * C)) - B) / (2 * A);
  const variance = n * (2 * q21 + delta * (1 - delta));
  return variance <= 0 ? (x12 - x21 - n * delta === 0 ? 0 : Math.sign(x12 - x21 - n * delta) * Infinity) : (x12 - x21 - n * delta) / Math.sqrt(variance);
}

function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let flo = f(lo);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
  }
  return (lo + hi) / 2;
}

export function tangoCi(x12: number, x21: number, n: number, z = Z975): { estimate: number; lower: number; upper: number } {
  const est = (x12 - x21) / n;
  const lower = est <= -1 + 1e-12 ? -1 : bisect((d) => tangoStatistic(x12, x21, n, d) - z, -1 + 1e-12, est);
  const upper = est >= 1 - 1e-12 ? 1 : bisect((d) => tangoStatistic(x12, x21, n, d) + z, est, 1 - 1e-12);
  return { estimate: est, lower, upper };
}

export function tangoNonInferiorityP(x12: number, x21: number, n: number, margin: number): number {
  return phi(tangoStatistic(x12, x21, n, margin));
}

export function newcombePaired(a: number, b: number, c: number, d: number, z = Z975): { estimate: number; lower: number; upper: number } {
  const n = a + b + c + d;
  const p1 = (a + b) / n;
  const p2 = (a + c) / n;
  const [l1, u1] = wilson(a + b, n, z);
  const [l2, u2] = wilson(a + c, n, z);
  const margins = (a + b) * (c + d) * (a + c) * (b + d);
  let numerator = a * d - b * c;
  if (numerator > 0) numerator = Math.max(numerator - n / 2, 0);
  const corr = margins === 0 ? 0 : numerator / Math.sqrt(margins);
  const est = p1 - p2;
  const dl = Math.sqrt(Math.max(0, (p1 - l1) ** 2 - 2 * corr * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2));
  const du = Math.sqrt(Math.max(0, (u1 - p1) ** 2 - 2 * corr * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2));
  return { estimate: est, lower: est - dl, upper: est + du };
}

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bcaMean(values: number[], resamples: number, seed: number, z = Z975): { estimate: number; lower: number; upper: number; z0: number; acceleration: number } {
  const n = values.length;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const theta = mean(values);
  const random = mulberry32(seed);
  const boot: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(random() * n)];
    boot.push(s / n);
  }
  boot.sort((x, y) => x - y);
  const below = boot.filter((b) => b < theta).length + 0.5 * boot.filter((b) => b === theta).length;
  const z0 = normalQuantile(below / resamples);
  const total = values.reduce((s, x) => s + x, 0);
  const jack = values.map((x) => (total - x) / (n - 1));
  const jm = mean(jack);
  const num = jack.reduce((s, j) => s + (jm - j) ** 3, 0);
  const den = 6 * Math.pow(jack.reduce((s, j) => s + (jm - j) ** 2, 0), 1.5);
  const acceleration = den === 0 ? 0 : num / den;
  const adjusted = (zAlpha: number) => phi(z0 + (z0 + zAlpha) / (1 - acceleration * (z0 + zAlpha)));
  const pick = (q: number) => boot[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))];
  return { estimate: theta, lower: pick(adjusted(-z)), upper: pick(adjusted(z)), z0, acceleration };
}

export function wilcoxonSignedRank(diffs: number[]): { n: number; v: number; z: number; p_less: number } {
  const nonzero = diffs.filter((d) => d !== 0);
  const ranked = nonzero.map((d) => ({ d, a: Math.abs(d) })).sort((x, y) => x.a - y.a);
  const ranks = new Array(ranked.length).fill(0);
  let tieTerm = 0;
  for (let i = 0; i < ranked.length; ) {
    let j = i;
    while (j + 1 < ranked.length && ranked[j + 1].a === ranked[i].a) j++;
    const rank = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    i = j + 1;
  }
  const n = ranked.length;
  const v = ranked.reduce((s, r, i) => s + (r.d > 0 ? ranks[i] : 0), 0);
  const mean = (n * (n + 1)) / 4;
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48);
  const z = (v - mean + 0.5) / sd;
  return { n, v, z, p_less: phi(z) };
}

export function holm(pvalues: Record<string, number>, alpha: number): Record<string, { p: number; threshold: number; reject: boolean }> {
  const ordered = Object.entries(pvalues).sort((a, b) => a[1] - b[1]);
  const m = ordered.length;
  const out: Record<string, { p: number; threshold: number; reject: boolean }> = {};
  let stillRejecting = true;
  ordered.forEach(([name, p], i) => {
    const threshold = alpha / (m - i);
    stillRejecting = stillRejecting && p <= threshold;
    out[name] = { p, threshold, reject: stillRejecting };
  });
  return out;
}

export function cohenKappa(pairs: [boolean, boolean][]): { n: number; agree: number; kappa: number } {
  const n = pairs.length;
  const agree = pairs.filter(([x, y]) => x === y).length;
  const p1 = pairs.filter(([x]) => x).length / n;
  const p2 = pairs.filter(([, y]) => y).length / n;
  const pe = p1 * p2 + (1 - p1) * (1 - p2);
  return { n, agree, kappa: pe === 1 ? 1 : (agree / n - pe) / (1 - pe) };
}
