#!/usr/bin/env python3
"""海岸線の輪郭（EarthByte の GPML）とプレートの回転（GPlates Web Service）から、
data/pieces.json・data/rotations.json・data/rotations.bin を作る。

  python3 _data/build.py                       # 既定（MULLER2022、0〜10億年前）
  python3 _data/build.py --max-age 540         # 範囲を変える

必要なもの: Python 3.9 以上と numpy。海岸線ファイルは初回に自動で取得し、
応答と一緒に _data/cache/ に保存して再利用する。
"""
import argparse
import bisect
import gzip
import hashlib
import io
import json
import math
import os
import struct
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

import numpy as np

GWS = "https://gws.gplates.org"
COASTLINE_ZIP = "https://repo.gplates.org/webdav/pmm/{model}/Coastlines.zip"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "cache")
NS = {"gpml": "http://www.gplates.org/gplates", "gml": "http://www.opengis.net/gml"}

# 陸地の大きさのしきい値（km²）。小さな島は省く（日本のまわりだけ細かく残す）
AREA_MIN_KM2 = 10000
JAPAN_BBOX = (122.0, 20.0, 154.0, 46.0)  # lon0, lat0, lon1, lat1
AREA_MIN_JAPAN = 400
# 輪郭の単純化（度）。Douglas–Peucker
TOL_DEG = 0.08
TOL_JAPAN = 0.03
# モデルで陸地や回転が途切れる陸片を、その時点でいちばん近い陸地につなぐときの最大距離（度）
ATTACH_MAX_DEG = 4.0
# 日本列島とみなさない（大陸側の）プレート番号
MAINLAND_PIDS = {301, 401, 430, 453, 454, 455, 499, 601, 602, 619, 621, 4100}
# 日本海の開き（観音開きモデル）。GPlates の全球モデルには日本海の急な開き（約2000万〜1500万年前）が
# 入っていないので、Otofuji ほか (1985) の「観音開き」を単純化して重ねる:
# 西南日本は北部九州付近を軸に時計回り、東北日本は北海道北部付近を軸に反時計回りに約45°。
# 現在→過去の向きに 15 Ma から 20 Ma にかけて徐々に閉じ、20 Ma より昔は閉じたまま大陸と一緒に動かす。
DOOR_OPEN_END = 15.0
DOOR_OPEN_START = 20.0
DOORS = {
    "sw": {"pole": (129.5, 33.5), "angle": 45.0, "pids": (630, 631)},
    "ne": {"pole": (141.5, 45.5), "angle": -45.0, "pids": (624, 625, 626, 627, 628, 629)},
}


# ---------- 取得 ----------
def fetch(url, binary=False, retries=4):
    key = hashlib.sha1(url.encode()).hexdigest()
    os.makedirs(CACHE, exist_ok=True)
    cpath = os.path.join(CACHE, key + (".bin" if binary else ".json"))
    if os.path.exists(cpath):
        with open(cpath, "rb") as f:
            raw = f.read()
        return raw if binary else json.loads(raw.decode("utf-8"))
    for i in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                raw = r.read()
            if not binary:
                json.loads(raw.decode("utf-8"))
            with open(cpath, "wb") as f:
                f.write(raw)
            return raw if binary else json.loads(raw.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"  再試行 {i + 1}/{retries}: {e}", file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise SystemExit(f"取得に失敗: {url}")


def gws(path, params):
    return fetch(GWS + path + "?" + urllib.parse.urlencode(params, safe=","))


def load_coastlines(model):
    """EarthByte の海岸線 GPML を読み、(pid, begin, end, ring) のリストを返す。"""
    raw = fetch(COASTLINE_ZIP.format(model=model.lower()), binary=True)
    zf = zipfile.ZipFile(io.BytesIO(raw))
    names = [n for n in zf.namelist() if n.endswith((".gpml", ".gpmlz"))]
    if not names:
        raise SystemExit("海岸線ファイルが zip に見つからない: " + ", ".join(zf.namelist()))
    data = zf.read(names[0])
    if names[0].endswith(".gpmlz"):
        data = gzip.decompress(data)
    root = ET.fromstring(data)
    out = []
    for f in root.findall(".//gml:featureMember/*", NS):
        pid = f.find("gpml:reconstructionPlateId//gpml:value", NS)
        if pid is None:
            continue
        pid = int(pid.text)
        tb = f.find("gml:validTime/gml:TimePeriod/gml:begin//gml:timePosition", NS)
        te = f.find("gml:validTime/gml:TimePeriod/gml:end//gml:timePosition", NS)
        begin = parse_time(tb.text if tb is not None else None, 1e4)
        end = parse_time(te.text if te is not None else None, 0.0)
        for poly in f.iter("{%s}Polygon" % NS["gml"]):
            pl = poly.find("gml:exterior//gml:posList", NS)
            if pl is None:
                continue
            nums = [float(x) for x in pl.text.split()]
            ring = [[nums[i + 1], nums[i]] for i in range(0, len(nums) - 1, 2)]  # lat lon → lon lat
            if len(ring) >= 4:
                if ring[0] != ring[-1]:
                    ring.append(ring[0])
                out.append((pid, begin, end, ring))
    return out, names[0]


def parse_time(text, default):
    if text is None:
        return default
    if "distantPast" in text:
        return 1e4
    if "distantFuture" in text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return default


# ---------- 幾何 ----------
def ring_area_km2(ring):
    lats = [p[1] for p in ring]
    k = math.cos(math.radians(sum(lats) / len(lats)))
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0] * k, ring[i][1]
        x2, y2 = ring[(i + 1) % n][0] * k, ring[(i + 1) % n][1]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2 * (111.2 ** 2)


def interior_point(ring):
    """輪の内側の点を 1 つ返す（真ん中の高さの走査線で、いちばん長い内側区間の中点）。"""
    ys = [p[1] for p in ring]
    y = (min(ys) + max(ys)) / 2
    xs = []
    m = len(ring)
    for i in range(m):
        ax, ay = ring[i]
        bx, by = ring[(i + 1) % m]
        if (ay > y) != (by > y):
            xs.append(ax + (y - ay) * (bx - ax) / (by - ay))
    xs.sort()
    best = None
    for i in range(0, len(xs) - 1, 2):
        w = xs[i + 1] - xs[i]
        if best is None or w > best[0]:
            best = (w, (xs[i] + xs[i + 1]) / 2)
    if best:
        return (best[1], y)
    return (sum(p[0] for p in ring) / m, sum(ys) / m)


def simplify(ring, tol):
    pts = ring[:-1] if ring[0] == ring[-1] else ring[:]
    if len(pts) < 4:
        return pts + [pts[0]]
    p0 = np.array(pts[0])
    d = np.linalg.norm(np.array(pts) - p0, axis=1)
    j = int(np.argmax(d))
    a = dp(pts[: j + 1], tol)
    b = dp(pts[j:] + [pts[0]], tol)
    res = a[:-1] + b[:-1]
    if len(res) < 3:
        return pts + [pts[0]]
    return res + [res[0]]


def dp(pts, tol):
    if len(pts) < 3:
        return pts[:]
    a = np.array(pts, dtype=float)
    keep = np.zeros(len(a), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(a) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        p, q = a[i], a[j]
        seg = q - p
        L2 = float(seg @ seg)
        mid = a[i + 1 : j]
        if L2 == 0:
            dist = np.linalg.norm(mid - p, axis=1)
        else:
            t = np.clip(((mid - p) @ seg) / L2, 0, 1)
            dist = np.linalg.norm(mid - (p + t[:, None] * seg), axis=1)
        k = int(np.argmax(dist))
        if dist[k] > tol:
            keep[i + 1 + k] = True
            stack.append((i, i + 1 + k))
            stack.append((i + 1 + k, j))
    return [pts[i] for i in range(len(pts)) if keep[i]]


def ll2xyz(lon, lat):
    lo, la = math.radians(lon), math.radians(lat)
    return np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])


def qmul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return [
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ]


def qinv(q):
    return [q[0], -q[1], -q[2], -q[3]]


def qrot_many(q, vs):
    w, x, y, z = q
    u = np.array([x, y, z])
    t = 2 * np.cross(u, vs)
    return vs + w * t + np.cross(u, t)


def slerp(a, b, t):
    a = np.array(a, dtype=float)
    b = np.array(b, dtype=float)
    d = float(a @ b)
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        r = a + t * (b - a)
        return list(r / np.linalg.norm(r))
    th = math.acos(d)
    return list((math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th))


class Rot:
    def __init__(self, times, q):
        self.times = times
        self.q = q

    def at(self, pid, age):
        qs = self.q[pid]
        if age <= self.times[0]:
            return qs[0]
        if age >= self.times[-1]:
            return qs[-1]
        j = bisect.bisect_right(self.times, age)
        t0, t1 = self.times[j - 1], self.times[j]
        return slerp(qs[j - 1], qs[j], (age - t0) / (t1 - t0))


def piece_rotation(segs, rot, age):
    """segs = [[age, pid], ...]。区間 k（segs[k].age < t <= segs[k+1].age）では
    R(t) = R_pid_k(t) · M_k。M_0 = 恒等、M_k = R_pid_k(a_k)^-1 · R_pid_(k-1)(a_k) · M_(k-1)。"""
    M = [1.0, 0.0, 0.0, 0.0]
    k = 0
    while k + 1 < len(segs) and age > segs[k + 1][0]:
        a = segs[k + 1][0]
        prev = qmul(rot.at(segs[k][1], a), M)
        M = qmul(qinv(rot.at(segs[k + 1][1], a)), prev)
        k += 1
    return qmul(rot.at(segs[k][1], age), M)


# ---------- 分類 ----------
def in_box(lon, lat, box):
    return box[0] <= lon <= box[2] and box[1] <= lat <= box[3]


def group_of(lon, lat, pid):
    if lat < -60:
        return "antarctica"
    if pid in (501, 502):
        return "india"
    if in_box(lon, lat, JAPAN_BBOX) and pid not in MAINLAND_PIDS and (lon >= 128.5 or lat < 34):
        return "japan"
    if (110 <= lon <= 180 or lon <= -170) and -50 <= lat <= -10:
        return "australia"
    if 130 <= lon <= 156 and -11 <= lat <= 0:
        return "australia"
    if -20 <= lon <= 52 and -36 <= lat <= 38 and not (lon > 32.5 and lat > 12.5):
        return "africa"
    if -92 <= lon <= -30 and (lat < 7.5 or (lat < 13 and lon > -77)):
        return "south-america"
    if lon < -25 and lat >= 7.5:
        return "north-america"
    return "eurasia"


# ---------- メイン ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="MULLER2022")
    ap.add_argument("--max-age", type=int, default=1000)
    args = ap.parse_args()
    model, max_age = args.model, args.max_age
    times = [t for t in list(range(0, 51, 1)) + list(range(52, 251, 2)) + list(range(255, 1001, 5)) if t <= max_age]
    if times[-1] != max_age:
        times.append(max_age)
    print(f"モデル {model}、0〜{max_age} Ma、標本 {len(times)} 時点")

    print("1) 海岸線の輪郭を読む")
    polys, fname = load_coastlines(model)
    print(f"   {fname}: {len(polys)} 個の多角形")

    print("2) 面積でしぼり、輪郭を単純化する")
    pieces = []
    for pid, begin, end, ring in polys:
        area = ring_area_km2(ring)
        rep = interior_point(ring)
        jp = in_box(rep[0], rep[1], JAPAN_BBOX)
        if area < (AREA_MIN_JAPAN if jp else AREA_MIN_KM2):
            continue
        s_ring = simplify(ring, TOL_JAPAN if jp else TOL_DEG)
        # ちょうど ±180° や ±90° の頂点は、回転していない地図で d3 の切り抜きが裏返るので少し内側へ
        s_ring = [[max(-179.99, min(179.99, x)), max(-89.99, min(89.99, y))] for x, y in s_ring]
        # ハワイ諸島（太平洋プレート 901）は火山島で、主な島はおよそ 500 万年より新しい。
        # 海岸線ファイルの有効期間（83 Ma）は長すぎるので、600 万年より昔は描かない
        if pid == 901:
            begin = min(begin, 6.0)
        pieces.append(
            {
                "pid": pid,
                "from": min(begin, 1e4),
                "to": end,
                "area": round(area),
                "group": group_of(rep[0], rep[1], pid),
                "rep": [round(rep[0], 3), round(rep[1], 3)],
                "ring": [[round(p[0], 2), round(p[1], 2)] for p in s_ring],
            }
        )
    nv = sum(len(p["ring"]) for p in pieces)
    print(f"   {len(pieces)} 個の陸片、頂点 {nv} 個")

    print("3) 回転を取得")
    # GPlates Web Service は times を集合として扱うため、応答の並びが要求順と一致しない。
    # 307 個以上の相異なる整数（すべて 2048 未満）を渡すと内部の表が 2048 枠になり
    # 応答は年代の昇順になる。そこで埋め草の年代を足して昇順で受け取り、単発の
    # 問い合わせで要所を照合する。
    # （CPython の set は 307 個目の挿入で 2048 枠に広がり、2048 未満の相異なる整数は昇順に並ぶ。
    #   念のため下の単発照合と verify.py でも確かめる）
    fillers = [t for t in range(0, 1000) if t not in set(times)]
    req_times = sorted(set(times) | set(fillers[: max(0, 310 - len(times))]))
    if len(req_times) < 307:
        raise SystemExit("要求する年代は 307 個以上にする（応答の並びを昇順にするため）")
    keep = [req_times.index(t) for t in times]
    pids = sorted({p["pid"] for p in pieces})
    q = {}
    CH = 20
    tstr = ",".join(str(t) for t in req_times)
    for s in range(0, len(pids), CH):
        chunk = pids[s : s + CH]
        pstr = ",".join(map(str, chunk))
        res = gws("/rotation/get_quaternions", {"times": tstr, "pids": pstr, "model": model, "group_by_pid": ""})
        for pid in chunk:
            qs = res.get(str(pid))
            if qs is None or len(qs) != len(req_times):
                raise SystemExit(f"プレート {pid} の回転が {len(qs) if qs else 0} 個しか返らなかった（期待 {len(req_times)}）")
            q[pid] = [[float(v) for v in qs[k]] for k in keep]
        # 照合: 単発の問い合わせと一致するか
        for t in (100, 500, max_age):
            if t not in times:
                continue
            single = gws("/rotation/get_quaternions", {"times": str(t), "pids": pstr, "model": model, "group_by_pid": ""})
            for pid in chunk:
                a = q[pid][times.index(t)]
                b = [float(v) for v in single[str(pid)][0]]
                if any(abs(x - y) > 1e-6 for x, y in zip(a, b)):
                    raise SystemExit(f"回転の並びが昇順でない（プレート {pid}、{t} Ma）: {a} ≠ {b}")
        print(f"   {min(s + CH, len(pids))}/{len(pids)}", end="\r")
    print()
    print("3b) 日本海の開き（観音開きモデル）を重ねる")
    door_pids = set()
    for door in DOORS.values():
        axis = ll2xyz(*door["pole"])
        for pid in door["pids"]:
            if pid not in q:
                continue
            door_pids.add(pid)
            for k, t in enumerate(times):
                f = max(0.0, min(1.0, (t - DOOR_OPEN_END) / (DOOR_OPEN_START - DOOR_OPEN_END)))
                if f <= 0:
                    continue
                th = math.radians(door["angle"] * f)
                d = [math.cos(th / 2)] + [float(a) * math.sin(th / 2) for a in axis]
                q[pid][k] = qmul(q[pid][k], d)
    print(f"   対象プレート: {sorted(door_pids)}")
    rot = Rot(times, q)

    print("4) 回転が続く年代（恒等回転 = 回転の木にない）を調べる")
    rv = {}
    for pid in pids:
        rv[pid] = max_age + 1
        for k, (t, x) in enumerate(zip(times, q[pid])):
            if t >= 5 and abs(x[0]) >= 0.9999999 and all(abs(c) < 1e-7 for c in x[1:]):
                rv[pid] = times[k - 1]  # 恒等になる手前の標本までは回転がある
                break
    ends = sorted({min(v, max_age) for v in rv.values()})
    print(f"   回転が途切れる年代: {ends}")

    print("5) 回転が途切れる陸片を、その時点でいちばん近い陸地につなぐ")
    vecs = [np.array([ll2xyz(x, y) for x, y in p["ring"]]) for p in pieces]
    segs = [[[0, p["pid"]]] for p in pieces]
    until = [rv[p["pid"]] for p in pieces]
    attached = 0
    changed = True
    while changed:
        changed = False
        for i, p in enumerate(pieces):
            while until[i] < max_age:
                cur = until[i]
                me = qrot_many(piece_rotation(segs[i], rot, cur), vecs[i])
                best = None
                for j, o in enumerate(pieces):
                    if j == i or until[j] <= cur:
                        continue
                    rvj = qrot_many(piece_rotation(segs[j], rot, cur), vecs[j])
                    d = math.degrees(math.acos(max(-1.0, min(1.0, float(np.max(rvj @ me.T))))))
                    # 同じ時代に存在する陸地を優先する（まだ無い陸地は少し遠いものとして扱う）
                    score = d + (0.0 if o["from"] > cur else 1.0)
                    if best is None or score < best[0]:
                        best = (score, d, j)
                if best is None or best[1] > ATTACH_MAX_DEG:
                    break
                j = best[2]
                # j がその時点より後に使うプレート番号と、その後の乗り換えを引き継ぐ
                k = max(idx for idx, sg in enumerate(segs[j]) if sg[0] <= cur)
                segs[i] = segs[i] + [[cur, segs[j][k][1]]] + [sg for sg in segs[j] if sg[0] > cur]
                until[i] = until[j]
                attached += 1
                changed = True
    for i, p in enumerate(pieces):
        p["segs"] = [[int(a) if float(a).is_integer() else a, int(pid)] for a, pid in segs[i]]
        p["until"] = int(min(until[i], max_age))
    print(f"   {attached} 回つないだ")
    hidden = sum(1 for p in pieces if p["until"] < max_age)
    print(f"   {hidden} 個の陸片は途中で消える（近くに陸地がない島など）")

    print("6) 書き出す")
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    out_p = {
        "model": model,
        "maxAge": max_age,
        "source": "EarthByte / GPlates Web Service (CC BY 4.0)",
        "coastlines": fname,
        "japanSea": {"note": "日本海の開きは Otofuji ほか (1985) の観音開きモデルを単純化して加えたもの（GPlates のモデルには無い）", "pids": sorted(door_pids), "open": [DOOR_OPEN_START, DOOR_OPEN_END]},
        "generated": time.strftime("%Y-%m-%d"),
        "pieces": pieces,
    }
    with open(os.path.join(ROOT, "data", "pieces.json"), "w") as f:
        json.dump(out_p, f, ensure_ascii=False, separators=(",", ":"))
    meta = {"model": model, "times": times, "pids": pids, "scale": 32767, "bin": "rotations.bin"}
    with open(os.path.join(ROOT, "data", "rotations.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    buf = bytearray()
    for pid in pids:
        for x in q[pid]:
            buf += struct.pack("<4h", *[max(-32767, min(32767, round(c * 32767))) for c in x])
    with open(os.path.join(ROOT, "data", "rotations.bin"), "wb") as f:
        f.write(buf)
    for name in ("pieces.json", "rotations.json", "rotations.bin"):
        print(f"   data/{name}: {os.path.getsize(os.path.join(ROOT, 'data', name)) / 1024:.0f} KB")
    groups = {}
    for p in pieces:
        groups[p["group"]] = groups.get(p["group"], 0) + 1
    print("   グループ別:", groups)


if __name__ == "__main__":
    main()
