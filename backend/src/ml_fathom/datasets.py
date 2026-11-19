from pathlib import Path
from typing import Any, Optional

import ml_eda
import yaml
from ml_eda.pipeline import DATASET_FORMAT_VERSION, ITEMS_FORMAT_VERSION
from ml_eda.profile import to_json

# 一覧に出す項目の欄
ENTRY_FIELDS = ("kind", "role", "units", "convention", "shape", "formats")


def table_summary(path: Path) -> dict[str, Any]:
    """
    版 1 (1 件 = 1 行の表) のデータセットを一覧の 1 件にする関数

    Parameters
    ----------
    path: Path
        データセットのディレクトリ

    Returns
    ----------
    summary: dict[str, Any]
        種類, タスク, 目的の列, 分割ごとの行数, 学習に使う列の数
    """
    # load_dataset で読めることを確かめる
    info = ml_eda.load_dataset(path).info
    summary = {
        "form": "table",
        "kind": info.get("kind"), "task": info.get("task"),
        "target": info.get("target"),
        "splits": {
            name: split.get("rows") for name, split in info["splits"].items()
        },
        "features": len(info.get("features", [])),
    }

    return summary


def items_summary(path: Path) -> dict[str, Any]:
    """
    版 2 (入力と正解がファイルの組) のデータセットを一覧の 1 件にする関数

    Parameters
    ----------
    path: Path
        データセットのディレクトリ

    Returns
    ----------
    summary: dict[str, Any]
        受け持ち, 正解 (種類, 項目, 出どころ), 項目ごとの種類と単位と
        座標の決まり, 分割ごとの件数, 全ての件数, 正規化, 注意
    """
    # load_items で読めることを確かめる (表と項目の列も)
    dataset = ml_eda.load_items(path)
    info = dataset.info
    target = info.get("target") or {}
    entries = [
        {"name": name, **{field: spec.get(field) for field in ENTRY_FIELDS}}
        for name, spec in dataset.entries.items()
    ]
    splits = {
        name: split.get("items")
        for name, split in (info.get("splits") or {}).items()
    }
    normalization = info.get("normalization")
    summary = {
        "form": "items",
        "role": info.get("role"),
        "target": {
            "kind": target.get("kind"),
            "entries": list(target.get("entries") or []),
            "origin": target.get("origin") or {"type": "unknown"},
        },
        "entries": entries,
        "splits": splits,
        "items": len(dataset.items),
        "normalization": (
            normalization.get("method")
            if isinstance(normalization, dict) else None
        ),
        "notes": [str(note) for note in info.get("notes") or []],
    }

    return summary


def dataset_summary(path: Path) -> Optional[dict[str, Any]]:
    """
    書き出したデータセットを, 版で読み分けて一覧の 1 件にする関数

    ML-EDA の load_dataset は版 2 で, load_items は版 1 で止まるので,
    format_version を見てから読む方を選ぶ. 読めないものも理由を付けて返す

    Parameters
    ----------
    path: Path
        datasets の下のディレクトリ

    Returns
    ----------
    summary: Optional[dict[str, Any]]
        名前, 場所, 版, 作った時刻と, form (table, items, unreadable) ごと
        の中身. dataset.yaml の無いディレクトリは None
    """
    # dataset.yaml の無いもの (書き出し途中の一時ディレクトリなど) は除く
    summary: Optional[dict[str, Any]] = None
    file = path / "dataset.yaml"
    if path.name.startswith(".") or not file.is_file():
        return summary

    # 版を読んでから読み分ける
    summary = {
        "name": path.name, "path": str(path), "format_version": None,
        "created_at": None,
    }
    try:
        info = yaml.safe_load(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as error:
        summary.update(
            form="unreadable", unknown_version=False,
            error=f"dataset.yaml を読めません: {error}"
        )
        return summary
    info = info if isinstance(info, dict) else {}
    version = info.get("format_version")
    summary.update(
        format_version=version,
        created_at=(
            None if info.get("created_at") is None
            else str(info.get("created_at"))
        )
    )
    known = (DATASET_FORMAT_VERSION, ITEMS_FORMAT_VERSION)
    if isinstance(version, bool) or version not in known:
        summary.update(
            form="unreadable", unknown_version=True,
            error=(
                f"format_version {version} は, この ML-Fathom の ML-EDA が"
                f"読める版 ({', '.join(str(v) for v in known)}) ではありません"
            )
        )
        return summary
    try:
        if version == ITEMS_FORMAT_VERSION:
            summary.update(items_summary(path))
        else:
            summary.update(table_summary(path))
    except (OSError, ValueError, KeyError, TypeError,
            AttributeError) as error:
        summary.update(
            form="unreadable", unknown_version=False, error=str(error)
        )
    summary = to_json(summary)

    return summary
