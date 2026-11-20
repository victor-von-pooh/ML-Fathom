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

# 同じ会員が複数の行にいる表 (分割をまたぐグループの重なりを確かめる)
uv run python - "$WORK/visits.csv" <<'PY'
import sys

import numpy as np
import pandas as pd

rng = np.random.default_rng(1)
rows = 120
pd.DataFrame({
    "member_id": np.repeat(np.arange(30), 4),
    "spend": rng.normal(100, 20, rows).round(),
    "churned": rng.choice(["yes", "no"], rows),
}).to_csv(sys.argv[1], index=False)
PY

# 目的の列が一部の行にだけある表 (正解の欠けた行を unlabeled の分割に残す)
uv run python - "$WORK/sensors.csv" <<'PY'
import sys

import numpy as np
import pandas as pd

rng = np.random.default_rng(2)
rows = 100
frame = pd.DataFrame({
    "level": rng.normal(0, 1, rows).round(3),
    "spread": rng.normal(1, 0.2, rows).round(3),
    "status": rng.choice(["normal", "fault"], rows),
})
frame.loc[60:, "status"] = np.nan
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

# ML-Pathfinder の置き場に保存した問題の設定 (プロジェクトを作った記録付き.
# 書き出し先はプロジェクトの中のまだ無い場所)
uv run python - "$WORK" <<'PY'
import sys
from pathlib import Path

import ml_quest
from ml_quest.examples import example_problem

work = Path(sys.argv[1])
project = work / "project"
project.mkdir()
problem = ml_quest.attach_data(example_problem("総菜の作る量"),
                               work / "sozai.csv")
problem["name"] = "総菜のプロジェクト"
problem["project"] = {
    "path": str(project), "dataset": str(project / "data" / "dataset"),
    "model_spec": str(project / "models" / "model.yaml"),
}
ml_quest.save_problem(problem, work / "pathfinder" / "problems" / "sozai")
PY

# 多視点の撮影の見本 (中心の周りを 6 枚で一周. 画像, 生の深度, 信頼度)
uv run python - "$WORK/captures/round" <<'PY'
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

place = Path(sys.argv[1])
for name in ("images", "raw_depth", "confidence"):
    (place / name).mkdir(parents=True)
frames = []
for index in range(6):
    angle = 2 * math.pi * index / 6
    position = np.array([math.sin(angle), 0.2, math.cos(angle)])
    back = position / np.linalg.norm(position)
    right = np.cross([0.0, 1.0, 0.0], back)
    right = right / np.linalg.norm(right)
    pose = np.eye(4)
    pose[:3, 0], pose[:3, 1] = right, np.cross(back, right)
    pose[:3, 2], pose[:3, 3] = back, position
    Image.new("RGB", (64, 48), (40 * index, 120, 200)).save(
        place / "images" / f"{index}.jpg"
    )
    depth = np.linspace(900, 1100, 48 * 64).reshape(48, 64)
    Image.fromarray(depth.astype(np.uint16)).save(
        place / "raw_depth" / f"{index}.png"
    )
    Image.fromarray(np.full((48, 64), 200, np.uint8)).save(
        place / "confidence" / f"{index}.png"
    )
    frames.append({
        "file_path": f"images/{index}.jpg",
        "transform_matrix": pose.tolist(),
        "raw_depth_file_path": f"raw_depth/{index}.png",
        "confidence_file_path": f"confidence/{index}.png",
    })
(place / "transforms.json").write_text(json.dumps({
    "fl_x": 50.0, "fl_y": 50.0, "cx": 32.0, "cy": 24.0, "w": 64, "h": 48,
    "depth": {"depth_format": "png16_millimeter", "invalid_value": 0},
    "coordinate_convention": {"world_up": [0.0, 1.0, 0.0]},
    "frames": frames,
}), "utf-8")
PY

# ファイルの組の見本 (ML-EDA の合成の見本). 画像と領域 (組にならない領域を
# 1 つ足す), 大きさの混ざった画像と領域, 単純な形の撮影と正確な点群
uv run python - "$WORK" <<'PY'
import shutil
import sys
from pathlib import Path

from ml_eda.synthetic import write_image_masks, write_shape_captures

work = Path(sys.argv[1])
sample = write_image_masks(work / "pairs", count=8)
write_image_masks(work / "mixed", count=6, sizes=[(24, 32), (30, 18)])
shutil.copyfile(sample["masks"] / "sample_000.png",
                sample["masks"] / "orphan.png")
write_shape_captures(work / "shapes", views=4, points=300)
PY

# ML-Pathfinder の置き場に, 正解が画像の領域の問題の設定 (上の画像と領域を
# 入れ, プロジェクトを作った記録付き)
uv run python - "$WORK" <<'PY'
import sys
from pathlib import Path

import ml_quest
from ml_quest.examples import example_problem

work = Path(sys.argv[1])
problem = example_problem("総菜の作る量")
problem["ml"]["parts"] = [{}]
for key in ("decision", "basis", "current"):
    problem["action"].pop(key, None)
answers = [("role", "predict"), ("what", "画素ごとの領域"), ("item", "1 枚"),
           ("baseline", "今のやり方"), ("evaluation.link", "損が減る"),
           ("unit", "pair"), ("output", "region"),
           ("target.source", "process"), ("target.process.name", "塗り分け"),
           ("method", "scratch"), ("target.kind", "mask"),
           ("evaluation.metric", "iou")]
for key, value in answers:
    problem = ml_quest.answer(problem, f"ml.parts.0.{key}", value)
problem = ml_quest.attach_data(problem, work / "pairs")
problem["name"] = "領域のプロジェクト"
project = work / "mask_project"
project.mkdir()
problem["project"] = {"path": str(project),
                      "dataset": str(project / "outputs" / "dataset")}
ml_quest.save_problem(problem, work / "pathfinder" / "problems" / "masks")
PY

# データの置き場と ML-Pathfinder の置き場も作業用のディレクトリにし,
# 決まったトークンで起動
ML_FATHOM_HOME="$WORK/home" ML_PATHFINDER_HOME="$WORK/pathfinder" \
  ML_FATHOM_TOKEN=e2e-token \
  exec uv run ml-fathom --port "$PORT"
