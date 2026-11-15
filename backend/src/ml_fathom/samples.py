import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd


def write_samples(root: Path, seed: int = 0) -> dict[str, Path]:
    """
    操作を試すための見本のデータを, 無いものだけ種類ごとに書く関数

    どれも学習の前に直すことを含める (欠損, ID, リーク, 時刻の抜け,
    大きさの違う画像, 読めないファイル, 点の数の違う点群など). 既にある
    見本は書き直さない (利用者が変えた中身を残す)

    Parameters
    ----------
    root: Path
        書くディレクトリ (無ければ作る)
    seed: int = 0
        乱数のシード (見本ごとに seed + 番号)

    Returns
    ----------
    paths: dict[str, Path]
        見本の名前から, ファイルかディレクトリ
    """
    # 見本ごとに別の乱数にし, 一部だけ書き直しても中身が変わらないように.
    # 書きかけを読まないように, 別の名前に書いてから置き換える
    root.mkdir(parents=True, exist_ok=True)
    paths = {}
    for number, (name, (place, _, writer)) in enumerate(SAMPLES.items()):
        path = root / place
        if not path.exists():
            writing = root / f".{place}.writing"
            shutil.rmtree(writing, ignore_errors=True)
            writing.unlink(missing_ok=True)
            writer(writing, np.random.default_rng(seed + number))
            writing.replace(path)
        paths[name] = path

    return paths


def sample_target(name: str) -> Optional[str]:
    """
    見本の目的の列を返す関数

    Parameters
    ----------
    name: str
        見本の名前

    Returns
    ----------
    target: Optional[str]
        目的の列 (画像などはフォルダの名前のラベルなので None)
    """
    target = SAMPLES[name][1]

    return target


def write_customers(path: Path, rng: np.random.Generator) -> None:
    """
    解約の予測の表を csv で書く関数

    Parameters
    ----------
    path: Path
        書く csv
    rng: np.random.Generator
        乱数

    Returns
    ----------
    None
    """
    # 顧客の属性と利用の様子
    rows = 1500
    tenure = rng.integers(1, 72, rows)
    monthly = rng.normal(70, 25, rows).clip(15, 150).round(2)
    plan = rng.choice(["basic", "standard", "premium"], rows, p=[.5, .35, .15])
    contract = rng.choice(
        ["monthly", "yearly", "two_year"], rows, p=[.55, .3, .15]
    )
    calls = rng.poisson(1.5, rows)
    data_gb = np.exp(rng.normal(2.5, 1.0, rows)).round(1)

    # 解約の確率 (短い契約, 多い問い合わせ, 短い利用期間で上がる)
    logit = (
        -1.0 + 1.2 * (contract == "monthly") - 0.8 * (contract == "two_year")
        + 0.35 * calls - 0.03 * tenure
    )
    churn = rng.random(rows) < 1 / (1 + np.exp(-logit))

    # 欠損, カンマ付きの数 (読み込みで数になる), 答えから作った列 (リーク)
    frame = pd.DataFrame({
        "customer_id": [f"C{100000 + i}" for i in range(rows)],
        "tenure_months": tenure,
        "monthly_fee": monthly,
        "total_paid": [f"{v:,.0f}" for v in tenure * monthly],
        "plan": plan,
        "contract": contract,
        "support_calls": calls,
        "data_gb": data_gb,
        "cancel_reason_code": np.where(churn, rng.integers(1, 6, rows), 0),
        "churn": np.where(churn, "yes", "no"),
    })
    frame.loc[rng.random(rows) < 0.35, "monthly_fee"] = np.nan
    frame.loc[rng.random(rows) < 0.05, "plan"] = np.nan
    frame.to_csv(path, index=False)


def write_power(path: Path, rng: np.random.Generator) -> None:
    """
    1 時間ごとの電力の使用量と気温を csv で書く関数 (時刻の抜けを含む)

    Parameters
    ----------
    path: Path
        書く csv
    rng: np.random.Generator
        乱数

    Returns
    ----------
    None
    """
    # 1 日と 1 週間の周期に気温の影響を足す
    times = pd.date_range("2026-01-01", periods=24 * 90, freq="h")
    hours = np.arange(len(times))
    temperature = (
        8 + 6 * np.sin(2 * np.pi * (hours % 24 - 9) / 24)
        + hours / len(hours) * 6 + rng.normal(0, 1.5, len(hours))
    )
    weekday = (times.day_of_week < 5).astype(float)
    usage = (
        300 + 80 * np.sin(2 * np.pi * (hours % 24 - 14) / 24)
        + 60 * weekday + 4 * np.abs(temperature - 18)
        + rng.normal(0, 15, len(hours))
    )

    # センサーの停止で抜けた 2 か所
    frame = pd.DataFrame({
        "time": times.strftime("%Y-%m-%d %H:%M"),
        "usage_kwh": usage.round(1),
        "temperature": temperature.round(1),
    })
    drop = np.r_[500:530, 1400:1412]
    frame.drop(index=drop).to_csv(path, index=False)


def write_shapes(root: Path, rng: np.random.Generator) -> None:
    """
    円, 四角, 三角の画像をクラスのフォルダに書く関数

    大きさの違い, 灰色とカラーの混在, 読めないファイルを含める

    Parameters
    ----------
    root: Path
        書くディレクトリ
    rng: np.random.Generator
        乱数

    Returns
    ----------
    None
    """
    from PIL import Image, ImageDraw

    # クラスごとに, 位置と大きさと色をばらつかせて描く
    sizes = ((48, 48), (64, 64), (64, 48))
    for shape in ("circle", "square", "triangle"):
        folder = root / shape
        folder.mkdir(parents=True, exist_ok=True)
        for index in range(120):
            width, height = sizes[rng.integers(len(sizes))]
            noise = rng.normal(40, 15, (height, width, 3)).clip(0, 255)
            image = Image.fromarray(noise.astype(np.uint8))
            canvas = ImageDraw.Draw(image)
            radius = rng.uniform(0.2, 0.35) * min(width, height)
            cx = rng.uniform(radius, width - radius)
            cy = rng.uniform(radius, height - radius)
            color = tuple(int(v) for v in rng.integers(120, 256, 3))
            box = (cx - radius, cy - radius, cx + radius, cy + radius)
            if shape == "circle":
                canvas.ellipse(box, fill=color)
            elif shape == "square":
                canvas.rectangle(box, fill=color)
            else:
                canvas.polygon(
                    [(cx, cy - radius), (cx - radius, cy + radius),
                     (cx + radius, cy + radius)], fill=color
                )
            if rng.random() < 0.3:
                image = image.convert("L")
            image.save(folder / f"{index:03d}.png")

    # 途中で切れたファイル
    (root / "circle" / "broken.png").write_bytes(b"\x89PNG\r\n")


def write_reviews(root: Path, rng: np.random.Generator) -> None:
    """
    良い評価と悪い評価の短い文を, クラスのフォルダに 1 件 1 ファイルで
    書く関数

    Parameters
    ----------
    root: Path
        書くディレクトリ
    rng: np.random.Generator
        乱数

    Returns
    ----------
    None
    """
    # 評価の語と, どちらにも出る語を組み合わせる
    words = {
        "positive": ["great", "excellent", "love", "fast", "comfortable",
                     "recommend", "perfect", "happy"],
        "negative": ["broken", "slow", "poor", "disappointed", "refund",
                     "noisy", "cheap", "worst"],
    }
    common = ["the", "product", "it", "was", "very", "and", "delivery",
              "quality", "i", "this", "item", "really"]
    for label, chosen in words.items():
        folder = root / label
        folder.mkdir(parents=True, exist_ok=True)
        for index in range(150):
            count = int(rng.integers(6, 30))
            pool = chosen + common * 2
            text = " ".join(rng.choice(pool, count))
            (folder / f"{index:03d}.txt").write_text(text, encoding="utf-8")


def write_objects(root: Path, rng: np.random.Generator) -> None:
    """
    球, 立方体, 円柱の点群を, クラスのフォルダに PLY で書く関数
    (点の数を件ごとに変える)

    Parameters
    ----------
    root: Path
        書くディレクトリ
    rng: np.random.Generator
        乱数

    Returns
    ----------
    None
    """
    # 形ごとに表面の点を取り, 大きさを少し変える
    for shape in ("sphere", "cube", "cylinder"):
        folder = root / shape
        folder.mkdir(parents=True, exist_ok=True)
        for index in range(30):
            count = int(rng.integers(400, 1500))
            points = surface(shape, count, rng) * rng.uniform(0.5, 2.0)
            header = (
                "ply\nformat ascii 1.0\n"
                f"element vertex {count}\n"
                "property float x\nproperty float y\nproperty float z\n"
                "end_header\n"
            )
            body = "\n".join(
                " ".join(f"{v:.4f}" for v in point) for point in points
            )
            (folder / f"{index:03d}.ply").write_text(
                header + body + "\n", encoding="ascii"
            )


def surface(shape: str, count: int, rng: np.random.Generator) -> np.ndarray:
    """
    形の表面から点を取る関数

    Parameters
    ----------
    shape: str
        sphere, cube, cylinder のどれか
    count: int
        点の数
    rng: np.random.Generator
        乱数

    Returns
    ----------
    points: np.ndarray
        (count, 3) の座標
    """
    # 球は正規分布を半径 1 に, 立方体は 1 つの軸を ±1 に, 円柱は側面
    if shape == "sphere":
        points = rng.normal(0, 1, (count, 3))
        points /= np.linalg.norm(points, axis=1, keepdims=True)
    elif shape == "cube":
        points = rng.uniform(-1, 1, (count, 3))
        axis = rng.integers(0, 3, count)
        points[np.arange(count), axis] = rng.choice([-1.0, 1.0], count)
    else:
        angle = rng.uniform(0, 2 * np.pi, count)
        points = np.stack(
            [np.cos(angle), np.sin(angle), rng.uniform(-1, 1, count)], axis=1
        )
    points = points + rng.normal(0, 0.02, points.shape)

    return points


# 見本の名前から, 置き場の中の場所, 目的の列, 書く関数
SAMPLES: dict[str, tuple[str, Optional[str], Callable[[Path, Any], None]]] = {
    "顧客の解約 (表)": ("customers.csv", "churn", write_customers),
    "電力の使用量 (時系列)": ("power.csv", "usage_kwh", write_power),
    "図形 (画像)": ("shapes", None, write_shapes),
    "レビュー (文)": ("reviews", None, write_reviews),
    "物体 (点群)": ("objects", None, write_objects),
}
