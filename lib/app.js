// うごく世界地図 — 画面の組み立て。計算は geo.js、年表は timeline.js。
import { Rotations, pieceRotation, pieceState, formatAge, periodAt, ageToTrack, trackToAge } from "./geo.js";
import { createTimeline } from "./timeline.js";

const $ = (s) => document.querySelector(s);
const RAD = Math.PI / 180;
const viewport = $("#viewport");
const canvas = $("#map");
const ctx = canvas.getContext("2d");

const state = {
  age: 0,
  maxAge: 1000,
  region: null,
  zoom: 1,
  offset: [0, 0], // 追いかけ表示のときの、ユーザーのドラッグ分
  globe: [20, 15], // 追いかけないときの地球儀の中心
  mapCenter: 0, // 世界地図の中央経度
  selected: null,
  playing: false,
  speed: 15,
  opts: { today: false, labels: true, grid: true, ghost: true },
};

let data; // { pieces, rot, events, regions, groups }
let projection;
let geoPath;
let groupPaths = new Map();
let timeline;
let renderQueued = false;

// ---------- 読み込み ----------
async function load() {
  const [pieces, meta, bin, events, regions, continents] = await Promise.all([
    fetch("data/pieces.json").then((r) => r.json()),
    fetch("data/rotations.json").then((r) => r.json()),
    fetch("data/rotations.bin").then((r) => r.arrayBuffer()),
    fetch("data/events.json").then((r) => r.json()),
    fetch("data/regions.json").then((r) => r.json()),
    fetch("data/continents.json").then((r) => r.json()),
  ]);
  const rot = new Rotations(meta, new Int16Array(bin));
  const groups = new Map(continents.groups.map((g) => [g.id, g]));
  for (const p of pieces.pieces) {
    // ちょうど ±180° や ±90° に乗った点があると、回転していない（現在の）地図で d3 の
    // 切り抜きが裏返ることがあるので、ほんの少し内側へずらす
    for (const pt of p.ring) {
      if (Math.abs(pt[0]) >= 180) pt[0] = Math.sign(pt[0]) * 179.9999;
      if (Math.abs(pt[1]) >= 90) pt[1] = Math.sign(pt[1]) * 89.9999;
    }
    // d3 は外側の輪が時計回り（球面で）であることを前提にする。逆なら裏返す
    if (d3.geoArea({ type: "Polygon", coordinates: [p.ring] }) > 2 * Math.PI) p.ring.reverse();
    const n = p.ring.length;
    p.vecs = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const lo = p.ring[i][0] * RAD;
      const la = p.ring[i][1] * RAD;
      const c = Math.cos(la);
      p.vecs[i * 3] = c * Math.cos(lo);
      p.vecs[i * 3 + 1] = c * Math.sin(lo);
      p.vecs[i * 3 + 2] = Math.sin(la);
    }
    p.out = p.ring.map(() => [0, 0]);
    p.geo = { type: "Polygon", coordinates: [p.out] };
    p.today = { type: "Polygon", coordinates: [p.ring] };
  }
  // 名前の位置を、その場所の陸片に結びつける
  for (const g of continents.groups) {
    for (const lb of g.labels) lb.host = hostPiece(pieces.pieces, lb.at);
  }
  for (const r of regions.regions) {
    if (r.center) r.host = hostPiece(pieces.pieces, r.center);
  }
  data = { pieces: pieces.pieces, rot, maxAge: pieces.maxAge, ...events, regions: regions.regions, groups, groupList: continents.groups, model: pieces.model };
  state.maxAge = pieces.maxAge;
}

function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[j];
    if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
  }
  return inside;
}

function hostPiece(pieces, [lon, lat]) {
  let best = null;
  for (const p of pieces) if (pointInRing(p.ring, lon, lat) && (!best || p.area < best.area)) best = p;
  if (best) return best;
  let bd = Infinity;
  for (const p of pieces) {
    const d = d3.geoDistance([lon, lat], p.rep);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/** 陸片に乗って動く、今の地点の位置（経度・緯度） */
function movedPoint(host, lonLat, age) {
  const q = pieceRotation(host, data.rot, Math.min(age, host.until));
  const lo = lonLat[0] * RAD;
  const la = lonLat[1] * RAD;
  const c = Math.cos(la);
  const v = rotateVec(q, c * Math.cos(lo), c * Math.sin(lo), Math.sin(la));
  return [Math.atan2(v[1], v[0]) / RAD, Math.asin(Math.max(-1, Math.min(1, v[2]))) / RAD];
}

function rotateVec(q, vx, vy, vz) {
  const w = q[0], ux = q[1], uy = q[2], uz = q[3];
  const tx = 2 * (uy * vz - uz * vy);
  const ty = 2 * (uz * vx - ux * vz);
  const tz = 2 * (ux * vy - uy * vx);
  return [vx + w * tx + (uy * tz - uz * ty), vy + w * ty + (uz * tx - ux * tz), vz + w * tz + (ux * ty - uy * tx)];
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

// ---------- 投影 ----------
function viewSize() {
  return [viewport.clientWidth, viewport.clientHeight];
}

function globeCenter() {
  const r = state.region;
  if (r && r.follow && r.host) {
    const c = movedPoint(r.host, r.center, state.age);
    return [c[0] + state.offset[0], Math.max(-89.9, Math.min(89.9, c[1] + state.offset[1]))];
  }
  return state.globe;
}

function setupProjection() {
  const [w, h] = viewSize();
  const pad = 10;
  if (!state.region || state.region.view === "map") {
    projection = d3.geoEqualEarth().rotate([-state.mapCenter, 0]);
    projection.fitExtent([[pad, pad + 8], [w - pad, h - pad - 8]], { type: "Sphere" });
  } else {
    const c = globeCenter();
    projection = d3.geoOrthographic().clipAngle(90).rotate([-c[0], -c[1]]);
    projection.fitExtent([[pad, pad], [w - pad, h - pad]], { type: "Sphere" });
    projection.scale(projection.scale() * state.zoom).translate([w / 2, h / 2]);
  }
  geoPath = d3.geoPath(projection, ctx);
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
  if (!data) return;
  const [w, h] = viewSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  setupProjection();
  const isGlobe = state.region && state.region.view === "globe";
  const age = state.age;
  const ink = css("--ink");

  // 海
  ctx.beginPath();
  geoPath({ type: "Sphere" });
  ctx.fillStyle = css("--ocean");
  ctx.fill();
  if (state.opts.grid) {
    ctx.beginPath();
    geoPath(d3.geoGraticule().step([30, 30])());
    ctx.strokeStyle = css("--grid");
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.beginPath();
    geoPath({ type: "LineString", coordinates: d3.range(-180, 181, 2).map((x) => [x, 0]) });
    ctx.strokeStyle = css("--equator");
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // 陸片を回して、大陸ごとにまとめる
  const solid = new Map();
  const ghost = new Map();
  for (const p of data.pieces) {
    const st = pieceState(p, age);
    if (st === "hidden" || (st === "ghost" && !state.opts.ghost)) continue;
    const q = pieceRotation(p, data.rot, age);
    const vv = p.vecs;
    const out = p.out;
    const w0 = q[0], ux = q[1], uy = q[2], uz = q[3];
    for (let i = 0, n = out.length; i < n; i++) {
      const vx = vv[i * 3], vy = vv[i * 3 + 1], vz = vv[i * 3 + 2];
      const tx = 2 * (uy * vz - uz * vy);
      const ty = 2 * (uz * vx - ux * vz);
      const tz = 2 * (ux * vy - uy * vx);
      const x = vx + w0 * tx + (uy * tz - uz * ty);
      const y = vy + w0 * ty + (uz * tx - ux * tz);
      const z = vz + w0 * tz + (ux * ty - uy * tx);
      out[i][0] = Math.atan2(y, x) / RAD;
      out[i][1] = Math.asin(z > 1 ? 1 : z < -1 ? -1 : z) / RAD;
    }
    const m = st === "ghost" ? ghost : solid;
    if (!m.has(p.group)) m.set(p.group, []);
    m.get(p.group).push(p.geo);
  }

  groupPaths = new Map();
  const dim = state.selected !== null;
  // 推定の陸地（薄く）
  for (const [gid, geos] of ghost) {
    const g = data.groups.get(gid);
    const p2d = new Path2D();
    d3.geoPath(projection, p2d)({ type: "GeometryCollection", geometries: geos });
    ctx.globalAlpha = dim && gid !== state.selected ? 0.18 : 0.38;
    ctx.fillStyle = landColor(g.color);
    ctx.fill(p2d);
    ctx.globalAlpha = dim && gid !== state.selected ? 0.25 : 0.6;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = css("--ghost-line");
    ctx.lineWidth = 0.8;
    ctx.stroke(p2d);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    groupPaths.set(gid, [p2d]);
  }
  // モデルに陸がある陸片
  for (const [gid, geos] of solid) {
    const g = data.groups.get(gid);
    const p2d = new Path2D();
    d3.geoPath(projection, p2d)({ type: "GeometryCollection", geometries: geos });
    ctx.globalAlpha = dim && gid !== state.selected ? 0.35 : 1;
    ctx.fillStyle = landColor(g.color);
    ctx.fill(p2d);
    ctx.strokeStyle = ink;
    ctx.globalAlpha = dim && gid !== state.selected ? 0.25 : 0.55;
    ctx.lineWidth = isGlobe && state.zoom > 2 ? 0.9 : 0.6;
    ctx.stroke(p2d);
    ctx.globalAlpha = 1;
    if (!groupPaths.has(gid)) groupPaths.set(gid, []);
    groupPaths.get(gid).push(p2d);
  }
  // 選んだ大陸の縁
  if (dim && groupPaths.has(state.selected)) {
    ctx.strokeStyle = css("--accent");
    ctx.lineWidth = 1.6;
    for (const p2d of groupPaths.get(state.selected)) ctx.stroke(p2d);
  }

  // 今の海岸線
  if (state.opts.today) {
    ctx.beginPath();
    for (const p of data.pieces) geoPath(p.today);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = css("--ghost-line");
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 球の縁
  ctx.beginPath();
  geoPath({ type: "Sphere" });
  ctx.strokeStyle = css("--line-strong");
  ctx.lineWidth = 1;
  ctx.stroke();

  if (state.opts.labels) drawLabels(isGlobe);
}

function drawLabels(isGlobe) {
  const center = isGlobe ? globeCenter() : null;
  const r = state.region;
  const showSmall = isGlobe && state.zoom >= 1.8;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const g of data.groupList) {
    if (state.selected !== null && g.id !== state.selected) continue;
    for (const lb of g.labels) {
      if (lb.small && !showSmall && !(r && r.id === "japan" && g.id === "japan")) continue;
      const host = lb.host;
      if (!host || pieceState(host, state.age) === "hidden") continue;
      const pos = movedPoint(host, lb.at, state.age);
      if (isGlobe && d3.geoDistance(pos, center) > 1.45) continue;
      const xy = projection(pos);
      if (!xy) continue;
      const size = lb.small ? 11 : 13;
      ctx.font = `600 ${size}px ${css("--serif")}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = css("--label-halo");
      ctx.strokeText(lb.name, xy[0], xy[1]);
      ctx.fillStyle = css("--label");
      ctx.fillText(lb.name, xy[0], xy[1]);
    }
  }
}

// ---------- 年代と画面の文字 ----------
function setAge(a, { fromTimeline = false } = {}) {
  state.age = Math.max(0, Math.min(state.maxAge, a));
  if (!fromTimeline && timeline) timeline.set(state.age, { silent: true });
  updateText();
  requestRender();
  scheduleUrl();
}

function ruby(name, kana) {
  return kana ? `<ruby>${name}<rt>${kana}</rt></ruby>` : name;
}

let lastPeriod = null;
function updateText() {
  const age = state.age;
  $("#age-label").textContent = formatAge(age);
  const p = periodAt(data.periods, age);
  if (p !== lastPeriod) {
    lastPeriod = p;
    $("#period-label").innerHTML = p ? `<b>${ruby(p.name, p.kana)}</b><span class="era">${p.era}</span>` : "";
    $("#period-name").innerHTML = p ? `${ruby(p.name, p.kana)}<small>${p.era}</small>` : "—";
    $("#period-summary").textContent = p ? p.summary : "";
  }
  const win = Math.max(2, age * 0.03);
  for (const li of $("#events").children) {
    const a = Number(li.dataset.age);
    li.classList.toggle("now", Math.abs(a - age) <= win);
  }
  const c = $("#certainty");
  const level = age <= 250 ? 3 : age <= 540 ? 2 : 1;
  c.dataset.level = level;
  c.innerHTML = level === 3
    ? "<b>LEVEL 3</b>研究者のあいだで大陸の位置がよく一致している時代です。"
    : level === 2
      ? "<b>LEVEL 2</b>おおまかな位置は一致していますが、細かい位置は資料によってちがいます。"
      : "<b>LEVEL 1</b>5億年より昔は、資料によって大陸の位置が大きくちがいます。ひとつの考え方として見てください。";
}

function buildEvents() {
  const ul = $("#events");
  ul.replaceChildren();
  for (const ev of [...data.events].sort((a, b) => b.age - a.age)) {
    const li = document.createElement("li");
    li.dataset.age = ev.age;
    li.innerHTML = `<span class="when">${formatAge(ev.age)}</span><button type="button">${ev.title}<span class="text">${ev.text}</span></button>`;
    li.querySelector("button").addEventListener("click", () => setAge(ev.age));
    ul.append(li);
  }
}

function buildLegend() {
  const legend = $("#legend");
  legend.replaceChildren();
  for (const g of data.groupList) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<i style="--c:${g.color}"></i>${g.name}`;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => select(state.selected === g.id ? null : g.id));
    b.dataset.group = g.id;
    legend.append(b);
  }
  const gh = document.createElement("span");
  gh.className = "ghost";
  gh.innerHTML = "<i></i>うすい陸地＝モデルにまだ無い（推定）";
  gh.id = "legend-ghost";
  legend.append(gh);
}

function select(gid) {
  state.selected = gid;
  for (const b of $("#legend").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.group === gid));
  requestRender();
}

function buildRegions() {
  const box = $("#regions");
  box.replaceChildren();
  for (const r of data.regions) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = r.name;
    b.dataset.id = r.id;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => setRegion(r.id));
    box.append(b);
  }
}

function setRegion(id) {
  const r = data.regions.find((x) => x.id === id) || data.regions[0];
  state.region = r;
  state.zoom = r.zoom || 1;
  state.offset = [0, 0];
  if (r.view === "globe" && r.center && !r.follow) state.globe = [...r.center];
  for (const b of $("#regions").children) b.setAttribute("aria-pressed", String(b.dataset.id === r.id));
  $("#region-note").textContent = r.note || "";
  $("#globe-tools").style.display = r.view === "globe" ? "" : "none";
  $("#map-note").innerHTML = r.view === "globe"
    ? (r.follow ? `<b>${r.name}</b>を追いかけています。ドラッグで少しずらせます。` : "ドラッグで回す・ホイールやピンチで拡大")
    : "ドラッグで左右にずらせます";
  requestRender();
  scheduleUrl();
}

// ---------- 操作 ----------
function setupPointer() {
  let drag = null;
  const pointers = new Map();
  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (drag && pointers.size >= 2) {
      drag.pinched = true; // 2本目の指: ピンチ。離したときに選択はしない
      drag.pinch = null;
    } else {
      drag = { x: ev.clientX, y: ev.clientY, moved: 0, pinch: null, pinched: false };
    }
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pointers.size >= 2) {
      drag.pinched = true;
      if (!(state.region && state.region.view === "globe")) return;
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (drag.pinch) {
        state.zoom = Math.max(1, Math.min(8, state.zoom * (dist / drag.pinch)));
        requestRender();
      }
      drag.pinch = dist;
      return;
    }
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    const isGlobe = state.region && state.region.view === "globe";
    // つかんだ陸地が指についてくる向き（右へ動かすと中心の経度は減る）
    if (isGlobe) {
      const k = (180 / Math.PI) / projection.scale();
      const target = state.region.follow ? state.offset : state.globe;
      target[0] -= dx * k;
      target[1] = Math.max(-89.9, Math.min(89.9, target[1] + dy * k));
    } else {
      state.mapCenter -= (dx * 360) / Math.max(1, viewSize()[0]) * 0.9;
    }
    requestRender();
  });
  const up = (ev) => {
    pointers.delete(ev.pointerId);
    if (!drag) return;
    if (drag.moved < 4 && !drag.pinched && pointers.size === 0) pick(ev);
    if (pointers.size === 0) {
      drag = null;
      canvas.classList.remove("dragging");
    }
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (ev) => {
    if (!(state.region && state.region.view === "globe")) return;
    ev.preventDefault();
    state.zoom = Math.max(1, Math.min(8, state.zoom * Math.exp(-ev.deltaY * 0.0015)));
    requestRender();
  }, { passive: false });
  canvas.addEventListener("dblclick", () => {
    state.offset = [0, 0];
    state.zoom = state.region?.zoom || 1;
    if (state.region?.view === "map") state.mapCenter = 0;
    requestRender();
  });
}

function pick(ev) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const x = (ev.clientX - r.left) * dpr;
  const y = (ev.clientY - r.top) * dpr;
  let hit = null;
  for (const [gid, paths] of groupPaths) {
    for (const p2d of paths) if (ctx.isPointInPath(p2d, x, y)) hit = gid;
  }
  select(hit === state.selected ? null : hit);
}

function setupControls() {
  const playBtn = $("#play");
  const stop = () => {
    state.playing = false;
    playBtn.textContent = "▶ 再生";
    playBtn.setAttribute("aria-pressed", "false");
  };
  const start = () => {
    if (state.age <= 0) setAge(state.maxAge);
    state.playing = true;
    playBtn.textContent = "❚❚ 停止";
    playBtn.setAttribute("aria-pressed", "true");
    let last = performance.now();
    const tick = (ts) => {
      if (!state.playing) return;
      const dt = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      setAge(state.age - state.speed * dt);
      if (state.age <= 0) { stop(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  playBtn.addEventListener("click", () => (state.playing ? stop() : start()));
  $("#step-back").addEventListener("click", () => setAge(state.age + 10));
  $("#step-fwd").addEventListener("click", () => setAge(state.age - 10));
  $("#rewind").addEventListener("click", () => { stop(); setAge(state.maxAge); });
  for (const b of document.querySelectorAll(".speed button")) {
    b.addEventListener("click", () => {
      state.speed = Number(b.dataset.speed);
      for (const o of document.querySelectorAll(".speed button")) o.setAttribute("aria-pressed", String(o === b));
    });
  }
  $("#zoom-in").addEventListener("click", () => { state.zoom = Math.min(8, state.zoom * 1.4); requestRender(); });
  $("#zoom-out").addEventListener("click", () => { state.zoom = Math.max(1, state.zoom / 1.4); requestRender(); });
  $("#reset-view").addEventListener("click", () => { state.offset = [0, 0]; state.zoom = state.region?.zoom || 1; if (state.region && !state.region.follow && state.region.center) state.globe = [...state.region.center]; requestRender(); });
  for (const key of Object.keys(state.opts)) {
    const cb = $(`#opt-${key}`);
    cb.checked = state.opts[key];
    cb.addEventListener("change", () => {
      state.opts[key] = cb.checked;
      if (key === "ghost") $("#legend-ghost").style.display = cb.checked ? "" : "none";
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
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.closest?.("#timeline"))) return;
    if (ev.key === " ") { ev.preventDefault(); state.playing ? stop() : start(); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); setAge(state.age + (ev.shiftKey ? 10 : 1)); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); setAge(state.age - (ev.shiftKey ? 10 : 1)); }
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
  if (state.age > 0) u.searchParams.set("age", String(Math.round(state.age * 10) / 10));
  if (state.region && state.region.id !== "world") u.searchParams.set("view", state.region.id);
  return u.toString();
}
let urlTimer;
function scheduleUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => history.replaceState(null, "", buildUrl()), 400);
}

// ---------- 起動 ----------
async function main() {
  try {
    await load();
  } catch (e) {
    viewport.innerHTML = `<div class="failure">データを読み込めませんでした。ページを開き直してください。<br><small>${e.message}</small></div>`;
    throw e;
  }
  buildRegions();
  buildLegend();
  buildEvents();
  setupPointer();
  setupControls();
  timeline = createTimeline($("#timeline"), {
    eras: data.eras, periods: data.periods, events: data.events,
    scale: {
      min: 0, max: state.maxAge, step: -1,
      toTrack: ageToTrack, toValue: trackToAge, format: formatAge,
      ticks: [0, 50, 100, 200, 300, 500, 750, 1000].filter((t) => t <= state.maxAge).map((t) => ({ value: t, label: t === 0 ? "現在" : t >= 100 ? `${t / 100}億` : `${t}00万` })),
    },
    onChange: (a) => setAge(a, { fromTimeline: true }),
  });
  const q = new URLSearchParams(location.search);
  setRegion(q.get("view") || "world");
  setAge(q.has("age") ? Number(q.get("age")) || 0 : 0);
}

main();
