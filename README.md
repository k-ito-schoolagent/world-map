# うごく世界地図 — 10億年の大陸移動

**https://k-ito-schoolagent.github.io/world-map/**

10億年前から現在までの**大陸の動き**を、年表のつまみを動かしながら見る日本語の教材です。世界地図・地球儀のほか、「日本」「インド」「オーストラリア」を選ぶとその陸地を追いかけて、日本列島が大陸からはなれる様子や、インドがアジアにぶつかる様子を真ん中に置いたまま見られます。地球科学の研究者が公開しているプレート運動モデル（EarthByte / GPlates、Müller et al. 2022）のデータをそのまま使い、ブラウザの中で計算して描いています。

**だれでも年表の出来事や「見る場所」を追加できる、オープンなプロジェクトです。** 教科書に出てくる出来事、授業で見せたい場所を足してください。GitHub がはじめての方の、issue やプルリクエストの練習にも使ってください。→ [参加のしかた](CONTRIBUTING.md)

姉妹プロジェクト: [戦国合戦 3D俯瞰デモ](https://github.com/k-ito-schoolagent/sengoku-3d)（実際の地形の上の合戦）、[いきもの3D](https://github.com/k-ito-schoolagent/ikimono-3d)（からだと臓器のはたらき）、[FORM — Interactive Science Lab](https://github.com/k-ito-schoolagent/tech-demo)（機械と半導体）。

## できること

| 見る場所 | 体験できること |
| --- | --- |
| 世界地図 | 全体をひと目で。2億年前のパンゲア、5億年前のゴンドワナ、10億年前のロディニア |
| 地球儀 | ドラッグで回し、ホイールやピンチで拡大。南極の真上からも見られる |
| 日本 | 日本列島を追いかける。およそ2000万年前に日本海が開き、大陸からはなれる |
| インド | 南の大陸からはなれて北へ急ぎ、約5000万年前にアジアにぶつかる |
| 大西洋 | 南アメリカとアフリカの海岸線がぴったり合うことをたしかめる |
| オーストラリア・南極 | 南極からはなれて北へ動くオーストラリア、氷におおわれていく南極 |

- 年表には地質時代の帯（トニアン〜第四紀）と出来事の印があり、押すとその年代へ飛べます
- ▶ 再生で 10 億年前から今へ自動で進みます（ゆっくり／ふつう／はやく）
- 「今の海岸線を重ねる」で、どれだけ動いたかを比べられます。大陸をクリックするとその大陸だけが濃くなります
- 「この場面のリンクをコピー」で、年代と場所を含む URL を授業の前に用意できます（例: `?age=250&view=japan`）
- ライト／ダーク切り替え、スマートフォン対応、キーボード操作（Space 再生／停止、← → で 100 万年ずつ）

### これからつくるもの（予定）

**国の成り立ち**（人の歴史の時間で、国や統治のかたちがどう変わってきたか）は、アフリカ大陸と日本列島の試作版を [`kuni/`](https://k-ito-schoolagent.github.io/world-map/kuni/) で公開しています。ほかに、海の高さや氷の広がり、古生物の分布も予定しています。「これも見たい」は [issue](https://github.com/k-ito-schoolagent/world-map/issues/new/choose) でリクエストしてください。

## 参加のしかた（くわしくは [CONTRIBUTING.md](CONTRIBUTING.md)）

| やること | 方法 |
| --- | --- |
| 話してみる | [issue](https://github.com/k-ito-schoolagent/world-map/issues/new/choose) に「この出来事を入れてほしい」「この説明はちがう」「表示がおかしい」を書く |
| 年表に出来事を足す | `data/events.json` にひとつ書き足してプルリクエストを送る（ブラウザだけでできます） |
| 見る場所を足す | `data/regions.json` に場所を書き足す |
| GitHub の練習 | 「練習：はじめての issue」を書く、[CONTRIBUTORS.md](CONTRIBUTORS.md) に名前を足すプルリクエストを送る |

## 動かす

ビルドは要りません。クローンして、ローカルのウェブサーバで開くだけです。

```bash
git clone https://github.com/k-ito-schoolagent/world-map.git
cd world-map
python3 -m http.server 8000
# → http://localhost:8000
```

計算部分のテスト（Node.js 22 以上）:

```bash
npm test
```

## しくみ

地球の表面はいくつかのプレートに分かれ、それぞれが年に数 cm ずつ動いています。この教材は、研究者がまとめた「どのプレートが、いつ、どれだけ回ったか」の表（プレート運動モデル）を使い、**今の海岸線をプレートごとに切り分けて、そのまま昔の位置へ回して**描いています。

```
index.html            ページ（説明文・操作パネル）
lib/app.js            画面の組み立て（投影・描画・操作・URL）
lib/timeline.js       年表つきスライダー（SVG）
lib/geo.js            計算の中身（四元数の回転・補間・乗り換え・年代の表記）。node --test で検証
lib/style.css         デザイン（紙とインク）
lib/d3.v7.min.js      d3（投影と描画。ISC）
data/pieces.json      陸地の輪郭（プレートごとに分かれた 732 個の陸片。_data/build.py が作る）
data/rotations.json   回転表の見出し（標本の年代とプレート番号）
data/rotations.bin    回転表の本体（プレート × 時点 × 四元数、Int16）
data/events.json      年表の時代と出来事（みんなで書き足す）
data/regions.json     見る場所のボタン（みんなで書き足す）
data/continents.json  大陸の色分けと名前の位置
_data/build.py        海岸線と回転を取得して data/ を作る
_data/verify.py       公式の復元と比べて確かめる
test/geo.test.js      計算のテスト
kuni/                 国の成り立ち（試作）。index.html・app.js・scale.js と data/（地域ごとの年表 *.json と土台の地図 *-units.json）。test/kuni.test.js で検証
publish.sh            GitHub にリポジトリをつくって Pages を有効化する
```

### データの作りかた

```bash
pip install numpy
python3 _data/build.py     # 海岸線（EarthByte）を取得し、GPlates Web Service から回転を取り、data/ に書き出す
python3 _data/verify.py    # 公式の reconstruct_points / coastlines と比べる
```

- プレート運動モデル: **Müller et al. (2022)**。Merdith et al. (2021) の相対運動に、マントル基準系を合わせたもの（0〜10 億年前）
- 海岸線: EarthByte の `shapes_coastlines_Merdith_etal.gpmlz`（プレート番号と有効期間つき）。およそ 1 万 km² 以上の陸地を残し、日本のまわりは 400 km² 以上を残しています
- 回転: `get_quaternions` を 0〜50 Ma は 1 Ma ごと、〜250 Ma は 2 Ma ごと、〜1000 Ma は 5 Ma ごとに標本化し、そのあいだは球面線形補間
- 検証: 12 地点の復元位置が公式と 0.00° で一致、6 つの年代で陸地の重なり率（2° 格子）が 0.99 以上

### ただし書き（効果を言い過ぎないために）

- 昔の陸地の形は、**今の海岸線をそのまま回したもの**です。昔の海岸線や海の高さを再現したものではありません。「このプレートがどこにあったか」を見るための図です
- モデルで「まだ存在しない」とされる陸地（たとえば 3000 万年前より前の西日本）は、**その時点でいちばん近い陸地の回転に乗り換えて薄く描いています**（点線）。見やすさのための推定で、研究結果ではありません。「表示」で消せます。近くに陸地がない島（ハワイなど）はその年代で消えます
- 確かさの目安: 2 億 5000 万年前まで（LEVEL 3）は研究者のあいだでよく一致、5 億 4000 万年前まで（LEVEL 2）はおおまかに一致、それより昔（LEVEL 1）は資料によって大きくちがいます
- 年表の出来事は小学生向けに言葉を選び、年代はおおよその値です。出典は `data/events.json` に書き足してください

## 参考資料

- Müller, R. D., Flament, N., Cannon, J., Tetley, M. G., Williams, S. E., Cao, X., Bodur, Ö. F., Zahirovic, S., and Merdith, A. (2022). A tectonic-rules-based mantle reference frame since 1 billion years ago – implications for supercontinent cycles and plate–mantle system evolution. *Solid Earth*, 13, 1127–1159. https://doi.org/10.5194/se-13-1127-2022
- Merdith, A. S. et al. (2021). Extending full-plate tectonic models into deep time: Linking the Neoproterozoic and the Phanerozoic. *Earth-Science Reviews*, 214, 103477. https://doi.org/10.1016/j.earscirev.2020.103477
- [GPlates Web Service](https://gwsdoc.gplates.org/)（EarthByte Group, The University of Sydney）
- 地質時代の区分と年代: International Commission on Stratigraphy, International Chronostratigraphic Chart (2023)
- [d3-geo](https://d3js.org/d3-geo)

## ライセンスと出典

- プログラム: [MIT License](LICENSE)
- 文章（ページ内の説明・年表の文・README）: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja)
- 陸地と回転のデータ: EarthByte Group / GPlates Web Service（[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja)）を加工して作成。使うときは「EarthByte / GPlates Web Service, Müller et al. 2022, Merdith et al. 2021」と出典を添えてください
- d3: ISC License

くわしくは [LICENSE-CONTENT.md](LICENSE-CONTENT.md) を読んでください。参加する人は [行動規範](CODE_OF_CONDUCT.md) を守ってください。
