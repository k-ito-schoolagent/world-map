// 国の成り立ち（kuni/）のデータと年代の計算のテスト
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatYear, shortYear, makeScale, keyframeAt } from "../kuni/scale.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "kuni", "data");
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} ≠ ${b} (±${tol})`);

test("formatYear: 紀元前・西暦・4けた", () => {
  assert.equal(formatYear(-3000), "紀元前3000年");
  assert.equal(formatYear(-1), "紀元前1年");
  assert.equal(formatYear(0), "西暦0年");
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
    for (const k of stage.keyframes) {
      const where = `${formatYear(k.year)}「${k.title}」`;
      assert.ok(k.year >= min && k.year <= max, `${where} が範囲内`);
      assert.ok(k.year > prev, `${where} が年の順に並んでいる`);
      prev = k.year;
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
