# ライセンスのまとめ

| 何が | どのファイル | ライセンス |
|---|---|---|
| プログラム | `lib/` の自作の `.js`（d3 を除く）、`_data/` の `.py`、`index.html`、`test/` | [MIT License](LICENSE) |
| 解説文 | `index.html` の文章、`README.md` などのドキュメント、`data/events.json` の `summary`・`text` | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja)（表示・継承） |
| データ | `data/pieces.json`、`data/rotations.json`、`data/rotations.bin` | EarthByte Group の [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja) のデータを加工したもの（出典の表示が必要） |
| 外部ライブラリ | d3 v7（`lib/d3.v7.min.js`） | ISC License |

## データの出典（表示してください）

大陸の海岸線と動きのデータは、EarthByte Group（シドニー大学）が CC BY 4.0 で公開しているものを加工して作っています。

```
EarthByte / GPlates Web Service, Müller et al. 2022, Merdith et al. 2021
```

- Müller, R. D. et al. (2022) "A tectonic-rules-based mantle reference frame since 1 billion years ago", Solid Earth 13, 1127–1159. https://doi.org/10.5194/se-13-1127-2022
- Merdith, A. S. et al. (2021) "Extending full-plate tectonic models into deep time: Linking the Neoproterozoic and the Phanerozoic", Earth-Science Reviews 214, 103477.
- GPlates Web Service: https://gws.gplates.org/

## 使うときにしてほしいこと

- 授業や資料で使うときは「うごく世界地図（world-map contributors）」と、上の EarthByte の出典を添えてください
- 解説文を改変して使うときは、同じ CC BY-SA 4.0 で共有してください
- データを使うときは、CC BY 4.0 の条件（出典の表示、変更したことの明示）を守ってください

## 投稿（プルリクエスト）のライセンス

プルリクエストを送った時点で、プログラムの部分は MIT License、文章の部分は CC BY-SA 4.0 で公開することに同意したものとします。

- 教科書・図鑑・論文の文章や図をそのまま写さず、自分の言葉で説明して、参考資料として出典を示してください
- 年表の出来事は、自分の言葉で書いてください。ほかの本やサイトの文章を写したものは受け取れません
