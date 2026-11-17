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

# 問題の設定の見本 (総菜の作る量) に, 日々の売れた数の表を入れて保存する
uv run python - "$WORK" <<'PY'
import sys
from pathlib import Path

import ml_quest
import pandas as pd
from ml_quest.examples import example_problem

work = Path(sys.argv[1])
rows = [
    {"date": day.strftime("%Y-%m-%d"), "store": store, "item": item,
     "sales": 10 + day.day_of_week, "temperature_forecast": 15.0,
     "promo": 0, "customers": (10 + day.day_of_week) * 3}
    for day in pd.date_range("2025-01-01", periods=40)
    for store in ("east", "west") for item in ("a", "b")
]
pd.DataFrame(rows).to_csv(work / "sozai.csv", index=False)
problem = ml_quest.attach_data(example_problem("総菜の作る量"),
                               work / "sozai.csv")
ml_quest.save_problem(problem, work / "problem")
PY

# データの置き場も作業用のディレクトリにし, 決まったトークンで起動
ML_FATHOM_HOME="$WORK/home" ML_FATHOM_TOKEN=e2e-token \
  exec uv run ml-fathom --port "$PORT"
