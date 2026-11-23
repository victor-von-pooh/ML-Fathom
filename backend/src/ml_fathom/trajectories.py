import csv
from pathlib import Path
from typing import Any, Optional

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

# CSV の見出しを確かめる大きさ (大きな表を候補を出すために全て読まない)
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


def trajectory_candidate(path: Path) -> Optional[dict[str, Any]]:
    """
    記録した軌跡として読めれば, 読み込みの候補を返す関数

    Parameters
    ----------
    path: Path
        ファイル (表か説明)

    Returns
    ----------
    candidate: Optional[dict[str, Any]]
        loader, kind, score. 軌跡として読めなければ None
    """
    # 読めるかは ML-EDA の load_trajectory で決める
    suffix = path.suffix.lower()
    if not path.is_file() or suffix not in TRAJECTORY_SUFFIXES:
        return None
    if suffix == ".csv" and not csv_header_fits(path):
        return None
    try:
        ml_eda.load_trajectory(path)
    except (OSError, ValueError, ImportError):
        return None
    candidate = {
        "loader": TRAJECTORY_LOADER, "kind": TRAJECTORY_KIND,
        "score": TRAJECTORY_SCORE,
    }

    return candidate


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
