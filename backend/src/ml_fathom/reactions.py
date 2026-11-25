import os
import secrets
import shutil
import stat
from pathlib import Path
from typing import Any, Optional

import ml_eda
import ml_quest
from fastapi import HTTPException

from ml_fathom.jsonable import to_json
from ml_fathom.places import Parent

# 並べるの問題の設定から始めた反応の表の種類 (表として読み, 画面は反応の表
# の分析を出す)
REACTIONS_KIND = "reactions"

# 反応の表の列の役割 (ML-Quest の ml.parts.<n>.rank の問い)
ROLES = ("user", "item", "time", "reaction")


def is_rank(problem: dict[str, Any]) -> bool:
    """
    受け持ちが並べるで学習する (作り方が既製のモデルをそのままでない) かを
    返す関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2)

    Returns
    ----------
    rank: bool
        並べるの骨組みを書き出す受け持ちか (ML-Quest の骨組みと同じ決まり)
    """
    # 受け持ちと作り方の答え (要らない問いの古い答えは除外)
    part = ml_quest.PART
    rank = bool(
        ml_quest.active_value(problem, f"{part}.role") == "rank"
        and ml_quest.active_value(problem, f"{part}.method") != "pretrained"
    )

    return rank


def rank_answers(problem: dict[str, Any]) -> dict[str, Any]:
    """
    問題の設定から, 反応の表の列と並べる件数の答えを返す関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (並べるで学習する受け持ち)

    Returns
    ----------
    answers: dict[str, Any]
        user, item, time, reaction (列の名前. 答えていなければ None) と k
        (並べる件数)
    """
    # ml.parts.<n>.rank の答え (文字でない列の名前は答えていないもの)
    base = f"{ml_quest.PART}.rank"
    answers: dict[str, Any] = {}
    for role in ROLES:
        value = ml_quest.active_value(problem, f"{base}.{role}")
        answers[role] = value if isinstance(value, str) and value else None
    answers["k"] = ml_quest.active_value(problem, f"{base}.k")

    return answers


def data_place(problem: dict[str, Any]) -> Optional[dict[str, Any]]:
    """
    問題の設定から, 入れた表 (反応の表, 群分けの表) の場所と読み方を返す
    関数

    写しが消えていれば元の場所 (data.origin) を使う (ML-Quest が骨組みに
    写すデータと同じ選び方)

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定

    Returns
    ----------
    place: Optional[dict[str, Any]]
        path, loader (None なら候補の先頭), options (データを入れて
        いなければ None)
    """
    # 写しか, 在る元の場所
    location = ml_quest.active_value(problem, "data.source")
    origin = ml_quest.get_value(problem, "data.origin")
    if not isinstance(location, str) or not location:
        return None
    if isinstance(origin, str) and origin and not Path(location).exists() and (
        Path(origin).exists()
    ):
        location = origin
    loader = ml_quest.get_value(problem, "data.loader")
    options = ml_quest.get_value(problem, "data.options")
    place = {
        "path": location,
        "loader": loader if isinstance(loader, str) and loader else None,
        "options": dict(options) if isinstance(options, dict) else {},
    }

    return place


def read_reactions(
    data: ml_eda.Data, answers: dict[str, Any]
) -> ml_eda.Reactions:
    """
    読み込んだ表を, 問題の設定の列で反応の表として読む関数

    Parameters
    ----------
    data: ml_eda.Data
        読み込んだ表 (読み直さない)
    answers: dict[str, Any]
        rank_answers の結果

    Returns
    ----------
    reactions: ml_eda.Reactions
        ML-EDA の load_reactions の結果

    Raises
    ----------
    HTTPException
        列の答えの誤り, 列が無い, 時刻を読めない場合は 422
    """
    # 骨組みの学習のスクリプトと同じ決まりで, 除く行を数える
    try:
        reactions = ml_eda.load_reactions(
            data, answers["user"], answers["item"], answers["time"],
            answers["reaction"]
        )
    except (ValueError, TypeError, KeyError) as error:
        raise HTTPException(
            422, f"反応の表として読めません: {error}"
        ) from error

    return reactions


def describe(reactions: ml_eda.Reactions) -> dict[str, Any]:
    """
    反応の表の要約を, JSON にできる形で返す関数

    Parameters
    ----------
    reactions: ml_eda.Reactions
        読んだ反応の表

    Returns
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_reactions の結果
    """
    summary: dict[str, Any] = to_json(ml_eda.describe_reactions(reactions))

    return summary


def file_state(path: Path) -> str:
    """
    ファイル 1 つの書き出し先 (反応の表, 群分けの表) の今の様子を返す関数

    Parameters
    ----------
    path: Path
        書き出し先 (ファイル 1 つ)

    Returns
    ----------
    state: str
        missing (無い), file (前に置いたファイル), occupied (ディレクトリ
        かシンボリックリンクなど, ファイルでないもの)
    """
    # 置き換えてよいのは普通のファイルだけ (リンクの先は書き換えない)
    if path.is_symlink():
        state = "occupied"
    elif not path.exists():
        state = "missing"
    elif path.is_file():
        state = "file"
    else:
        state = "occupied"

    return state


def copy_file(source: Path, parent: Parent) -> bool:
    """
    反応の表か群分けの表のファイルを, そのまま書き出し先に写す関数

    途中で止まっても前のファイルが壊れないように, 同じディレクトリの一時
    ファイルに写してから置き換える. 書き込みは一段ずつ確かめた親の記述子に
    対して行う (途中の場所がリンクに替わっても, プロジェクトの外に書かない
    ため)

    Parameters
    ----------
    source: Path
        登録した表
    parent: Parent
        書き出し先 (骨組みの config の data.dataset) の親 (pinned_parent)

    Returns
    ----------
    copied: bool
        写したか (書き出し先が登録した表そのものなら写さず False)

    Raises
    ----------
    OSError
        読めないか書けない場合
    """
    # 同じファイルは写さない (書き出し先のリンクはたどらずに比べる)
    name = parent.place.name
    origin = os.stat(source)
    try:
        current = os.stat(name, dir_fd=parent.fd, follow_symlinks=False)
    except FileNotFoundError:
        current = None
    if current is not None and (current.st_dev, current.st_ino) == (
        origin.st_dev, origin.st_ino
    ):
        return False

    # 一時ファイルは元の権限にそろえ, 写し終えてから置き換える
    temporary = f".{name}.{secrets.token_hex(8)}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    handle = os.open(temporary, flags, 0o600, dir_fd=parent.fd)
    try:
        with open(handle, "wb") as written, open(source, "rb") as read:
            shutil.copyfileobj(read, written)
            os.fchmod(written.fileno(), stat.S_IMODE(origin.st_mode))
        os.replace(
            temporary, name, src_dir_fd=parent.fd, dst_dir_fd=parent.fd
        )
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=parent.fd)
        except FileNotFoundError:
            pass
        raise
    copied = True

    return copied
