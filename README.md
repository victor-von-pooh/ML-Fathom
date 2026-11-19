# ML-Fathom

機械学習に使うデータを, 画面の上で分析 (EDA) し, 前処理して学習用に書き出すローカルの Web アプリ.

[ML-EDA](https://github.com/victor-von-pooh/ML-EDA) を使い, 表, 時系列, 画像, 文, 点群, 多視点の撮影などのデータを読み込んで, 列の型, 分布, 欠損, 関係, 学習の前に確かめた方がよいこと (気付き) を見られる. 前処理の手順を画面で組み立て, 1 段ずつ前と後を確かめて, [ML-Found](https://github.com/victor-von-pooh/ML-Found) の学習スクリプトがそのまま読み込めるデータセットに書き出す.

設計の方針は [docs/DESIGN.md](docs/DESIGN.md) を参照.

## 必要なもの

- [uv](https://docs.astral.sh/uv/) (Python は uv が用意する. 3.10 以上)
- Node.js 24 以上と [pnpm](https://pnpm.io/) 11 以上 (`corepack enable` で `package.json` の版が入る)

## 導入と起動

```bash
git clone --recursive https://github.com/victor-von-pooh/ML-Fathom.git
cd ML-Fathom
make setup   # submodule, Python と Node.js の依存
make serve   # 画面をビルドして http://127.0.0.1:8767 で起動 (使う間は端末を開いたままにする. Ctrl+C で止める)
```

起動すると `ML-Fathom を開く: http://127.0.0.1:8767/api/auth?token=...` の行が出るので, その URL をブラウザで開く (トークンは起動ごとに変わる). 毎回同じトークンにする場合は環境変数 `ML_FATHOM_TOKEN` で指定する. ポートは `make serve PORT=8800` のように変えられる.

## 使い方

画面ごとの詳しい手順は [操作ガイド](docs/GUIDE.md) (見本のデータで試せる「やってみる」付き).

1. 試すだけなら「見本のデータを入れる」で, 表, 時系列, 画像, 文, 点群の見本を登録できる. 自分のデータは「データを追加」でファイル (csv, tsv, json, jsonl, parquet, xlsx, npy, txt, ply, pcd, xyz など) かディレクトリ (クラスごとのフォルダに分けた画像, 文, 点群. `transforms.json` を持つ多視点の撮影) を選ぶ. 形式を判定した読み込みの候補から選んで「追加」
2. データの画面の上の「目的の列」で, 予測したい列を選ぶ (分析に目的の列との関係が加わり, 前処理の分割とタスクに使う)
3. 「概要と気付き」「列」「関係」「時系列」「中身を見る」「表の中身」でデータの特徴を見る. 画像は並べて, 点群は 3D で回して見られる. 多視点の撮影は, 上から見たカメラの配置と各枚の画像, 深度, 信頼度を見られる (前処理と書き出しは今は扱わない)
4. 「前処理と書き出し」で手順を組み立てる. 「学習できる形にする手順を作る」で列の型から手順を作り, 「気付きから手順を足す」で気付きに合う手順を足せる. 手順の番号を押すと, その手順の前と後を見られる. 画像, 文, 点群は「学習用の配列にする手順を作る」で, 大きさや長さや点の数をそろえる手順を作る
5. 名前を付けて「学習用に書き出す」. 置き場の `datasets/<名前>/` に書き出す

**問題の設定から始める**: ML-Pathfinder で決めた問題の設定 (`problem.yaml` か, それを持つディレクトリ) を「問題の設定から始める」で選ぶと, 問題の設定に入れたデータを登録し, 目的の列, タスク, 分割, 使わない列, 決める時点で分かる過去の値を決めた状態で始まる. 「前処理と書き出し」の先頭の「問題の設定」のカードに, 編集中のレシピと問題の設定の食い違いが出る. 予測の時点で分からない列をレシピで使った場合は, 分かる列にするかレシピで落とすかを選び, 「問題の設定に書き戻す」で問題の設定に戻す

置き場は `~/.ml-fathom/` (環境変数 `ML_FATHOM_HOME` で変えられる). 元のデータのファイルは書き換えない.

### 書き出したデータセットで学習する

```python
from ml_eda import load_dataset
from torch.utils.data import DataLoader, TensorDataset

dataset = load_dataset("~/.ml-fathom/datasets/<名前>")
train_loader = DataLoader(TensorDataset(*dataset.tensors("train")), batch_size=64, shuffle=True)
valid_loader = DataLoader(TensorDataset(*dataset.tensors("valid")), batch_size=64)
# 入力の形: dataset.info["splits"]["train"]["shape"][1:], 分類のクラスの数: len(dataset.info["classes"])
```

画像と領域, 多視点の撮影と点群のように入力と正解がファイルの組のデータは, 「データセット」の「ファイルの組を書き出す」で書き出し (`dataset.yaml` の版 2), `load_items` で読む.

```python
from ml_eda import load_items

dataset = load_items("~/.ml-fathom/datasets/<名前>")
item = dataset.split("train")[0]   # {"id", "split", "group", 項目の名前: 中身}
```

学習の環境に ML-EDA を入れる方法は ML-EDA の README を参照.

## 開発

```bash
make dev-backend    # API (変更を自動で読み直す. 開く URL を出す)
make dev-frontend   # 画面 (別の端末で)
make check          # lint, 型検査, テスト
cd frontend && pnpm e2e   # 画面の通しのテスト
```

| ディレクトリ | 内容 |
| --- | --- |
| `backend/` | API (Python, FastAPI). ML-EDA を呼び, 登録したデータとレシピを保存する |
| `frontend/` | 画面 (TypeScript, React, Vite, ECharts) |
| `ML-EDA/` | submodule |
| `ML-Quest/` | submodule (問題の設定から始めるため) |
| `docs/DESIGN.md` | 設計の方針と段階 |

## ライセンス

MIT
