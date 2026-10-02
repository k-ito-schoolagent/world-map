// 国の成り立ち（kuni/）のデータと年代の計算のテスト
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatYear, shortYear, makeScale, keyframeAt } from "../kuni/scale.js";
import { progress, rankThresholds, planTransition, pinActivity, ownersAt, ownerMap, unitWeight, areasMorphable, lerpArea, mixHex, normalizeName } from "../kuni/morph.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "kuni", "data");
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} ≠ ${b} (±${tol})`);

test("formatYear: 紀元前・西暦・4けた", () => {
  assert.equal(formatYear(-3000), "紀元前3000年");
  assert.equal(formatYear(-1), "紀元前1年");
  assert.equal(formatYear(0), "紀元前1年", "西暦0年は無い");
  assert.equal(formatYear(1), "西暦1年");
  assert.equal(formatYear(57), "西暦57年");
  assert.equal(formatYear(999), "西暦999年");
  assert.equal(formatYear(1000), "1000年");
  assert.equal(formatYear(2026), "2026年");
  assert.equal(formatYear(1570.3), "1570年", "年表のつまみは 0.1 きざみなので丸める");
  assert.equal(shortYear(-1000), "前1000");
  assert.equal(shortYear(1850), "1850");
});

test("makeScale: 区分線形で行き来できる", () => {
  const s = makeScale([[0, -1000], [0.18, 250], [0.42, 1200], [1, 2026]]);
  assert.equal(s.toTrack(-1000), 0);
  assert.equal(s.toTrack(2026), 1);
  near(s.toTrack(250), 0.18, 1e-12);
  near(s.toValue(0.3), 725, 1e-9);
  for (const y of [-1000, -437, 0, 250, 777, 1200, 1999, 2026]) near(s.toValue(s.toTrack(y)), y, 1e-9, `年 ${y}`);
  for (const t of [0, 0.05, 0.18, 0.5, 0.99, 1]) near(s.toTrack(s.toValue(t)), t, 1e-12, `t ${t}`);
  assert.equal(s.toTrack(-5000), 0, "範囲の外は端にそろえる");
  assert.equal(s.toValue(2), 2026);
});

test("keyframeAt: その年以下でいちばん新しい地図", () => {
  const ks = [{ year: -100 }, { year: 250 }, { year: 720 }];
  assert.equal(keyframeAt(ks, -500).year, -100, "最初より前は最初の地図");
  assert.equal(keyframeAt(ks, 249.9).year, -100);
  assert.equal(keyframeAt(ks, 250).year, 250);
  assert.equal(keyframeAt(ks, 3000).year, 720);
});

// ---------- なめらかな塗りかえ ----------
const planar = { unitCenter: (id) => CENTERS[id], distance: (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) };
const CENTERS = { a: [0, 0], b: [1, 0], c: [2, 0], d: [3, 0], e: [10, 10] };
const KA = { year: 0, polities: [{ name: "X", color: "#d98c8c", units: ["a", "b"] }, { name: "Y", color: "#7fa6d9", units: ["c", "d"] }, { name: "Z", color: "#9cb97c", units: ["e"] }] };
const KB = { year: 100, polities: [{ name: "X", color: "#e3a3a3", units: ["a", "b", "c"] }, { name: "W", color: "#8fbf7f", units: ["d"] }] };

test("progress: 両端で前の地図と次の地図にぴったり一致し、changeWindow の外は動かない", () => {
  assert.equal(progress(0, 0, 100), 0);
  assert.equal(progress(100, 0, 100), 1);
  near(progress(50, 0, 100), 0.5, 1e-12);
  assert.equal(progress(30, 0, 100, [40, 60]), 0, "窓より前は 0");
  assert.equal(progress(60, 0, 100, [40, 60]), 1, "窓の終わりで 1");
  assert.equal(progress(90, 0, 100, [40, 60]), 1, "窓のあとも 1");
  let prev = -1;
  for (let t = 0; t <= 100; t += 5) { const f = progress(t, 0, 100); assert.ok(f >= prev); prev = f; }
});

test("rankThresholds: 順位とともに増え、0 と 1 のあいだ", () => {
  assert.deepEqual(rankThresholds(1), [0.5]);
  for (const n of [2, 3, 7, 40]) {
    const th = rankThresholds(n);
    near(th[0], 0.15, 1e-12);
    near(th[n - 1], 0.85, 1e-12);
    for (let i = 0; i < n; i++) {
      assert.ok(th[i] > 0 && th[i] < 1);
      if (i) assert.ok(th[i] > th[i - 1], "順位が下がるほどあとで塗りかわる");
    }
  }
});

test("planTransition: f=0 で前の地図、f=1 で次の地図と同じ持ち主になる", () => {
  const plan = planTransition(KA, KB, planar);
  const nameMap = (kf) => new Map([...ownerMap(kf)].map(([id, p]) => [id, p.name]));
  const at0 = ownersAt(plan, 0);
  const at1 = ownersAt(plan, 1);
  for (const [id, name] of nameMap(KA)) assert.equal(at0.get(id), name, `f=0 の ${id}`);
  for (const [id, name] of nameMap(KB)) assert.equal(at1.get(id), name, `f=1 の ${id}`);
  assert.equal(at1.get("e"), null, "次の地図で持ち主がいなければ null");
  assert.equal(plan.get("a").theta, null, "同じ名前のままなら色だけ混ぜる");
  assert.equal(unitWeight(plan.get("a"), 0.3), 0.3);
  // X が c を、W が d を手に入れる（それぞれ 1 つなので 0.5）
  assert.equal(plan.get("c").theta, 0.5);
  assert.equal(plan.get("d").theta, 0.5);
});

test("planTransition: 新しい持ち主の中心に近いものから先に塗りかわる", () => {
  const C = { u1: [0, 0], u2: [5, 0], u3: [12, 0] };
  const A = { polities: [{ name: "P", units: ["u1", "u2", "u3"] }] };
  const B = { polities: [{ name: "Q", units: ["u1", "u2", "u3"] }] };
  const plan = planTransition(A, B, { unitCenter: (id) => C[id], distance: (p, q) => Math.abs(p[0] - q[0]) });
  // Q の中心は (0+5+12)/3 = 5.67 → 近い順に u2(0.67), u1(5.67), u3(6.33)
  assert.ok(plan.get("u2").theta < plan.get("u1").theta);
  assert.ok(plan.get("u1").theta < plan.get("u3").theta);
  // 失うだけのときは、元の中心から遠いものから
  const lose = planTransition(A, { polities: [] }, { unitCenter: (id) => C[id], distance: (p, q) => Math.abs(p[0] - q[0]) });
  assert.ok(lose.get("u3").theta < lose.get("u1").theta);
});

test("since の年（pin）: changeWindow と関係なく、その年に塗りかわる", () => {
  const A = { year: 1950, polities: [{ name: "植民地", units: ["a", "b"] }] };
  const B = { year: 1960, polities: [{ name: "独立国", units: ["a", "b"], since: { a: 1956 } }] };
  const C = { a: [0, 0], b: [1, 0] };
  const plan = planTransition(A, B, { unitCenter: (id) => C[id], distance: (p, q) => Math.abs(p[0] - q[0]) });
  assert.equal(plan.get("a").pin, 1956);
  assert.equal(plan.get("b").pin, null);
  // 窓がまだ始まっていなくても（f=0）、1956 年をすぎれば a は塗りかわっている
  assert.equal(unitWeight(plan.get("a"), 0, 1955), 0);
  near(unitWeight(plan.get("a"), 0, 1956), 0.5, 1e-12);
  assert.equal(unitWeight(plan.get("a"), 0, 1957), 1);
  assert.equal(ownersAt(plan, 0, 1957).get("a"), "独立国");
  assert.equal(ownersAt(plan, 0, 1957).get("b"), "植民地", "pin の無い b は窓にしたがう");
  assert.deepEqual(pinActivity(plan, 1950), { active: false, done: false });
  assert.deepEqual(pinActivity(plan, 1956), { active: true, done: false });
  assert.deepEqual(pinActivity(plan, 1957), { active: true, done: true });
});

test("areas の形を少しずつ変える・色を混ぜる", () => {
  const d1 = { type: "disc", center: [0, 0], km: 100 };
  const d2 = { type: "disc", center: [10, 20], km: 300 };
  assert.ok(areasMorphable([d1], [d2]));
  assert.ok(!areasMorphable([d1], [d1, d2]));
  assert.ok(!areasMorphable([d1], [{ type: "poly", points: [[0, 0], [1, 0], [1, 1]] }]));
  assert.deepEqual(lerpArea(d1, d2, 0.5), { type: "disc", center: [5, 10], km: 200 });
  assert.equal(mixHex("#000000", "#ffffff", 0), "#000000");
  assert.equal(mixHex("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
});

const { stages } = readJson("stages.json");

test("stages.json に地域が並んでいる", () => {
  assert.ok(stages.length >= 2);
  assert.equal(new Set(stages.map((s) => s.id)).size, stages.length, "id がかぶっていない");
});

for (const st of stages) {
  test(`${st.name}（${st.file}）のデータが正しい`, () => {
    const stage = readJson(st.file);
    assert.equal(stage.id, st.id);
    const units = readJson(stage.units);
    const ids = new Set(units.features.map((f) => f.id));
    assert.equal(ids.size, units.features.length, "土台の地図の id がかぶっていない");

    // 年代の範囲と目盛り
    const [min, max] = stage.range;
    assert.ok(min < max);
    for (let i = 1; i < stage.track.length; i++) {
      assert.ok(stage.track[i][0] > stage.track[i - 1][0], "track の t が増えていく");
      assert.ok(stage.track[i][1] > stage.track[i - 1][1], "track の年が増えていく");
    }
    const s = makeScale(stage.track);
    assert.equal(s.toTrack(min), 0, "range の左端が t=0");
    assert.equal(s.toTrack(max), 1, "range の右端が t=1");
    for (const t of stage.ticks) assert.ok(t >= min && t <= max, `目盛り ${t} が範囲内`);
    for (const e of stage.eras) {
      assert.ok(e.start < e.end, `時代 ${e.name} の start < end`);
      assert.ok(e.start >= min && e.end <= max, `時代 ${e.name} が範囲内`);
      assert.match(e.color, /^#[0-9a-f]{6}$/i);
    }

    // 最初の画面を合わせる四角（書かなくてもよい）
    if (stage.fit) {
      const [[w, so], [e, n]] = stage.fit;
      assert.ok(w < e && so < n, "fit は [[西, 南], [東, 北]]");
      assert.ok(Math.abs(w) <= 180 && Math.abs(e) <= 180 && Math.abs(so) <= 90 && Math.abs(n) <= 90);
    }

    // 地図（keyframes）
    assert.ok(stage.keyframes.length > 0);
    let prev = -Infinity;
    let prevKf = null;
    for (const k of stage.keyframes) {
      const lastKf = prevKf; // since の確認用（prevKf は下で進める）
      const where = `${formatYear(k.year)}「${k.title}」`;
      assert.ok(k.year >= min && k.year <= max, `${where} が範囲内`);
      assert.ok(k.year > prev, `${where} が年の順に並んでいる`);
      if (k.changeWindow) {
        const [y0, y1] = k.changeWindow;
        assert.ok(prevKf, `${where}: 最初の場面に changeWindow は書けない`);
        assert.ok(y0 < y1, `${where}: changeWindow は [はじめ, おわり]`);
        assert.ok(y0 >= prevKf.year && y1 <= k.year, `${where}: changeWindow [${y0}, ${y1}] が前の場面（${prevKf.year}）とこの場面のあいだにある`);
      }
      if (prevKf) {
        // つづく 2 つの場面で、空白や大文字小文字だけちがう名前があると、同じ勢力として結びつかない
        const before = new Map(prevKf.polities.map((p) => [normalizeName(p.name), p.name]));
        for (const p of k.polities) {
          const o = before.get(normalizeName(p.name));
          assert.ok(o === undefined || o === p.name, `${where}: 「${o}」と「${p.name}」の書き方をそろえる`);
        }
      }
      prev = k.year;
      prevKf = k;
      assert.ok([1, 2, 3].includes(k.level), `${where} の level は 1〜3`);
      assert.ok(typeof k.summary === "string" && k.summary.length > 0, `${where} に summary がある`);
      assert.ok(k.source, `${where} に source がある`);
      const colors = new Map();
      for (const p of k.polities) {
        const c = p.color.toLowerCase();
        assert.ok(!colors.has(c), `${where}: 「${colors.get(c)}」と「${p.name}」が同じ色 ${p.color}`);
        colors.set(c, p.name);
      }
      const seen = new Map();
      for (const p of k.polities) {
        assert.ok(p.name && /^#[0-9a-f]{6}$/i.test(p.color), `${where} ${p.name} の色`);
        assert.ok((p.units && p.units.length) || (p.areas && p.areas.length), `${where} ${p.name} に units か areas がある`);
        for (const u of p.units ?? []) {
          assert.ok(ids.has(u), `${where} ${p.name}: ${u} が ${stage.units} にない`);
          assert.ok(!seen.has(u), `${where}: ${u} が「${seen.get(u)}」と「${p.name}」の両方に入っている`);
          seen.set(u, p.name);
        }
        for (const a of p.areas ?? []) {
          if (a.type === "disc") {
            assert.equal(a.center.length, 2);
            assert.ok(a.km > 0, `${where} ${p.name} の半径`);
          } else {
            assert.equal(a.type, "poly", `${where} ${p.name} の area の type`);
            assert.ok(a.points.length >= 3);
            for (const [lon, lat] of a.points) assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90);
          }
        }
        if (p.label) assert.equal(p.label.length, 2);
        for (const [u, y] of Object.entries(p.since ?? {})) {
          assert.ok((p.units ?? []).includes(u), `${where} ${p.name}: since の ${u} が units にない`);
          assert.ok(lastKf, `${where}: 最初の場面に since は書けない`);
          assert.ok(Number.isFinite(y) && y > lastKf.year && y <= k.year, `${where} ${p.name}: since の ${u}=${y} が前の場面（${lastKf.year}）とこの場面（${k.year}）のあいだにない`);
        }
      }
      for (const m of k.markers ?? []) assert.ok(m.name && m.at.length === 2, `${where} の印`);
    }

    // できごと
    for (const ev of stage.events) {
      assert.ok(ev.year >= min && ev.year <= max, `できごと「${ev.title}」(${ev.year}) が範囲内`);
      assert.ok(ev.title);
    }
  });
}
