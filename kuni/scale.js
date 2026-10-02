// 国の成り立ち — 年代の目盛りと表記（DOM に触らない純粋な関数。test/kuni.test.js で検証）

/** 西暦の表記。負の年は紀元前。 */
export function formatYear(y) {
  const n = Math.round(y);
  if (n < 0) return `紀元前${-n}年`;
  if (n < 1000) return `西暦${n}年`;
  return `${n}年`;
}

/** 年表の目盛り用の短い表記（文字が重ならないように）。 */
export function shortYear(y) {
  const n = Math.round(y);
  return n < 0 ? `前${-n}` : String(n);
}

/**
 * track = [[t, year], ...]（t は 0..1、どちらも増えていく）から、
 * 区分線形の toTrack(year) → 0..1 と toValue(t) → year を作る。
 */
export function makeScale(track) {
  const pts = [...track].sort((a, b) => a[0] - b[0]);
  const ts = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const interp = (xs, vs, x) => {
    if (x <= xs[0]) return vs[0];
    const last = xs.length - 1;
    if (x >= xs[last]) return vs[last];
    let i = 1;
    while (xs[i] < x) i++;
    const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
    return vs[i - 1] + f * (vs[i] - vs[i - 1]);
  };
  return {
    toTrack: (year) => interp(ys, ts, year),
    toValue: (t) => interp(ts, ys, t),
  };
}

/** その年に表示する地図 = year 以下でいちばん新しい keyframe（無ければ最初のもの）。 */
export function keyframeAt(keyframes, year) {
  let found = keyframes[0];
  for (const k of keyframes) if (k.year <= year) found = k;
  return found;
}
