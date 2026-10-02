#!/bin/bash
# GitHub CLI（gh）でリポジトリを作成し、GitHub Pages（main ブランチ配信）を有効化します。
# 事前に git init とコミットを済ませておいてください。
#   使い方: ./publish.sh [リポジトリ名] [GitHub のアカウント]
#   アカウントを指定すると gh auth switch でそのアカウントに切り替えてから作成します（複数アカウントでログイン済みのとき）
set -e
REPO=${1:-world-map}
OWNER=${2:-$(gh api user -q .login)}
cd "$(dirname "$0")"
if [ "$(gh api user -q .login)" != "$OWNER" ]; then gh auth switch -u "$OWNER"; fi
gh repo create "$OWNER/$REPO" --public --source=. --push \
  --description "10億年前から現在までの大陸の動きを、スライダーで見る日本語教材。だれでも年表の出来事や「見る場所」を追加できます（GitHub の練習にもどうぞ）" \
  --homepage "https://$OWNER.github.io/$REPO/"
gh api -X POST "repos/$OWNER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null
# issue フォームが使うラベル
gh label create "年表・地域" --repo "$OWNER/$REPO" --color 4d7933 --description "年表の出来事・見る場所のリクエスト、つくります宣言" --force
gh label create "説明・データ" --repo "$OWNER/$REPO" --color 1d76db --description "説明文や年代の修正提案" --force
gh label create "不具合" --repo "$OWNER/$REPO" --color d73a4a --description "表示や操作のおかしさ" --force
gh label create "練習" --repo "$OWNER/$REPO" --color 0e8a16 --description "GitHub の練習用（気軽にどうぞ）" --force
gh label create "good first issue" --repo "$OWNER/$REPO" --color 7057ff --description "はじめての方歓迎" --force
gh repo edit "$OWNER/$REPO" --add-topic education --add-topic geography --add-topic earth-science --add-topic plate-tectonics --add-topic gplates --add-topic d3 --add-topic first-timers-only
echo "公開URL（反映まで1〜2分）: https://$OWNER.github.io/$REPO/"
