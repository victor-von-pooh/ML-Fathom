import datetime as dt
from pathlib import Path
from typing import Any, Optional

import ml_eda
import yaml
from ml_eda import DATASET_FORMAT_VERSION, ITEMS_FORMAT_VERSIONS

from ml_fathom.jsonable import to_json

# 一覧に出す項目の欄 (steps は版 3 でかけた中身の手順. 版 2 は無し)
ENTRY_FIELDS = (
    "kind", "role", "units", "convention", "shape", "formats", "steps"
)


def points_outside(base: Path, path: Path) -> bool:
    """
    リンクをたどった後の場所が, ディレクトリの外かを返す関数

    ML-EDA の読み込みと同じ決まりで, ディレクトリ自体もたどった後の場所と
    比べる (ディレクトリ自体のリンクは信頼する)

    Parameters
    ----------
    base: Path
        データセットのディレクトリ
    path: Path
        確かめる場所

    Returns
    ----------
    outside: bool
        たどった後の path が, たどった後の base の下に無いか (リンクが
        輪になってたどれない場合も True)
    """
    # 両方のリンクをたどってから比べる
    try:
        outside = not path.resolve().is_relative_to(base.resolve())
    except (OSError, RuntimeError):
        outside = True

    return outside


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
        種類, タスク, 目的の列, 分割ごとの行数, 学習に使う列の数, モデルに
        要るもの (model_inputs の結果), 異常の検知の説明 (anomaly), 効果を
        見積もるの説明 (uplift)
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
        "model": ml_eda.model_inputs(path),
        # 異常の検知 (task: anomaly) の行の id の列, 正解の有る無しと分割
        # ごとの行の数 (他のタスクは None)
        "anomaly": info.get("anomaly"),
        # 効果を見積もる (task: uplift) の処置の列, 結果の種類と分割ごとの
        # 群の行の数と結果の平均 (他のタスクは None)
        "uplift": info.get("uplift"),
    }

    return summary


def items_summary(path: Path) -> dict[str, Any]:
    """
    版 2 と版 3 (入力と正解がファイルの組) のデータセットを一覧の 1 件に
    する関数

    Parameters
    ----------
    path: Path
        データセットのディレクトリ

    Returns
    ----------
    summary: dict[str, Any]
        受け持ち, 正解 (種類, 項目, 出どころ), 項目ごとの種類と単位と
        座標の決まりと中身の手順, 分割ごとの件数, 全ての件数, 正規化, 注意
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

    ML-EDA の load_dataset はファイルの組の版で, load_items は版 1 で止まる
    ので, format_version を見てから読む方を選ぶ. 読めないものも理由を付けて
    返す

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

    # 版を読んでから読み分ける (外を指すリンクの dataset.yaml は, ML-EDA
    # の load_items と同じく読まない)
    summary = {
        "name": path.name, "path": str(path), "format_version": None,
        "created_at": None,
    }
    if points_outside(path, file):
        summary.update(
            form="unreadable", unknown_version=False,
            error=(
                "dataset.yaml はデータセットのディレクトリの外を指すリンク"
                "なので読みません"
            )
        )
        return summary
    try:
        info = yaml.safe_load(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as error:
        summary.update(
            form="unreadable", unknown_version=False,
            error=f"dataset.yaml を読めません: {error}"
        )
        return summary
    if not isinstance(info, dict):
        summary.update(
            form="unreadable", unknown_version=False,
            error="dataset.yaml が辞書ではありません"
        )
        return summary
    version = info.get("format_version")
    created = info.get("created_at")
    if isinstance(created, (dt.date, dt.datetime)):
        created = created.isoformat()
    summary.update(
        format_version=version,
        created_at=None if created is None else str(created)
    )

    # 版は整数だけ (1.0 や true は ML-EDA も読まない)
    known = (DATASET_FORMAT_VERSION, *ITEMS_FORMAT_VERSIONS)
    if type(version) is not int or version not in known:
        summary.update(
            form="unreadable", unknown_version=True,
            error=(
                f"format_version {version} は, この ML-Fathom の ML-EDA が"
                f"読める版 ({', '.join(str(v) for v in known)}) ではありません"
            )
        )
        return summary
    try:
        if version in ITEMS_FORMAT_VERSIONS:
            summary.update(items_summary(path))
        else:
            summary.update(table_summary(path))
    except Exception as error:  # noqa: BLE001 (1 件の誤りで一覧を止めない)
        summary.update(
            form="unreadable", unknown_version=False,
            error=str(error) or type(error).__name__
        )
    summary = to_json(summary)

    return summary
