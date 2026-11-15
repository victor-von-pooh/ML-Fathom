#!/usr/bin/env bash
# 画面の通しのテスト (Playwright) 用に, 作業用の置き場と表のデータを作ってからアプリを起動する.
# 画面は pnpm build で作っておく
set -euo pipefail

cd "$(dirname "$0")"
WORK="$PWD/.work"
PORT="${E2E_PORT:-8793}"

# 前回の結果を消し, 欠損とカテゴリと 2 クラスの目的の列を持つ表を作る
rm -rf "$WORK"
mkdir -p "$WORK"
cd ../../backend
uv run python - "$WORK/people.csv" <<'PY'
import sys

import numpy as np
import pandas as pd

rng = np.random.default_rng(0)
rows = 200
frame = pd.DataFrame({
    "id": range(rows),
    "age": rng.normal(40, 12, rows).round(),
    "income": np.exp(rng.normal(10, 1, rows)).round(),
    "city": rng.choice(["tokyo", "osaka", "nagoya"], rows),
    "bought": rng.choice(["yes", "no"], rows),
})
frame.loc[:70, "age"] = np.nan
frame.to_csv(sys.argv[1], index=False)
PY

# データの置き場も作業用のディレクトリにし, 決まったトークンで起動
ML_FATHOM_HOME="$WORK/home" ML_FATHOM_TOKEN=e2e-token \
  exec uv run ml-fathom --port "$PORT"
