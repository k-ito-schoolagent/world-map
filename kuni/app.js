// 国の成り立ち（試作） — 画面の組み立て。年代の計算は scale.js、年表は ../lib/timeline.js。
import { formatYear, shortYear, makeScale, keyframeAt } from "./scale.js";
import { progress, smoothstep, planTransition, pinActivity, unitWeight, areasMorphable, lerpArea, lerpPoint, mixHex } from "./morph.js";
import { createTimeline } from "../lib/timeline.js";

const $ = (s) => document.querySelector(s);
const viewport = $("#viewport");
const canvas = $("#map");
const ctx = canvas.getContext("2d");
const KM_PER_DEG = 111.2;
const FADE_MS = 250;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  stage: null, // 読み込んだ年表（africa.json など）に、計算した値を足したもの
  year: 2026,
  zoom: 1,
  center: [0, 0], // 地球儀の中心（経度・緯度）。ドラッグで変わる
  selected: null, // 強調している polity の名前
  legendOpen: false, // 勢力が多い場面で、地図の上の一覧を開いているか
  playing: false,
  speed: 0.05, // 1 秒に進む年表の長さ（0〜1）
  opts: { grid: true, labels: true, smooth: !reduceMotion }, // smooth: 2 枚の地図のあいだを少しずつ塗りかえる
  frame: null, // いま描く地図 { A, B, f }
};

let stages = []; // stages.json の一覧
const cache = new Map(); // id → 読み込んだ stage
let timeline;
let scale;
let projection;
let fit = { key: "", scale: 1, translate: [0, 0] };
let polityPaths = []; // [{ name, paths: Path2D[] }]（クリックで選ぶため）
let currentKf = null;
let fade = null; // { from: keyframe, start: ms }
let renderQueued = false;

// ---------- 読み込み ----------
function fixWinding(geom) {
  // d3 は外側の輪が時計回り（球面で）を前提にする。逆なら裏返す
  if (d3.geoArea(geom) > 2 * Math.PI) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const p of polys) for (const ring of p) ring.reverse();
  }
  return geom;
}

function areaGeometry(a) {
  if (a.type === "disc") return d3.geoCircle().center(a.center).radius(a.km / KM_PER_DEG).precision(2)();
  const ring = a.points.map((p) => [...p]);
  const [f, l] = [ring[0], ring[ring.length - 1]];
  if (f[0] !== l[0] || f[1] !== l[1]) ring.push([...f]);
  return fixWinding({ type: "Polygon", coordinates: [ring] });
}

/** fit: [[西, 南], [東, 北]] の四角の縁を点の集まりにする（向きを気にせず fitExtent に使える） */
function fitBox([[w, s], [e, n]]) {
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const lon = w + ((e - w) * i) / 8;
    const lat = s + ((n - s) * i) / 8;
    pts.push([lon, s], [lon, n], [w, lat], [e, lat]);
  }
  return { type: "MultiPoint", coordinates: pts };
}

function areaCenter(a, geom) {
  return a.type === "disc" ? a.center : d3.geoCentroid(geom);
}

async function loadStage(meta) {
  if (cache.has(meta.id)) return cache.get(meta.id);
  const stage = await fetch(`data/${meta.file}`).then((r) => r.json());
  const units = await fetch(`data/${stage.units}`).then((r) => r.json());
  const byId = new Map();
  for (const f of units.features) {
    fixWinding(f.geometry);
    f.centroid = d3.geoCentroid(f);
    f.area = d3.geoArea(f);
    byId.set(f.id, f);
  }
  stage.unitList = units.features;
  stage.unitById = byId;
  stage.allUnits = { type: "FeatureCollection", features: units.features };
  stage.fitTarget = stage.fit ? fitBox(stage.fit) : stage.allUnits;
  stage.keyframes.sort((a, b) => a.year - b.year);
  for (const k of stage.keyframes) {
    // borders を書いていない場面は、今の境で塗る勢力があるときだけ境を描く
    if (typeof k.borders !== "boolean") k.borders = k.polities.some((p) => p.units?.length);
    for (const p of k.polities) {
      const feats = (p.units ?? []).map((id) => byId.get(id)).filter(Boolean);
      p.unitGeom = feats.length ? { type: "GeometryCollection", geometries: feats.map((f) => f.geometry) } : null;
      p.areaGeoms = (p.areas ?? []).map(areaGeometry);
      p.labelAt = p.label ?? labelPoint(feats, p);
      p.weight = feats.reduce((s, f) => s + f.area, 0) + p.areaGeoms.reduce((s, g) => s + d3.geoArea(g), 0);
    }
  }
  cache.set(meta.id, stage);
  return stage;
}

function labelPoint(feats, p) {
  if (feats.length) {
    // 面積で重みをつけた、都道府県・国の中心の平均
    let sx = 0, sy = 0, sw = 0;
    for (const f of feats) { sx += f.centroid[0] * f.area; sy += f.centroid[1] * f.area; sw += f.area; }
    const avg = [sx / sw, sy / sw];
    // 離れた植民地などで平均がほかの国の上に落ちたら、いちばん広い部分の中心を使う
    if (feats.some((f) => d3.geoContains(f, avg))) return avg;
    return feats.reduce((a, b) => (b.area > a.area ? b : a)).centroid;
  }
  if (p.areas?.length) return areaCenter(p.areas[0], p.areaGeoms[0]);
  return null;
}

// ---------- 色 ----------
function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function isDark() {
  return document.documentElement.dataset.theme === "dark";
}
function landColor(hex) {
  if (!isDark()) return hex;
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const k = 0.62;
  const f = (x) => Math.round(x * k * 255).toString(16).padStart(2, "0");
  return `#${f(r)}${f(g)}${f(b)}`;
}
const baseLand = () => (isDark() ? "#4a433b" : "#ebe4d6");

// ---------- 投影 ----------
function viewSize() {
  return [viewport.clientWidth, viewport.clientHeight];
}

function setupProjection() {
  const [w, h] = viewSize();
  const st = state.stage;
  // 地域全体が収まる大きさは、地域と画面の大きさが変わったときだけ計算する（回すたびに大きさが変わらないように）
  const key = `${st.id}:${w}x${h}`;
  if (fit.key !== key) {
    const p = d3.geoOrthographic().clipAngle(90).rotate([-st.center[0], -st.center[1]]);
    const pad = Math.max(24, Math.min(w, h) * 0.06);
    p.fitExtent([[pad, pad + 40], [w - pad, h - pad - 40]], st.fitTarget);
    fit = { key, scale: p.scale(), translate: p.translate() };
  }
  projection = d3.geoOrthographic().clipAngle(90)
    .rotate([-state.center[0], -state.center[1]])
    .scale(fit.scale * state.zoom)
    .translate(fit.translate);
}

// ---------- 描画 ----------
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const st = state.stage;
  if (!st || !state.frame) return;
  const [w, h] = viewSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  setupProjection();
  const path = d3.geoPath(projection, ctx);
  const fr = state.frame;
  const shown = fr.B && fr.f >= 0.5 ? fr.B : fr.A; // 境・印は、半分をこえたら次の地図のもの
  const borders = shown.borders;

  // 海と緯線・経線
  ctx.beginPath();
  path({ type: "Sphere" });
  ctx.fillStyle = css("--ocean");
  ctx.fill();
  if (state.opts.grid) {
    ctx.beginPath();
    path(d3.geoGraticule().step([10, 10])());
    ctx.strokeStyle = css("--grid");
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  // 土台の陸地（今の国・都道府県）。borders が false のときは境を描かない
  const base = new Path2D();
  d3.geoPath(projection, base)(st.allUnits);
  ctx.fillStyle = baseLand();
  ctx.fill(base);
  if (borders) {
    ctx.strokeStyle = css("--line-strong");
    ctx.lineWidth = 0.6;
    ctx.stroke(base);
  }

  if (fr.B) {
    // 2 枚の地図のあいだ: 少しずつ塗りかえる
    polityPaths = drawTransition(fr, borders);
  } else {
    // 1 枚の地図。なめらか表示を切っているときは、切りかえを短くうすく重ねる
    let t = 1;
    if (fade) {
      t = Math.min(1, (performance.now() - fade.start) / FADE_MS);
      if (t < 1) {
        drawPolities(fade.from, borders, 1, false);
        requestRender();
      } else fade = null;
    }
    polityPaths = drawPolities(fr.A, borders, t, true);
  }

  // 球の縁
  ctx.beginPath();
  path({ type: "Sphere" });
  ctx.strokeStyle = css("--line-strong");
  ctx.lineWidth = 1;
  ctx.stroke();

  drawMarkers(shown);
  if (state.opts.labels) drawLabels(fr.B ? transitionLabels(fr) : staticLabels(fr.A), shown);
}

function fillUnits(p2d, color, alpha, borders) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill(p2d);
  if (borders) {
    ctx.globalAlpha = alpha * 0.5;
    ctx.strokeStyle = css("--ink");
    ctx.lineWidth = 0.5;
    ctx.stroke(p2d);
  }
  ctx.globalAlpha = 1;
}

function fillAreas(geoms, color, alpha) {
  const p2d = new Path2D();
  d3.geoPath(projection, p2d)({ type: "GeometryCollection", geometries: geoms });
  ctx.globalAlpha = alpha * 0.72;
  ctx.fillStyle = color;
  ctx.fill(p2d);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke(p2d);
  ctx.globalAlpha = 1;
  return p2d;
}

function outlineSelected(out, alpha) {
  const hit = out.find((o) => o.name === state.selected);
  if (!hit) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = css("--accent");
  ctx.lineWidth = 1.6;
  for (const p2d of hit.paths) ctx.stroke(p2d);
  ctx.globalAlpha = 1;
}

function drawPolities(kf, borders, alpha, current) {
  const out = [];
  const sel = current ? state.selected : null;
  const dim = sel !== null && kf.polities.some((p) => p.name === sel);
  for (const p of kf.polities) {
    const k = dim && p.name !== sel ? 0.3 : 1;
    const paths = [];
    const color = landColor(p.color);
    if (p.unitGeom) {
      const p2d = new Path2D();
      d3.geoPath(projection, p2d)(p.unitGeom);
      fillUnits(p2d, color, alpha * k, borders);
      paths.push(p2d);
    }
    if (p.areaGeoms.length) paths.push(fillAreas(p.areaGeoms, color, alpha * k));
    out.push({ name: p.name, paths });
  }
  if (dim) outlineSelected(out, alpha);
  return out;
}

// 2 枚の地図のあいだの計画（ID ごとのしきい値）は、組ごとに 1 回だけ計算する
const planCache = new WeakMap();
function transitionPlan(A, B) {
  const hit = planCache.get(A);
  if (hit && hit.B === B) return hit.plan;
  const byId = state.stage.unitById;
  const plan = planTransition(A, B, { unitCenter: (id) => byId.get(id).centroid, distance: d3.geoDistance });
  planCache.set(A, { B, plan });
  return plan;
}

const onlyA = (f) => 1 - smoothstep(f, 0.35, 0.9);
const onlyB = (f) => smoothstep(f, 0.1, 0.65);

function drawTransition({ A, B, f, t }, borders) {
  const st = state.stage;
  const plan = transitionPlan(A, B);
  const shown = f >= 0.5 ? B : A;
  const sel = state.selected;
  const dim = sel !== null && shown.polities.some((p) => p.name === sel);
  const base = baseLand();
  const paths = new Map(); // 名前 → Path2D[]（クリックで選ぶため）
  const addPath = (name, p2d) => { if (!paths.has(name)) paths.set(name, []); paths.get(name).push(p2d); };

  // 今の国・都道府県の単位: 持ち主が変わるものは、しきい値のまわりで色を混ぜて塗りかえる
  const groups = new Map(); // 名前|色 → { name, color, geoms }
  for (const [id, e] of plan) {
    const u = st.unitById.get(id);
    if (!u) continue;
    let color, owner;
    if (e.theta === null) {
      color = mixHex(landColor(e.from.color), landColor(e.to.color), f);
      owner = e.to;
    } else {
      const w = unitWeight(e, f, t);
      color = mixHex(e.from ? landColor(e.from.color) : base, e.to ? landColor(e.to.color) : base, w);
      owner = w >= 0.5 ? e.to : e.from;
    }
    const name = owner ? owner.name : null;
    if (name === null && color === base) continue;
    const key = `${name}|${color}`;
    if (!groups.has(key)) groups.set(key, { name, color, geoms: [] });
    groups.get(key).geoms.push(u.geometry);
  }
  for (const g of groups.values()) {
    const p2d = new Path2D();
    d3.geoPath(projection, p2d)({ type: "GeometryCollection", geometries: g.geoms });
    fillUnits(p2d, g.color, dim && g.name !== sel ? 0.3 : 1, borders);
    if (g.name !== null) addPath(g.name, p2d);
  }

  // 昔の国のおおよその範囲（areas）: 同じ名前どうしは形を少しずつ変え、片方にしかないものはうすくして消す・出す
  const bByName = new Map(B.polities.map((p) => [p.name, p]));
  const aNames = new Set(A.polities.map((p) => p.name));
  const k = (name) => (dim && name !== sel ? 0.3 : 1);
  for (const pa of A.polities) {
    const pb = bByName.get(pa.name);
    const ca = landColor(pa.color);
    if (pb && areasMorphable(pa.areas ?? [], pb.areas ?? [])) {
      const geoms = pa.areas.map((a, i) => areaGeometry(lerpArea(a, pb.areas[i], f)));
      addPath(pa.name, fillAreas(geoms, mixHex(ca, landColor(pb.color), f), k(pa.name)));
      continue;
    }
    if (pa.areaGeoms.length) {
      const p2d = fillAreas(pa.areaGeoms, ca, (pb ? 1 - f : onlyA(f)) * k(pa.name));
      if (f < 0.5) addPath(pa.name, p2d);
    }
    if (pb && pb.areaGeoms.length) {
      const p2d = fillAreas(pb.areaGeoms, landColor(pb.color), f * k(pb.name));
      if (f >= 0.5) addPath(pb.name, p2d);
    }
  }
  for (const pb of B.polities) {
    if (aNames.has(pb.name) || !pb.areaGeoms.length) continue;
    const p2d = fillAreas(pb.areaGeoms, landColor(pb.color), onlyB(f) * k(pb.name));
    if (f >= 0.5) addPath(pb.name, p2d);
  }

  const out = [...paths].map(([name, ps]) => ({ name, paths: ps }));
  if (dim) outlineSelected(out, 1);
  return out;
}

function visible(lonLat) {
  return d3.geoDistance(lonLat, state.center) < Math.PI / 2 - 0.05;
}

function haloText(text, x, y) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = css("--label-halo");
  ctx.strokeText(text, x, y);
  ctx.fillStyle = css("--label");
  ctx.fillText(text, x, y);
}

function drawMarkers(kf) {
  if (!kf.markers) return;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.font = `600 12px ${css("--sans")}`;
  for (const m of kf.markers) {
    if (!visible(m.at)) continue;
    const xy = projection(m.at);
    if (!xy) continue;
    ctx.beginPath();
    ctx.arc(xy[0], xy[1], 3.5, 0, 2 * Math.PI);
    ctx.fillStyle = css("--ink");
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = css("--label-halo");
    ctx.stroke();
    haloText(m.name, xy[0] + 7, xy[1]);
  }
}

/** 1 枚の地図の名前: [{ name, at, weight }] */
function staticLabels(kf) {
  return kf.polities.map((p) => ({ name: p.name, at: p.labelAt, weight: p.weight }));
}

/** 2 枚のあいだの名前。同じ名前は位置を動かし、片方にしかない名前は、その勢力が半分より濃いあいだだけ出す */
function transitionLabels({ A, B, f }) {
  const items = [];
  const bByName = new Map(B.polities.map((p) => [p.name, p]));
  const aNames = new Set(A.polities.map((p) => p.name));
  for (const pa of A.polities) {
    const pb = bByName.get(pa.name);
    if (pb) {
      const at = pa.labelAt && pb.labelAt ? lerpPoint(pa.labelAt, pb.labelAt, f) : pb.labelAt ?? pa.labelAt;
      items.push({ name: pa.name, at, weight: f < 0.5 ? pa.weight : pb.weight });
    } else if (onlyA(f) > 0.5) items.push({ name: pa.name, at: pa.labelAt, weight: pa.weight });
  }
  for (const pb of B.polities) {
    if (!aNames.has(pb.name) && onlyB(f) > 0.5) items.push({ name: pb.name, at: pb.labelAt, weight: pb.weight });
  }
  return items;
}

function drawLabels(items, shown) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const placed = [];
  const sel = state.selected;
  const onlySel = sel !== null && shown.polities.some((q) => q.name === sel);
  // 大きい勢力から置き、重なる名前は省く（選んだものは必ず出す）
  const order = [...items].sort((a, b) => (b.name === sel) - (a.name === sel) || b.weight - a.weight);
  for (const p of order) {
    if (!p.at || !visible(p.at)) continue;
    if (onlySel && p.name !== sel) continue;
    const xy = projection(p.at);
    if (!xy) continue;
    const size = p.weight > 0.002 ? 13 : 12;
    ctx.font = `600 ${size}px ${css("--serif")}`;
    const wText = ctx.measureText(p.name).width;
    const box = [xy[0] - wText / 2 - 2, xy[1] - size / 2 - 2, xy[0] + wText / 2 + 2, xy[1] + size / 2 + 2];
    if (p.name !== sel && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    haloText(p.name, xy[0], xy[1]);
  }
}

// ---------- 年代と画面の文字 ----------
/** 年 y の地図: A（y 以下でいちばん新しい場面）と、変化の途中なら B と進み具合 f */
function frameAt(y) {
  const ks = state.stage.keyframes;
  const A = keyframeAt(ks, y);
  const B = ks[ks.indexOf(A) + 1];
  if (!state.opts.smooth || !B || y < A.year) return { A, B: null, f: 0, t: y };
  const f = progress(y, A.year, B.year, B.changeWindow);
  // since で年が決まっている ID は、changeWindow の外でもその年に塗りかわる
  const pins = pinActivity(transitionPlan(A, B), y);
  if (f <= 0 && !pins.active) return { A, B: null, f: 0, t: y };
  if (f >= 1 && pins.done) return { A: B, B: null, f: 0, t: y }; // 変化が終わったら、次の地図そのもの
  return { A, B, f, t: y };
}

function setYear(y, { fromTimeline = false } = {}) {
  const [min, max] = state.stage.range;
  state.year = Math.max(min, Math.min(max, y));
  if (!fromTimeline && timeline) timeline.set(state.year, { silent: true });
  state.frame = frameAt(state.year);
  const fr = state.frame;
  // 題名・右の欄・一覧は、変化が半分をこえたら次の地図に切りかえる
  const kf = fr.B && fr.f >= 0.5 ? fr.B : fr.A;
  if (kf !== currentKf) {
    if (currentKf && !fr.B && !state.opts.smooth && !reduceMotion) fade = { from: currentKf, start: performance.now() };
    else fade = null;
    currentKf = kf;
    if (state.selected !== null && !kf.polities.some((p) => p.name === state.selected)) state.selected = null;
    updateKeyframeText();
    buildLegend();
  }
  updateYearText();
  requestRender();
  scheduleUrl();
}

const LEVEL_TEXT = {
  3: "<b>LEVEL 3</b>資料がよく一致しています。",
  2: "<b>LEVEL 2</b>おおまかには一致していますが、境は大ざっぱです。",
  1: "<b>LEVEL 1</b>場所も範囲も推定です。ひとつの考え方として見てください。",
};

function updateYearText() {
  const fr = state.frame;
  $("#age-label").textContent = formatYear(state.year);
  $("#map-year").textContent = fr.B
    ? `${formatYear(fr.A.year)} の地図 → ${formatYear(fr.B.year)} の地図へ変化中（なめらかに描いています）`
    : `この地図は ${formatYear(fr.A.year)} ごろ`;
  // つまみの年に近いできごと（範囲の 2%、少なくとも 3 年）を強調する
  const [min, max] = state.stage.range;
  const win = Math.max(3, (max - min) * 0.02);
  for (const li of $("#events").children) {
    li.classList.toggle("now", Math.abs(Number(li.dataset.year) - state.year) <= win);
  }
}

function updateKeyframeText() {
  const kf = currentKf;
  $("#period-label").innerHTML = "";
  const b = document.createElement("b");
  b.textContent = kf.title;
  $("#period-label").append(b);
  const h2 = $("#period-name");
  h2.textContent = kf.title;
  const small = document.createElement("small");
  small.textContent = formatYear(kf.year);
  h2.append(small);
  $("#period-summary").textContent = kf.summary;
  const c = $("#certainty");
  c.dataset.level = kf.level;
  c.innerHTML = LEVEL_TEXT[kf.level] ?? "";
  $("#source").textContent = kf.source ?? "";
}

function buildEvents() {
  const ul = $("#events");
  ul.replaceChildren();
  for (const ev of [...state.stage.events].sort((a, b) => a.year - b.year)) {
    const li = document.createElement("li");
    li.dataset.year = ev.year;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = formatYear(ev.year);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = ev.title;
    if (ev.text) {
      const t = document.createElement("span");
      t.className = "text";
      t.textContent = ev.text;
      btn.append(t);
    }
    btn.addEventListener("click", () => setYear(ev.year));
    li.append(when, btn);
    ul.append(li);
  }
}

const LEGEND_MAX = 8; // これより多い場面では、地図の上の一覧をたたんでおく

function polityButton(p) {
  const b = document.createElement("button");
  b.type = "button";
  const sw = document.createElement("i");
  sw.style.setProperty("--c", p.color);
  b.append(sw, p.name);
  b.dataset.name = p.name;
  b.setAttribute("aria-pressed", String(state.selected === p.name));
  b.addEventListener("click", () => select(state.selected === p.name ? null : p.name));
  return b;
}

function buildLegend() {
  const ps = currentKf.polities;
  // 地図の上の一覧
  const legend = $("#legend");
  legend.replaceChildren();
  const many = ps.length > LEGEND_MAX;
  legend.classList.toggle("collapsible", many);
  if (many) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "legend-toggle";
    toggle.textContent = `勢力の一覧（${ps.length}）`;
    toggle.setAttribute("aria-controls", "legend-list");
    const list = document.createElement("div");
    list.className = "legend-list";
    list.id = "legend-list";
    list.append(...ps.map(polityButton));
    const sync = () => {
      toggle.setAttribute("aria-expanded", String(state.legendOpen));
      list.hidden = !state.legendOpen;
      legend.classList.toggle("open", state.legendOpen);
    };
    toggle.addEventListener("click", () => { state.legendOpen = !state.legendOpen; sync(); });
    sync();
    legend.append(toggle, list);
  } else {
    legend.append(...ps.map(polityButton));
  }
  // 右の欄の一覧（いつも出す）
  const ul = $("#polity-list");
  ul.replaceChildren();
  for (const p of ps) {
    const li = document.createElement("li");
    li.append(polityButton(p));
    ul.append(li);
  }
}

function select(name) {
  state.selected = name;
  for (const b of document.querySelectorAll("#legend [data-name], #polity-list [data-name]")) b.setAttribute("aria-pressed", String(b.dataset.name === name));
  requestRender();
}

function buildStageButtons() {
  const box = $("#regions");
  box.replaceChildren();
  for (const s of stages) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.name;
    b.dataset.id = s.id;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => { if (state.stage?.id !== s.id) setStage(s.id); }); // 選んでいる地域をもう一度押しても何もしない
    box.append(b);
  }
}

function makeTimeline() {
  const st = state.stage;
  scale = makeScale(st.track);
  // つまみの年表は地域ごとに作りなおす（古い SVG は捨てる）
  const old = $("#timeline");
  const svg = old.cloneNode(false);
  old.replaceWith(svg);
  timeline = createTimeline(svg, {
    eras: [],
    periods: st.eras,
    events: st.events,
    scale: {
      min: st.range[0], max: st.range[1], step: 10, // つまみに合わせて ← → で 10 年、Shift で 100 年
      toTrack: scale.toTrack, toValue: scale.toValue, format: formatYear,
      ticks: st.ticks.map((t) => ({ value: t, label: shortYear(t) })),
    },
    onChange: (y) => setYear(y, { fromTimeline: true }),
  });
}

let loadingStage = 0;
async function setStage(id, year) {
  const meta = stages.find((s) => s.id === id) || stages[0];
  const token = ++loadingStage;
  for (const b of $("#regions").children) b.setAttribute("aria-pressed", String(b.dataset.id === meta.id));
  const st = await loadStage(meta);
  if (token !== loadingStage) return;
  stopPlay();
  state.stage = st;
  state.center = [...st.center];
  state.zoom = 1;
  state.selected = null;
  state.legendOpen = false;
  currentKf = null;
  fade = null;
  $("#region-note").textContent = st._きまり ?? "";
  buildEvents();
  makeTimeline();
  const y = Number.isFinite(year) ? year : st.range[1];
  setYear(y);
}

// ---------- 操作 ----------
function setupPointer() {
  let drag = null;
  const pointers = new Map();
  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    drag = { x: ev.clientX, y: ev.clientY, moved: 0, pinch: null };
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag || !projection) return;
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (drag.pinch) {
        state.zoom = Math.max(1, Math.min(8, state.zoom * (dist / drag.pinch)));
        requestRender();
      }
      drag.pinch = dist;
      drag.moved += 10;
      return;
    }
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    const k = (180 / Math.PI) / projection.scale();
    state.center[0] -= dx * k;
    state.center[1] = Math.max(-89.9, Math.min(89.9, state.center[1] + dy * k));
    requestRender();
  });
  const up = (ev) => {
    pointers.delete(ev.pointerId);
    if (!drag) return;
    if (pointers.size === 1) {
      // ピンチのあと 1 本の指が残ったら、その指の位置から動かしはじめる（はねないように）
      const [x, y] = [...pointers.values()][0];
      drag.x = x;
      drag.y = y;
      drag.pinch = null;
    }
    if (drag.moved < 4 && pointers.size === 0) pick(ev);
    if (pointers.size === 0) {
      drag = null;
      canvas.classList.remove("dragging");
    }
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    state.zoom = Math.max(1, Math.min(8, state.zoom * Math.exp(-ev.deltaY * 0.0015)));
    requestRender();
  }, { passive: false });
  canvas.addEventListener("dblclick", resetView);
}

function resetView() {
  if (!state.stage) return;
  state.center = [...state.stage.center];
  state.zoom = 1;
  requestRender();
}

function pick(ev) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const x = (ev.clientX - r.left) * dpr;
  const y = (ev.clientY - r.top) * dpr;
  let hit = null;
  // 後から描いたもの（上にあるもの）を優先する
  for (const o of polityPaths) for (const p2d of o.paths) if (ctx.isPointInPath(p2d, x, y)) hit = o.name;
  select(hit === state.selected ? null : hit);
}

// 再生中は年のバッジを読み上げない（読み上げが追いつかないため）。止めたら戻す
const badge = () => document.querySelector(".age-badge");

function stopPlay() {
  state.playing = false;
  badge().setAttribute("aria-live", "polite");
  const playBtn = $("#play");
  playBtn.textContent = "▶ 再生";
  playBtn.setAttribute("aria-pressed", "false");
}

function startPlay() {
  if (!state.stage) return;
  if (state.year >= state.stage.range[1]) setYear(state.stage.range[0]);
  state.playing = true;
  badge().removeAttribute("aria-live");
  const playBtn = $("#play");
  playBtn.textContent = "❚❚ 停止";
  playBtn.setAttribute("aria-pressed", "true");
  let last = performance.now();
  let t = scale.toTrack(state.year);
  const tick = (ts) => {
    if (!state.playing) return;
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    t = Math.min(1, t + state.speed * dt);
    setYear(scale.toValue(t));
    if (t >= 1) { stopPlay(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setupControls() {
  $("#play").addEventListener("click", () => (state.playing ? stopPlay() : startPlay()));
  $("#step-back").addEventListener("click", () => setYear(Math.round(state.year) - 50));
  $("#step-fwd").addEventListener("click", () => setYear(Math.round(state.year) + 50));
  $("#rewind").addEventListener("click", () => { stopPlay(); setYear(state.stage.range[0]); });
  for (const b of document.querySelectorAll(".speed button")) {
    b.addEventListener("click", () => {
      state.speed = Number(b.dataset.speed);
      for (const o of document.querySelectorAll(".speed button")) o.setAttribute("aria-pressed", String(o === b));
    });
  }
  $("#zoom-in").addEventListener("click", () => { state.zoom = Math.min(8, state.zoom * 1.4); requestRender(); });
  $("#zoom-out").addEventListener("click", () => { state.zoom = Math.max(1, state.zoom / 1.4); requestRender(); });
  $("#reset-view").addEventListener("click", resetView);
  for (const key of Object.keys(state.opts)) {
    const cb = $(`#opt-${key}`);
    cb.checked = state.opts[key];
    cb.addEventListener("change", () => {
      state.opts[key] = cb.checked;
      if (key === "smooth" && state.stage) setYear(state.year);
      requestRender();
    });
  }
  $("#copy-link").addEventListener("click", async () => {
    const url = buildUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast("リンクをコピーしました");
    } catch {
      toast(url);
    }
  });
  window.addEventListener("keydown", (ev) => {
    const t = ev.target;
    if (!state.stage) return;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.closest?.("#timeline"))) return;
    // ボタンを押したあとも ← → で年を動かせる。Space はボタンを押す操作なので、ボタンにいるときは使わない
    if (ev.key === " " && t?.tagName !== "BUTTON") { ev.preventDefault(); state.playing ? stopPlay() : startPlay(); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); setYear(Math.round(state.year) - (ev.shiftKey ? 100 : 10)); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); setYear(Math.round(state.year) + (ev.shiftKey ? 100 : 10)); }
  });
  const themeBtn = $("#theme-toggle");
  const syncTheme = () => {
    const dark = isDark();
    themeBtn.setAttribute("aria-pressed", String(dark));
    themeBtn.setAttribute("aria-label", dark ? "ライトモードに切り替え" : "ダークモードに切り替え");
  };
  themeBtn.addEventListener("click", () => {
    const dark = !isDark();
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch { /* 保存できなくてもよい */ }
    syncTheme();
    requestRender();
  });
  syncTheme();
  new ResizeObserver(requestRender).observe(viewport);
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- URL ----------
function buildUrl() {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  if (state.stage) {
    u.searchParams.set("stage", state.stage.id);
    u.searchParams.set("year", String(Math.round(state.year)));
  }
  return u.toString();
}
let urlTimer;
function scheduleUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => history.replaceState(null, "", buildUrl()), 400);
}

// ---------- 起動 ----------
async function main() {
  const q = new URLSearchParams(location.search);
  try {
    stages = (await fetch("data/stages.json").then((r) => r.json())).stages;
    buildStageButtons();
    setupPointer();
    setupControls();
    const y = q.has("year") ? Number(q.get("year")) : NaN;
    await setStage(q.get("stage") || stages[0].id, y);
  } catch (e) {
    viewport.innerHTML = `<div class="failure">データを読み込めませんでした。ページを開き直してください。<br><small></small></div>`;
    viewport.querySelector("small").textContent = e.message;
    throw e;
  }
}

main();
