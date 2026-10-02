import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDENTITY, qmul, qconj, qnormalize, qrotate, slerp, lonLatToVec, vecToLonLat, rotateLonLat,
  Rotations, chainOffsets, pieceRotation, pieceState, formatAge, trackToAge, ageToTrack, periodAt, eventsNear,
} from "../lib/geo.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} ≠ ${b} (±${tol})`);

test("GPlates の例: アフリカ(20E,0) は 1億年前に (2.9481E, 19.3854S)", () => {
  // get_quaternions?times=100&pids=701&model=MULLER2022 と reconstruct_points の値
  const q = [0.96826857, -0.17222798, 0.13504836, -0.12064588];
  const [lon, lat] = rotateLonLat(q, 20, 0);
  near(lon, 2.9481, 0.001, "lon");
  near(lat, -19.3854, 0.001, "lat");
});

test("四元数の積と共役: q · q^-1 = 恒等、回してから戻すと元に戻る", () => {
  const q = qnormalize([0.79437, -0.57095945, -0.05653024, -0.19946413]);
  const id = qmul(q, qconj(q));
  near(id[0], 1, 1e-6); near(id[1], 0, 1e-6); near(id[2], 0, 1e-6); near(id[3], 0, 1e-6);
  const v = lonLatToVec(139.7, 35.7);
  const back = qrotate(qconj(q), qrotate(q, v));
  for (let i = 0; i < 3; i++) near(back[i], v[i], 1e-9);
});

test("経度緯度とベクトルの往復", () => {
  for (const [lon, lat] of [[0, 0], [90, 0], [139.7, 35.7], [-75, -33], [179.9, 89]]) {
    const [lo, la] = vecToLonLat(lonLatToVec(lon, lat));
    near(lo, lon, 1e-9); near(la, lat, 1e-9);
  }
});

test("slerp は両端で元の値、中間は単位四元数", () => {
  const a = [1, 0, 0, 0];
  const b = [Math.cos(0.5), Math.sin(0.5), 0, 0];
  assert.deepEqual(slerp(a, b, 0), a);
  for (let i = 0; i < 4; i++) near(slerp(a, b, 1)[i], b[i], 1e-9);
  const m = slerp(a, b, 0.5);
  near(Math.hypot(...m), 1, 1e-9);
  near(m[0], Math.cos(0.25), 1e-9);
  // 符号が逆の同じ回転でも、遠回りしない
  const m2 = slerp(a, b.map((x) => -x), 0.5);
  near(Math.abs(m2[0]), Math.cos(0.25), 1e-9);
});

test("Rotations: 標本の間は補間され、範囲外は端の値", () => {
  const meta = { times: [0, 10, 20], pids: [7], scale: 32767 };
  const s = 32767;
  const q10 = [Math.cos(0.1), Math.sin(0.1), 0, 0];
  const q20 = [Math.cos(0.2), Math.sin(0.2), 0, 0];
  const int16 = new Int16Array([s, 0, 0, 0, ...q10.map((x) => Math.round(x * s)), ...q20.map((x) => Math.round(x * s))]);
  const rot = new Rotations(meta, int16);
  near(rot.at(7, 0)[0], 1, 1e-4);
  near(rot.at(7, 5)[0], Math.cos(0.05), 1e-4);
  near(rot.at(7, 10)[1], Math.sin(0.1), 1e-4);
  near(rot.at(7, 15)[1], Math.sin(0.15), 1e-4);
  near(rot.at(7, 99)[1], Math.sin(0.2), 1e-4);
  assert.deepEqual(rot.at(999, 5), IDENTITY);
  assert.throws(() => new Rotations(meta, new Int16Array(3)));
});

test("乗り換え（segs）の前後で位置がつながる", () => {
  // プレート 1 は x 軸まわり、プレート 2 は z 軸まわりに回る。10 Ma で 1 → 2 に乗り換える
  const meta = { times: [0, 10, 20], pids: [1, 2], scale: 32767 };
  const s = 32767;
  const rx = (a) => [Math.cos(a / 2), Math.sin(a / 2), 0, 0].map((x) => Math.round(x * s));
  const rz = (a) => [Math.cos(a / 2), 0, 0, Math.sin(a / 2)].map((x) => Math.round(x * s));
  const int16 = new Int16Array([...rx(0), ...rx(0.3), ...rx(0.6), ...rz(0), ...rz(0.4), ...rz(0.8)]);
  const rot = new Rotations(meta, int16);
  const piece = { segs: [[0, 1], [10, 2]], until: 20, from: 15 };
  const v = lonLatToVec(30, 20);
  const before = qrotate(pieceRotation(piece, rot, 10), v);
  const after = qrotate(pieceRotation(piece, rot, 10.0001), v);
  for (let i = 0; i < 3; i++) near(after[i], before[i], 1e-3, "連続");
  // 10 Ma 以降は、10 Ma の位置から z 軸まわりに回る
  const at15 = qrotate(pieceRotation(piece, rot, 15), v);
  const expect = qrotate(qmul(rot.at(2, 15), qconj(rot.at(2, 10))), before);
  for (let i = 0; i < 3; i++) near(at15[i], expect[i], 1e-4, "乗り換え後");
  assert.equal(pieceRotation(piece, rot, 25), null);
  assert.equal(pieceState(piece, 5), "solid");
  assert.equal(pieceState(piece, 16), "ghost");
  assert.equal(pieceState(piece, 21), "hidden");
  assert.equal(chainOffsets(piece.segs, rot).length, 2);
});

test("formatAge", () => {
  assert.equal(formatAge(0), "現在");
  assert.equal(formatAge(0.01), "1万年前");
  assert.equal(formatAge(2.58), "258万年前");
  assert.equal(formatAge(66), "6600万年前");
  assert.equal(formatAge(100), "1億年前");
  assert.equal(formatAge(250), "2億5000万年前");
  assert.equal(formatAge(1000), "10億年前");
});

test("スライダーの目盛りと年代の往復", () => {
  near(trackToAge(0), 1000, 1e-9);
  near(trackToAge(1), 0, 1e-9);
  near(ageToTrack(1000), 0, 1e-9);
  near(ageToTrack(0), 1, 1e-9);
  for (const age of [0, 1, 66, 250, 251, 540, 999, 1000]) near(trackToAge(ageToTrack(age)), age, 1e-9, `age ${age}`);
  let prev = Infinity;
  for (let x = 0; x <= 1; x += 0.01) {
    const a = trackToAge(x);
    assert.ok(a <= prev, "単調に減る");
    prev = a;
  }
  // 最近の 2.5 億年に、目盛りの半分以上をあてる
  assert.ok(1 - ageToTrack(250) >= 0.5);
});

test("periodAt / eventsNear", () => {
  const periods = [
    { name: "第四紀", start: 2.58, end: 0 },
    { name: "新第三紀", start: 23.03, end: 2.58 },
    { name: "トニアン", start: 1000, end: 720 },
  ];
  assert.equal(periodAt(periods, 0).name, "第四紀");
  assert.equal(periodAt(periods, 2.58).name, "新第三紀");
  assert.equal(periodAt(periods, 1000).name, "トニアン");
  assert.equal(periodAt(periods, 100), null);
  const ev = [{ age: 66, t: "a" }, { age: 70, t: "b" }, { age: 300, t: "c" }];
  assert.deepEqual(eventsNear(ev, 68, 5).map((e) => e.t), ["a", "b"]);
});

test("実データ: 回転表と陸片が読め、現在は恒等回転、すべての陸片の乗り換え先が表にある", () => {
  const meta = JSON.parse(fs.readFileSync(path.join(root, "data/rotations.json"), "utf8"));
  const buf = fs.readFileSync(path.join(root, "data/rotations.bin"));
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const rot = new Rotations(meta, int16);
  const pieces = JSON.parse(fs.readFileSync(path.join(root, "data/pieces.json"), "utf8")).pieces;
  assert.ok(pieces.length > 500);
  for (const p of pieces) {
    for (const [, pid] of p.segs) assert.ok(rot.index.has(pid), `plate ${pid}`);
    const q0 = pieceRotation(p, rot, 0);
    near(Math.abs(q0[0]), 1, 1e-4, `piece ${p.pid} at 0`);
    assert.ok(p.ring.length >= 4);
  }
  // 1 億年前に、アフリカの陸片は GPlates の例と同じ場所へ動く（701 の回転）
  const africa = pieces.find((p) => p.pid === 701 && p.area > 2000000);
  const [lon, lat] = rotateLonLat(pieceRotation(africa, rot, 100), 20, 0);
  near(lon, 2.9481, 0.05, "lon");
  near(lat, -19.3854, 0.05, "lat");
});
