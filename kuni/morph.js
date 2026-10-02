// 国の成り立ち — 2 枚の地図（keyframe）のあいだを、なめらかに塗りかえるための計算。
// DOM にも d3 にも触らない純粋な関数（test/kuni.test.js で検証）。距離や中心は引数で受け取る。

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** e0〜e1 のあいだで 0→1 になめらかに変わる値 */
export function smoothstep(x, e0 = 0, e1 = 1) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * 年 t での変化の進み具合 f（0 = 前の地図 a、1 = 次の地図 b）。
 * win = [y0, y1] があれば、そのあいだだけで変化する（前は 0、y1 からは 1）。
 */
export function progress(t, a, b, win) {
  const raw = win ? (t - win[0]) / (win[1] - win[0]) : (t - a) / (b - a);
  return smoothstep(clamp01(raw));
}

/** 場面の「土台の地図の ID → 勢力」 */
export function ownerMap(kf) {
  const m = new Map();
  for (const p of kf.polities) for (const u of p.units ?? []) m.set(u, p);
  return m;
}

/** n 個を順番にずらして塗りかえるときの、しきい値（0.15〜0.85） */
export function rankThresholds(n) {
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0.5 : 0.15 + (0.7 * i) / (n - 1)));
}

/** 勢力の中心: units の中心の平均。units が無ければ最初の area の中心 */
export function polityCore(p, unitCenter) {
  const us = p.units ?? [];
  if (us.length) {
    let x = 0, y = 0;
    for (const u of us) { const c = unitCenter(u); x += c[0]; y += c[1]; }
    return [x / us.length, y / us.length];
  }
  const a = p.areas?.[0];
  if (!a) return null;
  if (a.type === "disc") return a.center;
  let x = 0, y = 0;
  for (const q of a.points) { x += q[0]; y += q[1]; }
  return [x / a.points.length, y / a.points.length];
}

/**
 * 前の地図 A から次の地図 B への塗りかえ計画。ID ごとに { from, to, theta }。
 * 同じ名前の勢力のままなら theta = null（色だけ f で混ぜる）。
 * 持ち主が変わる ID は、新しい持ち主の中心に近い順に（失うだけのときは、元の中心から遠い順に）塗りかえる。
 */
export function planTransition(A, B, { unitCenter, distance }) {
  const oa = ownerMap(A);
  const ob = ownerMap(B);
  const plan = new Map();
  const gains = new Map();
  const losses = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const id of new Set([...oa.keys(), ...ob.keys()])) {
    const from = oa.get(id) ?? null;
    const to = ob.get(id) ?? null;
    if (from && to && from.name === to.name) { plan.set(id, { from, to, theta: null }); continue; }
    plan.set(id, { from, to, theta: 0.5 });
    if (to) push(gains, to, id);
    else push(losses, from, id);
  }
  const assign = (ids, core, farFirst) => {
    const d = (id) => (core ? distance(unitCenter(id), core) : 0);
    const sorted = [...ids].sort((x, y) => (farFirst ? d(y) - d(x) : d(x) - d(y)) || (x < y ? -1 : 1));
    const th = rankThresholds(sorted.length);
    sorted.forEach((id, i) => { plan.get(id).theta = th[i]; });
  };
  for (const [p, ids] of gains) assign(ids, polityCore(p, unitCenter), false);
  for (const [p, ids] of losses) assign(ids, polityCore(p, unitCenter), true);
  return plan;
}

/** 計画の 1 つの ID が、進み具合 f のとき「次の持ち主」にどれだけ寄っているか（0〜1）。しきい値の前後 band で色を混ぜる */
export function unitWeight(entry, f, band = 0.06) {
  if (entry.theta === null) return f;
  return clamp01((f - (entry.theta - band)) / (2 * band));
}

/** 進み具合 f での「ID → 勢力の名前（無ければ null）」 */
export function ownersAt(plan, f) {
  const m = new Map();
  for (const [id, e] of plan) {
    const owner = unitWeight(e, f) >= 0.5 ? e.to : e.from;
    m.set(id, owner ? owner.name : null);
  }
  return m;
}

/** 2 つの areas の並びが、形を少しずつ変えて行き来できるか（同じ種類・同じ点の数） */
export function areasMorphable(xs, ys) {
  return xs.length > 0 && xs.length === ys.length
    && xs.every((a, i) => a.type === ys[i].type && (a.type === "disc" || a.points.length === ys[i].points.length));
}

const lerp = (a, b, f) => a + (b - a) * f;
export const lerpPoint = (p, q, f) => [lerp(p[0], q[0], f), lerp(p[1], q[1], f)];

/** area を f で混ぜる（areasMorphable が true の組だけ） */
export function lerpArea(a, b, f) {
  if (a.type === "disc") return { type: "disc", center: lerpPoint(a.center, b.center, f), km: lerp(a.km, b.km, f) };
  return { type: "poly", points: a.points.map((p, i) => lerpPoint(p, b.points[i], f)) };
}

/** #rrggbb を w で混ぜる */
export function mixHex(a, b, w) {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const c = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  let out = "#";
  for (let i = 0; i < 3; i++) out += Math.round(lerp(c(a, i), c(b, i), w)).toString(16).padStart(2, "0");
  return out;
}

/** 名前の比べ方（空白と大文字小文字を無視）。つづく場面で同じ勢力の名前がずれていないか調べる */
export const normalizeName = (s) => s.replace(/\s+/g, "").toLowerCase();
