#!/usr/bin/env python3
"""data/ の陸片と回転が、GPlates Web Service の公式の復元と合っているか確かめる。

  python3 _data/verify.py

1. 地点の照合: 現在の地点（東京・デリーなど）を自前の回転で動かし、
   公式の reconstruct_points と比べる（1° 以内なら合格）
2. 形の照合: いくつかの年代で、公式の海岸線（reconstruct/coastlines）と
   自前の復元（モデルに陸がある陸片だけ）を 2° の格子で塗りくらべ、重なり率（IoU）を出す
"""
import json
import math
import os
import struct
import sys
import urllib.parse

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import build as B  # noqa: E402

POINTS = {
    "東京": (139.7, 35.7), "札幌": (141.3, 43.1), "福岡": (130.4, 33.6), "デリー": (77.2, 28.6),
    "ケープタウン": (18.4, -33.9), "シドニー": (151.2, -33.9), "リマ": (-77.0, -12.0), "マドリード": (-3.7, 40.4),
    "ニューヨーク": (-74.0, 40.7), "モスクワ": (37.6, 55.8), "北京": (116.4, 39.9), "パース": (115.9, -31.9),
}
AGES_POINTS = [50, 100, 200, 300, 500, 800]
AGES_SHAPES = [40, 100, 200, 300, 500, 800]
GRID_DEG = 2.0


def load():
    P = json.load(open(os.path.join(ROOT, "data", "pieces.json")))
    meta = json.load(open(os.path.join(ROOT, "data", "rotations.json")))
    raw = open(os.path.join(ROOT, "data", "rotations.bin"), "rb").read()
    arr = np.frombuffer(raw, dtype="<i2").reshape(len(meta["pids"]), len(meta["times"]), 4) / meta["scale"]
    q = {pid: [list(x / np.linalg.norm(x)) for x in arr[i]] for i, pid in enumerate(meta["pids"])}
    return P, meta, B.Rot(meta["times"], q)


def pip(ring, x, y):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def piece_for(pieces, lon, lat):
    best = None
    for p in pieces:
        if pip(p["ring"], lon, lat):
            if best is None or p["area"] < best["area"]:
                best = p
    return best


def check_points(P, rot):
    print("1) 地点の照合（自前の回転 vs 公式 reconstruct_points）")
    pieces = P["pieces"]
    worst = 0.0
    fails = 0
    for age in AGES_POINTS:
        names, lons, lats, mine = [], [], [], []
        door = set(P.get("japanSea", {}).get("pids", []))
        for name, (lon, lat) in POINTS.items():
            p = piece_for(pieces, lon, lat)
            if p is None or age > p["until"]:
                continue
            if p["pid"] in door:
                continue  # 日本列島は観音開きモデルを重ねているので公式とは一致しない（照合対象外）
            qv = B.piece_rotation(p["segs"], rot, age)
            v = B.qrot_many(qv, np.array([B.ll2xyz(lon, lat)]))[0]
            names.append(name)
            lons.append(lon)
            lats.append(lat)
            mine.append((math.degrees(math.atan2(v[1], v[0])), math.degrees(math.asin(max(-1, min(1, v[2]))))))
        res = B.gws(
            "/reconstruct/reconstruct_points/",
            {"lons": ",".join(map(str, lons)), "lats": ",".join(map(str, lats)), "time": age, "model": P["model"]},
        )
        coords = res["coordinates"]
        line = []
        for name, (mlon, mlat), c in zip(names, mine, coords):
            if c[0] > 900:  # 公式では存在しない
                line.append(f"{name}:公式なし")
                continue
            a = B.ll2xyz(mlon, mlat)
            b = B.ll2xyz(c[0], c[1])
            d = math.degrees(math.acos(max(-1.0, min(1.0, float(a @ b)))))
            worst = max(worst, d)
            if d > 1.0:
                fails += 1
            line.append(f"{name}:{d:.2f}°")
        print(f"   {age} Ma  " + "  ".join(line))
    print(f"   最大のずれ {worst:.2f}°、1° をこえた地点 {fails} 個")
    return fails == 0


def raster(polys, lon_grid, lat_grid):
    """球面多角形の集まりを格子で塗る。回り数（接平面での角度の合計）で内外を判定する。"""
    H, W = lat_grid.shape
    mask = np.zeros((H, W), dtype=bool)
    P = np.stack([np.cos(np.radians(lat_grid)) * np.cos(np.radians(lon_grid)), np.cos(np.radians(lat_grid)) * np.sin(np.radians(lon_grid)), np.sin(np.radians(lat_grid))], axis=-1).reshape(-1, 3)
    for ring in polys:
        V = np.array([B.ll2xyz(x, y) for x, y in ring])
        if len(V) < 4:
            continue
        c = V.mean(axis=0)
        c /= np.linalg.norm(c)
        cap = float(np.min(V @ c))  # 多角形をおおう円錐
        sel = np.where(P @ c >= cap - 0.02)[0]
        if len(sel) == 0:
            continue
        Q = P[sel]
        # 接平面の基底
        up = np.where(np.abs(Q[:, 2:3]) < 0.9, np.array([[0, 0, 1.0]]), np.array([[1.0, 0, 0]]))
        e1 = np.cross(up, Q)
        e1 /= np.linalg.norm(e1, axis=1, keepdims=True)
        e2 = np.cross(Q, e1)
        # 各頂点を接平面に射影（点から見た方向）
        D = V[None, :, :] - Q[:, None, :]  # (n, m, 3)
        x = np.einsum("nmk,nk->nm", D, e1)
        y = np.einsum("nmk,nk->nm", D, e2)
        ang = np.arctan2(y, x)
        d = np.diff(ang, axis=1)
        d = (d + np.pi) % (2 * np.pi) - np.pi
        wn = np.abs(d.sum(axis=1)) / (2 * np.pi)
        inside = wn > 0.5
        # 裏側（多角形の反対側の半球）は除く
        inside &= (Q @ c) > 0
        mask.reshape(-1)[sel[inside]] = True
    return mask


def in_japan_door(ring):
    """公式の復元のうち、観音開きを重ねた日本列島の範囲にある面を除く（現在の位置で判定できないので
    おおよその範囲で）。復元後の座標なので、日本付近（経度 125〜150、緯度 28〜48）にあるものを除く。"""
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    cx, cy = sum(lons) / len(lons), sum(lats) / len(lats)
    return 125 <= cx <= 150 and 28 <= cy <= 48 and B.ring_area_km2(ring) < 300000


def check_shapes(P, rot):
    print("2) 形の照合（自前の復元 vs 公式 reconstruct/coastlines、2° 格子の重なり率）")
    pieces = P["pieces"]
    lons = np.arange(-180 + GRID_DEG / 2, 180, GRID_DEG)
    lats = np.arange(-90 + GRID_DEG / 2, 90, GRID_DEG)
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    w = np.cos(np.radians(lat_grid))
    ok = True
    for age in AGES_SHAPES:
        off = B.gws("/reconstruct/coastlines/", {"time": age, "model": P["model"]})
        off_rings = []
        for ft in off["features"]:
            g = ft["geometry"]
            rings = g["coordinates"] if g["type"] == "Polygon" else [p[0] for p in g["coordinates"]]
            for r in rings[:1]:
                if B.ring_area_km2(r) >= B.AREA_MIN_KM2 and not in_japan_door(r):
                    off_rings.append(r)
        mine = []
        door = set(P.get("japanSea", {}).get("pids", []))
        for p in pieces:
            if age > p["from"] or age > p["until"] or p["pid"] in door:
                continue
            qv = B.piece_rotation(p["segs"], rot, age)
            V = B.qrot_many(qv, np.array([B.ll2xyz(x, y) for x, y in p["ring"]]))
            mine.append([(math.degrees(math.atan2(v[1], v[0])), math.degrees(math.asin(max(-1, min(1, v[2]))))) for v in V])
        A = raster(off_rings, lon_grid, lat_grid)
        Bm = raster(mine, lon_grid, lat_grid)
        inter = float((w * (A & Bm)).sum())
        union = float((w * (A | Bm)).sum())
        iou = inter / union if union else 0
        print(f"   {age} Ma  重なり率 {iou:.3f}  公式 {len(off_rings)} 面 / 自前 {len(mine)} 面")
        if age <= 250 and iou < 0.85:
            ok = False
    return ok


def main():
    P, meta, rot = load()
    print(f"モデル {P['model']}、陸片 {len(P['pieces'])} 個")
    a = check_points(P, rot)
    b = check_shapes(P, rot)
    print("結果:", "合格" if a and b else "要確認")
    sys.exit(0 if a and b else 1)


if __name__ == "__main__":
    main()
