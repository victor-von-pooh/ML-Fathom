import csv
from pathlib import Path
from typing import Any

import ml_eda
from fastapi import HTTPException

from ml_fathom.jsonable import to_json

# 記録した軌跡の読み込みの名前と種類 (ML-EDA の読み込みの登録簿には無く,
# load_trajectory で読む)
TRAJECTORY_LOADER = "trajectory"
TRAJECTORY_KIND = "trajectory"

# 軌跡として読むファイルの拡張子 (表と説明)
TRAJECTORY_SUFFIXES = (".csv", ".parquet", ".json")

# 読み込みの候補の確からしさ (読めた軌跡は, 表として読む候補より先に)
TRAJECTORY_SCORE = 0.95

# CSV と JSON の先頭を確かめる大きさ (大きなファイルを候補を出すために
# 全て読まない)
HEADER_BYTES = 64 << 10


def csv_header_fits(path: Path) -> bool:
    """
    CSV の見出しに, エピソードと歩の列があるかを返す関数

    軌跡でない大きな表を, 候補を調べるために全て読まないように, 読む前に
    見出しだけを見る

    Parameters
    ----------
    path: Path
        CSV のファイル

    Returns
    ----------
    fits: bool
        見出しに episode と step の列があるか (読めなければ False)
    """
    # 先頭の BOM を除いた 1 行目
    try:
        with path.open("rb") as handle:
            head = handle.read(HEADER_BYTES)
    except OSError:
        return False
    line = head.decode("utf-8-sig", errors="replace").splitlines()[:1]
    names = next(csv.reader(line), []) if line else []
    fits = {"episode", "step"} <= {name.strip() for name in names}

    return fits


def parquet_header_fits(path: Path) -> bool:
    """
    Parquet のスキーマに, エピソードと歩の列があるかを返す関数

    行を読まずに, ファイルの終わりのスキーマの列の名前だけを見る

    Parameters
    ----------
    path: Path
        Parquet のファイル

    Returns
    ----------
    fits: bool
        スキーマに episode と step の列があるか (読めなければ False)
    """
    # pyarrow は ML-EDA の任意の依存 [parquet] (このアプリは all で入れる)
    try:
        import pyarrow.parquet as pq

        names = set(pq.read_schema(path).names)
    except Exception:  # 壊れたファイルは候補にしないだけ
        return False
    fits = {"episode", "step"} <= names

    return fits


def json_header_fits(path: Path) -> bool:
    """
    JSON の先頭が, 軌跡の説明 (版と表の名前を持つ辞書) に見えるかを返す
    関数

    読み込みの表の JSON (行の並び) を, 候補を出すために全て読まないよう
    に, 先頭の小さな範囲だけを見る

    Parameters
    ----------
    path: Path
        JSON のファイル

    Returns
    ----------
    fits: bool
        辞書で始まり, format_version と file の鍵を含むか (読めなければ
        False)
    """
    try:
        with path.open("rb") as handle:
            head = handle.read(HEADER_BYTES)
    except OSError:
        return False
    text = head.decode("utf-8-sig", errors="replace").lstrip()
    fits = (
        text.startswith("{")
        and '"format_version"' in text and '"file"' in text
    )

    return fits


# 拡張子ごとの, 読む前の見出しの確かめ
HEADER_CHECKS = {
    ".csv": csv_header_fits,
    ".parquet": parquet_header_fits,
    ".json": json_header_fits,
}


def may_be_trajectory(path: Path) -> bool:
    """
    読む前の見出しだけで, 記録した軌跡でありうるかを返す関数

    Parameters
    ----------
    path: Path
        場所

    Returns
    ----------
    fits: bool
        表か説明のファイルで, 見出しが軌跡に合うか
    """
    check = HEADER_CHECKS.get(path.suffix.lower())
    fits = path.is_file() and check is not None and check(path)

    return fits


def trajectory_files(path: Path) -> list[Path]:
    """
    軌跡を読むときに見るファイル (渡した場所と, 同じ名前の表と説明) を
    返す関数

    Parameters
    ----------
    path: Path
        登録した場所 (表か説明)

    Returns
    ----------
    files: list[Path]
        渡した場所と, 同じ名前の .csv, .parquet, .json
    """
    files = [path, *(path.with_suffix(s) for s in TRAJECTORY_SUFFIXES)]

    return files


def read_summary(path: Path) -> dict[str, Any]:
    """
    記録した軌跡を読み, 要約を返す関数

    Parameters
    ----------
    path: Path
        表か説明

    Returns
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_trajectory の結果

    Raises
    ----------
    HTTPException
        無い場合は 404, 読めない場合は 422
    """
    try:
        trajectory = ml_eda.load_trajectory(path)
    except FileNotFoundError as error:
        raise HTTPException(404, f"{error}") from error
    except (OSError, ValueError, ImportError) as error:
        raise HTTPException(
            422, f"軌跡を読み込めませんでした: {error}"
        ) from error
    summary: dict[str, Any] = to_json(ml_eda.describe_trajectory(trajectory))

    return summary
