// 大陸を動かす計算の中身。ブラウザと node --test の両方で使うので、DOM に触らない。
//
// 回転は単位四元数 [w, x, y, z]（GPlates Web Service と同じ並び）。
// 座標は経度・緯度（度）か、地球の中心を原点にした単位ベクトル [x, y, z]
//（x: 経度0°・緯度0°の方向、y: 経度90°、z: 北極）。

export const IDENTITY = [1, 0, 0, 0];
const RAD = Math.PI / 180;

export function qmul(a, b) {
  const [w1, x1, y1, z1] = a;
  const [w2, x2, y2, z2] = b;
  return [
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
  ];
}

export function qconj(q) {
  return [q[0], -q[1], -q[2], -q[3]];
}

export function qnormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** 単位四元数でベクトル v = [x, y, z] を回す */
export function qrotate(q, v) {
  const [w, ux, uy, uz] = q;
  const [vx, vy, vz] = v;
  // t = 2 (u × v)
  const tx = 2 * (uy * vz - uz * vy);
  const ty = 2 * (uz * vx - ux * vz);
  const tz = 2 * (ux * vy - uy * vx);
  // v + w t + u × t
  return [
    vx + w * tx + (uy * tz - uz * ty),
    vy + w * ty + (uz * tx - ux * tz),
    vz + w * tz + (ux * ty - uy * tx),
  ];
}

/** 球面線形補間。t = 0 で a、t = 1 で b */
export function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) {
    bb = [-b[0], -b[1], -b[2], -b[3]];
    d = -d;
  }
  if (d > 0.9995) {
    return qnormalize([
      a[0] + t * (bb[0] - a[0]),
      a[1] + t * (bb[1] - a[1]),
      a[2] + t * (bb[2] - a[2]),
      a[3] + t * (bb[3] - a[3]),
    ]);
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s;
  const kb = Math.sin(t * th) / s;
  return [ka * a[0] + kb * bb[0], ka * a[1] + kb * bb[1], ka * a[2] + kb * bb[2], ka * a[3] + kb * bb[3]];
}

export function lonLatToVec(lon, lat) {
  const lo = lon * RAD;
  const la = lat * RAD;
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

export function vecToLonLat(v) {
  const z = Math.max(-1, Math.min(1, v[2]));
  return [Math.atan2(v[1], v[0]) / RAD, Math.asin(z) / RAD];
}

export function rotateLonLat(q, lon, lat) {
  return vecToLonLat(qrotate(q, lonLatToVec(lon, lat)));
}

/** 2 地点のあいだの角距離（度） */
export function angularDistance(lon1, lat1, lon2, lat2) {
  const a = lonLatToVec(lon1, lat1);
  const b = lonLatToVec(lon2, lat2);
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(d) / RAD;
}

/**
 * 標本化した回転の表。data/rotations.json（meta）と data/rotations.bin（Int16 の列）から作る。
 * bin の並びは [プレート][時点][w, x, y, z]。
 */
export class Rotations {
  constructor(meta, int16) {
    this.times = meta.times;
    this.scale = meta.scale;
    this.data = int16;
    this.index = new Map();
    meta.pids.forEach((pid, i) => this.index.set(pid, i));
    if (int16.length !== meta.pids.length * meta.times.length * 4) {
      throw new Error(`rotations.bin の長さが合わない: ${int16.length}`);
    }
  }

  sample(pid, k) {
    const row = this.index.get(pid);
    if (row === undefined) return IDENTITY;
    const o = (row * this.times.length + k) * 4;
    const s = this.scale;
    return qnormalize([this.data[o] / s, this.data[o + 1] / s, this.data[o + 2] / s, this.data[o + 3] / s]);
  }

  /** プレート pid の、age（100万年前）の回転。標本のあいだは球面線形補間 */
  at(pid, age) {
    if (!this.index.has(pid)) return IDENTITY;
    const t = this.times;
    if (age <= t[0]) return this.sample(pid, 0);
    if (age >= t[t.length - 1]) return this.sample(pid, t.length - 1);
    // 二分探索: t[j-1] <= age < t[j]
    let lo = 0;
    let hi = t.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= age) lo = mid;
      else hi = mid;
    }
    if (t[lo] === age) return this.sample(pid, lo);
    const f = (age - t[lo]) / (t[hi] - t[lo]);
    return slerp(this.sample(pid, lo), this.sample(pid, hi), f);
  }
}

/**
 * 陸片の segs = [[age, pid], ...] に従って、乗り換えの前後で位置が続くように
 * 補正する回転 M_k を求める。区間 k は segs[k].age < t <= segs[k+1].age。
 * M_0 = 恒等、M_k = R_pid_k(a_k)^-1 · R_pid_(k-1)(a_k) · M_(k-1)
 */
export function chainOffsets(segs, rot) {
  const M = [IDENTITY];
  for (let k = 1; k < segs.length; k++) {
    const a = segs[k][0];
    const prev = qmul(rot.at(segs[k - 1][1], a), M[k - 1]);
    M.push(qmul(qconj(rot.at(segs[k][1], a)), prev));
  }
  return M;
}

/** 陸片の age での回転。表示しない年代なら null */
export function pieceRotation(piece, rot, age) {
  if (age > piece.until) return null;
  const segs = piece.segs;
  if (!piece._M) piece._M = chainOffsets(segs, rot);
  let k = 0;
  while (k + 1 < segs.length && age > segs[k + 1][0]) k++;
  return qmul(rot.at(segs[k][1], age), piece._M[k]);
}

/** 陸片の表示状態: solid（モデルに陸がある）/ ghost（まだ無い時代。となりの陸地と一緒に動かした推定）/ hidden */
export function pieceState(piece, age) {
  if (age > piece.until) return "hidden";
  if (age > piece.from) return "ghost";
  return "solid";
}

// ---------- 年代 ----------

/** 100万年単位の年代を「2億5000万年前」のように書く */
export function formatAge(ma) {
  const man = Math.round(ma * 100); // 万年
  if (ma <= 0 || man === 0) return "現在";
  const oku = Math.floor(man / 10000);
  const rest = man % 10000;
  let s = "";
  if (oku) s += `${oku}億`;
  if (rest) s += `${rest}万`;
  return `${s}年前`;
}

/** スライダーの目盛り（0〜1）と年代の対応。最近の年代ほど幅を広くとる */
export const TRACK_STOPS = [
  [0, 1000],
  [0.42, 250],
  [1, 0],
];

export function trackToAge(x, stops = TRACK_STOPS) {
  x = Math.max(0, Math.min(1, x));
  for (let i = 1; i < stops.length; i++) {
    const [x0, a0] = stops[i - 1];
    const [x1, a1] = stops[i];
    if (x <= x1) return a0 + ((x - x0) / (x1 - x0)) * (a1 - a0);
  }
  return stops[stops.length - 1][1];
}

export function ageToTrack(age, stops = TRACK_STOPS) {
  const maxAge = stops[0][1];
  age = Math.max(0, Math.min(maxAge, age));
  for (let i = 1; i < stops.length; i++) {
    const [x0, a0] = stops[i - 1];
    const [x1, a1] = stops[i];
    if (age >= Math.min(a0, a1) && age <= Math.max(a0, a1)) return x0 + ((age - a0) / (a1 - a0)) * (x1 - x0);
  }
  return 1;
}

/** periods は古い順でも新しい順でもよい。start（古い側）> end（新しい側） */
export function periodAt(periods, age) {
  let oldest = null;
  for (const p of periods) {
    if (!oldest || p.start > oldest.start) oldest = p;
    if (p.end <= age && age < p.start) return p;
  }
  if (oldest && age === oldest.start) return oldest;
  return null;
}

/** age の前後 window（100万年）にある出来事を、近い順に返す */
export function eventsNear(events, age, window) {
  return events
    .filter((e) => Math.abs(e.age - age) <= window)
    .sort((a, b) => Math.abs(a.age - age) - Math.abs(b.age - age));
}
