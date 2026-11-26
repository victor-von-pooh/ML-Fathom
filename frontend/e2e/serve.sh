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

# 客ごとの注文の時系列 (グループと時刻の組の分割, グループの層化を確かめる).
# 客は 40 人で, 現れる日をずらす. amount はほぼ全て違う値
uv run python - "$WORK/orders.csv" <<'PY'
import sys

import numpy as np
import pandas as pd

rng = np.random.default_rng(3)
rows = []
for customer in range(40):
    start = pd.Timestamp("2024-01-01") + pd.Timedelta(days=customer)
    for visit in range(4):
        rows.append({
            "customer": f"c{customer:02d}",
            "date": (start + pd.Timedelta(days=visit * 7)).strftime("%Y-%m-%d"),
            "amount": round(float(rng.normal(100, 30)), 2),
            "returned": "yes" if customer % 4 == 0 else "no",
        })
pd.DataFrame(rows).to_csv(sys.argv[1], index=False)
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
from ml_quest import example_problem

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
from ml_quest import example_problem

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

# 音声の見本 (2 クラスの正弦波の WAVE. 1 つは再生と波形の上限より長い)
uv run python - "$WORK/sounds" <<'PY'
import sys
import wave
from pathlib import Path

import numpy as np

root = Path(sys.argv[1])
rate = 8000
for label, tone, seconds in (("low", 220, 1.0), ("high", 880, 35.0)):
    (root / label).mkdir(parents=True)
    times = np.arange(int(rate * seconds)) / rate
    values = (0.5 * np.sin(2 * np.pi * tone * times) * 32767).astype("<i2")
    with wave.open(str(root / label / f"{label}.wav"), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(values.tobytes())
PY

# 外を指すリンクを持つ音声のディレクトリ (中の 1 件と, 外の音声へのリンク.
# 既定では読まず, 読み込みの設定 follow_links で読む)
mkdir -p "$WORK/linked"
cp "$WORK/sounds/low/low.wav" "$WORK/linked/inside.wav"
cp "$WORK/sounds/low/low.wav" "$WORK/shared.wav"
ln -s "$WORK/shared.wav" "$WORK/linked/outside.wav"

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
# 領域の無い画像を 1 つ持つ組 (正解の無い件を unlabeled の分割に書く)
partial = write_image_masks(work / "partial", count=6)
shutil.copyfile(partial["images"] / "sample_000.png",
                partial["images"] / "lonely.png")
PY

# ML-Pathfinder の置き場に, 正解が画像の領域の問題の設定 (上の画像と領域を
# 入れ, プロジェクトを作った記録付き)
uv run python - "$WORK" <<'PY'
import sys
from pathlib import Path

import ml_quest
from ml_quest import example_problem

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

# ML-Pathfinder の置き場に, 作るものが表の問題の設定 (ID の列を持つ客の表を
# 入れ, ML-Quest で骨組みのプロジェクトを作った記録付き)
uv run python - "$WORK" <<'PY'
import sys
from pathlib import Path

import ml_quest
import numpy as np
import pandas as pd
from ml_quest import example_problem

work = Path(sys.argv[1])
rng = np.random.default_rng(4)
rows = 80
pd.DataFrame({
    "customer_id": [f"u{index:03d}" for index in range(rows)],
    "age": rng.normal(40, 10, rows).round(1),
    "visits": rng.integers(0, 10, rows),
    "city": rng.choice(["a", "b", "c"], rows),
}).to_csv(work / "customers.csv", index=False)
problem = example_problem("総菜の作る量")
problem["ml"]["parts"] = [{}]
for key in ("decision", "basis", "current"):
    problem["action"].pop(key, None)
answers = [("role", "generate"), ("unit", "row"), ("output", "table"),
           ("target.source", "self"), ("target.kind", "table"),
           ("method", "scratch"), ("what", "客の表に似た行"),
           ("item", "客の 1 行"), ("baseline", "手で作る"),
           ("evaluation.metric", "column_distance"),
           ("evaluation.link", "近いほど元の表の代わりに使える")]
for key, value in answers:
    problem = ml_quest.answer(problem, f"ml.parts.0.{key}", value)
problem = ml_quest.attach_data(problem, work / "customers.csv")
problem["name"] = "合成の表のプロジェクト"
project = work / "table_project"
ml_quest.make_project(problem, project)
problem = ml_quest.record_project(problem, project)
ml_quest.save_problem(problem, work / "pathfinder" / "problems" / "table")
PY

# ML-Pathfinder の置き場に, 並べるで学習する問題の設定 (会員と品の反応の表を
# 入れ, ML-Quest で骨組みのプロジェクトを作った記録付き. 反応の強さ 0 の行と
# 会員の欠けた行を含む)
uv run python - "$WORK" <<'PY'
import sys
from pathlib import Path

import ml_quest
import numpy as np
import pandas as pd
from ml_quest import example_problem

work = Path(sys.argv[1])
rng = np.random.default_rng(5)
rows = 300
frame = pd.DataFrame({
    "member": [f"m{value:02d}" for value in rng.integers(0, 30, rows)],
    "item_id": [f"i{value:02d}"
                for value in np.minimum(rng.geometric(0.2, rows), 25)],
    "ts": pd.date_range("2025-01-01", periods=rows, freq="h").strftime(
        "%Y-%m-%d %H:%M:%S"
    ),
    "qty": rng.integers(0, 3, rows),
})
frame.loc[:1, "member"] = None
frame.to_csv(work / "reactions.csv", index=False)
problem = example_problem("総菜の作る量")
problem["ml"]["parts"] = [{}]
for key in ("decision", "basis", "current"):
    problem["action"].pop(key, None)
problem = ml_quest.answer(problem, "information.columns", list(frame.columns))
answers = [("role", "rank"), ("unit", "query"), ("output", "ranking"),
           ("target.source", "feedback"), ("method", "scratch"),
           ("what", "会員ごとに勧める品"), ("item", "会員ごとの品の並び"),
           ("baseline", "人気順"), ("evaluation.metric", "ndcg"),
           ("evaluation.link", "上位に買う品が来るほど売上が増える"),
           ("rank.user", "member"), ("rank.item", "item_id"),
           ("rank.time", "ts"), ("rank.reaction", "qty"), ("rank.k", 5)]
for key, value in answers:
    problem = ml_quest.answer(problem, f"ml.parts.0.{key}", value)
problem = ml_quest.attach_data(problem, work / "reactions.csv")
problem["name"] = "推薦のプロジェクト"
project = work / "rank_project"
ml_quest.make_project(problem, project)
problem = ml_quest.record_project(problem, project)
ml_quest.save_problem(problem, work / "pathfinder" / "problems" / "rank")
PY

# 群分けの表 (正解の無い 1 行 1 人の客の表. 使った額, 回数, 地域で 3 つの
# はっきりした群に分かれ, 会員の番号で行を見分ける)
uv run python - "$WORK/segments.csv" <<'PY'
import sys

import numpy as np
import pandas as pd

rng = np.random.default_rng(6)
size = 40
pd.DataFrame({
    "member": [f"m{index:03d}" for index in range(size * 3)],
    "spend": np.concatenate([
        rng.normal(center, 1.0, size) for center in (5.0, 50.0, 95.0)
    ]).round(2),
    "visits": np.concatenate([
        rng.normal(center, 0.5, size) for center in (1.0, 8.0, 15.0)
    ]).round(1),
    "region": ["east"] * size + ["west"] * size + ["north"] * size,
}).to_csv(sys.argv[1], index=False)
PY

# まとめるの問題の設定 (群分けの表を入れ, 群を作る列, 会員の番号, 群の数を
# 答えた. ML-Quest でプロジェクトを作り, 記録とともに ML-Pathfinder の置き場に
# 保存する)
uv run python - "$WORK" <<'PY'
import sys
from pathlib import Path

import ml_quest
from ml_quest import example_problem

work = Path(sys.argv[1])
problem = example_problem("解約の引き止め")
problem["ml"]["parts"] = [{}]
for key in ("decision", "basis", "current"):
    problem["action"].pop(key, None)
problem = ml_quest.answer(
    problem, "information.columns", ["member", "spend", "visits", "region"]
)
answers = [("role", "group"), ("unit", "row"), ("output", "cluster"),
           ("target.source", "none"), ("method", "scratch"),
           ("what", "客の群"), ("item", "客 1 人"),
           ("baseline", "今の区分 (地域)"),
           ("evaluation.metric", "silhouette"),
           ("evaluation.link", "群ごとに連絡の仕方を変える"),
           ("group.columns", ["spend", "visits"]), ("group.id", "member"),
           ("group.k", 3), ("group.stability", "sample")]
for key, value in answers:
    problem = ml_quest.answer(problem, f"ml.parts.0.{key}", value)
problem = ml_quest.attach_data(problem, work / "segments.csv")
problem["name"] = "客の群のプロジェクト"
project = work / "group_project"
ml_quest.make_project(problem, project)
problem = ml_quest.record_project(problem, project)
ml_quest.save_problem(problem, work / "pathfinder" / "problems" / "group")
PY

# 値段を変えた売れ行きの記録 (商品ごとの元の値段を無作為に 0.8 から 1.2 倍に
# 変え, 値段を上げると売れた数が減る. 商品 p9 は試した値段が 1 つ)
uv run python - "$WORK/sales.csv" <<'PY'
import sys

import numpy as np
import pandas as pd

rng = np.random.default_rng(7)
rows = 240
product = rng.integers(0, 10, rows)
base = 100 + 20 * product
scale = np.where(product == 9, 1.0,
                 rng.choice([0.8, 0.9, 1.0, 1.1, 1.2], rows))
pd.DataFrame({
    "record_id": [f"r{index:03d}" for index in range(rows)],
    "product_id": [f"p{index}" for index in product],
    "category": np.where(product < 5, "food", "tool"),
    "weekday": rng.integers(0, 7, rows),
    "price": (base * scale).round(0),
    "units": rng.poisson(20 * scale ** -1.5),
    "unit_cost": (base * 0.6).round(0),
}).to_csv(sys.argv[1], index=False)
PY

# 記録した軌跡の見本 (ML-EDA のテストの見本を写す. 守りの付いた Discrete の
# 行動の軌跡, Box の行動の軌跡と, 行動を選んだ確率の列を持つ軌跡. どれも表と
# 説明の JSON)
mkdir -p "$WORK/trajectories"
cp ../ML-EDA/tests/data/trajectories/{guarded,box,prob}.{csv,json} "$WORK/trajectories/"

# データの置き場と ML-Pathfinder の置き場も作業用のディレクトリにし,
# 決まったトークンで起動
ML_FATHOM_HOME="$WORK/home" ML_PATHFINDER_HOME="$WORK/pathfinder" \
  ML_FATHOM_TOKEN=e2e-token \
  exec uv run ml-fathom --port "$PORT"
