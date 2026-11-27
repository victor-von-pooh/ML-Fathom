from typing import Annotated, Any, Literal, Optional

import ml_eda
import ml_quest
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ml_fathom.api import (
    EXPORT_LOCK,
    find_source,
    get_store,
    load_source,
)
from ml_fathom.jsonable import to_json

# 頭なしの router (頭は mount する側が決める)
router = APIRouter()

# 画面から作れる群の数の上限 (k-means を置き方を変えて繰り返し, 作り直して
# 安定性も数えるので, 大きな数で手元の計算機を長く使わないように. 画面の
# frontend/src/lib/groups.ts の MAX_GROUPS と同じ値にする. 変えるときは両方)
MAX_GROUPS = 50

# 群を作る列の数の上限 (画面で選べる数. 符号化した行の幅の上限は ML-EDA
# が持つ)
MAX_COLUMNS = 200

# ML-Quest の GROUP_TAKEN のうち, 1 件の行の決まった列 (断る文で群の要約の
# 列と分けて見せるためだけに使う. 確かめは GROUP_TAKEN で行う)
ROW_KEYS = ("id", "split")

# 誤りとして理由を返す ML-EDA の例外 (列の誤り, 群の数の誤りなど)
INPUT_ERRORS = (ValueError, TypeError, KeyError)


class GroupRequest(BaseModel):
    # 知らない欄は断る (取り違えた欄を黙って捨てないため)
    model_config = ConfigDict(extra="forbid")
    columns: list[str] = Field(
        min_length=1, max_length=MAX_COLUMNS, description="群を作る列"
    )
    k: int = Field(ge=2, le=MAX_GROUPS, description="群の数")
    seed: Annotated[
        int, Field(ge=0, description="k-means の乱数の種")
    ] = 0
    # 問題の設定の答え group.stability の数え方 (画面が答えから送る. 引く
    # 割合は答えが無いので ML-EDA の既定で, 骨組みの config の既定と同じ)
    stability: Literal["seed", "sample"] = Field(
        "seed", description="群の安定性の数え方"
    )


class GroupSplit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method: Literal["random", "none"] = "random"
    valid: Annotated[float, Field(ge=0, lt=1)] = 0.2
    test: Annotated[float, Field(ge=0, lt=1)] = 0.0
    seed: Annotated[int, Field(ge=0)] = 0


class GroupExport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    columns: list[str] = Field(
        min_length=1, max_length=MAX_COLUMNS, description="群を作る列"
    )
    id: Optional[str] = Field(None, description="行を見分ける列")
    split: GroupSplit = GroupSplit()
    name: str
    overwrite: bool = False


def is_group(problem: dict[str, Any]) -> bool:
    """
    受け持ちがまとめるで学習する (作り方が既製のモデルをそのままでない) か
    を返す関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2)

    Returns
    ----------
    group: bool
        まとめるの骨組みを書き出す受け持ちか (ML-Quest の骨組みと同じ決まり)
    """
    # 受け持ちと作り方の答え (要らない問いの古い答えは除外)
    part = ml_quest.PART
    group = bool(
        ml_quest.active_value(problem, f"{part}.role") == "group"
        and ml_quest.active_value(problem, f"{part}.method") != "pretrained"
    )

    return group


def group_answers(problem: dict[str, Any]) -> dict[str, Any]:
    """
    問題の設定から, 群を作る列, 行を見分ける列, 群の数, 安定性の数え方の
    答えを返す関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (まとめるで学習する受け持ち)

    Returns
    ----------
    answers: dict[str, Any]
        columns (列の名前の並び. 答えていなければ空), id (列の名前か
        None), k (群の数の整数か None), stability (seed か sample か
        None)
    """
    # ml.parts.<n>.group の答え (文字でない列の名前は答えていないもの)
    base = f"{ml_quest.PART}.group"
    columns = ml_quest.active_value(problem, f"{base}.columns")
    key = ml_quest.active_value(problem, f"{base}.id")
    stability = ml_quest.active_value(problem, f"{base}.stability")
    # 群の数は整数の値だけ (真偽値, 端数のある数, 文字は答えていないもの)
    k = ml_quest.active_value(problem, f"{base}.k")
    if isinstance(k, bool) or not isinstance(k, (int, float)) or not (
        float(k).is_integer()
    ):
        k = None
    answers: dict[str, Any] = {
        "columns": [str(name) for name in columns]
        if isinstance(columns, list) else [],
        "id": key if isinstance(key, str) and key else None,
        "k": None if k is None else int(k),
        "stability": stability if stability in ("seed", "sample") else None,
    }

    return answers


def check_group_columns(
    data: ml_eda.Data, answers: dict[str, Any]
) -> None:
    """
    問題の設定の答えの列を, 骨組みが読めるかを確かめる関数

    骨組みの学習のスクリプトが止める誤り (答えの無い群を作る列, 表に無い
    列, 骨組みが使えない名前の列) を先に出す. 使えない名前は ML-Quest の
    公開の名前 (GROUP_TAKEN と GROUP_ASSIGNED) で確かめる

    Parameters
    ----------
    data: ml_eda.Data
        読み込んだ表
    answers: dict[str, Any]
        group_answers の結果

    Returns
    ----------
    None

    Raises
    ----------
    HTTPException
        誤りは 422
    """
    # 群を作る列と行を見分ける列
    names = list(answers["columns"])
    if not names:
        raise HTTPException(
            422, "問題の設定に群を作る列の答えがありません (ML-Pathfinder の"
            "「群を作るのに使う列は」で答えてください)"
        )
    wanted = names + ([answers["id"]] if answers["id"] else [])
    present = {str(name) for name in data.frame.columns}
    missing = [name for name in wanted if name not in present]
    if missing:
        raise HTTPException(
            422, f"表に {', '.join(missing)} の列がありません. ML-Pathfinder "
            "で群を作る列か行を見分ける列を答え直してください"
        )
    # 骨組みが使えない名前 (群の要約と 1 件の鍵, 群の割り当ての表の列)
    taken = [name for name in names if name in ml_quest.GROUP_TAKEN]
    if taken:
        summary = [name for name in ml_quest.GROUP_TAKEN
                   if name not in ROW_KEYS]
        row = [name for name in ml_quest.GROUP_TAKEN if name in ROW_KEYS]
        raise HTTPException(
            422, f"群を作る列 {', '.join(taken)} は, 群の要約の列 ("
            f"{', '.join(summary)}) か 1 件の行の決まった列 ("
            f"{', '.join(row)}) と同じ名前なので群を作るのに使えません. "
            "名前を変えた列を持つ表を入れ直すか, ML-Pathfinder で群を作る"
            "列に別の列を答え直してください"
        )
    if answers["id"] in ml_quest.GROUP_ASSIGNED:
        raise HTTPException(
            422, f"行を見分ける列 {answers['id']} は, 群の割り当ての表の列 ("
            f"{', '.join(ml_quest.GROUP_ASSIGNED)}) と同じ名前なので行を"
            "見分けるのに使えません. 名前を変えた列を持つ表を入れ直すか, "
            "ML-Pathfinder で行を見分ける列に別の列を答え直してください"
        )


@router.post("/sources/{source_id}/groups")
def describe(
    request: Request, source_id: str, body: GroupRequest
) -> dict[str, Any]:
    """
    学習に通さず, 選んだ列を k-means で分けた群の要約を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: GroupRequest
        群を作る列, 群の数, 乱数の種, 安定性の数え方

    Returns
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_groups の結果

    Raises
    ----------
    HTTPException
        データが無ければ 404, 表でないか, 列と群の数の誤りは 422
    """
    # 読み込み済みの表を渡し, 読み直さない
    data = load_source(find_source(request, source_id))
    try:
        summary: dict[str, Any] = to_json(ml_eda.describe_groups(
            data, columns=body.columns, k=body.k, seed=body.seed,
            stability=body.stability
        ))
    except INPUT_ERRORS as error:
        raise HTTPException(
            422, f"群を作れません: {error}"
        ) from error

    return summary


@router.post("/sources/{source_id}/export_groups")
def export_groups(
    request: Request, source_id: str, body: GroupExport
) -> dict[str, Any]:
    """
    群を作る列 (と行を見分ける列) を, 群分けの表として版 2 のデータセットに
    書き出す関数 (分析の保存. 学習のプロジェクトへは表のファイルを写す)

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: GroupExport
        群を作る列, 行を見分ける列, 分割, 名前, 置き換えるか

    Returns
    ----------
    result: dict[str, Any]
        書き出した場所, dataset.yaml の中身, 注意

    Raises
    ----------
    HTTPException
        データが無ければ 404, 名前と列と分割の誤りは 422, 既にある場合は
        409
    """
    # 置き場の datasets の下に書き出す
    store = get_store(request)
    data = load_source(find_source(request, source_id))
    split = body.split.model_dump()
    try:
        target = store.dataset_dir(body.name)
        with EXPORT_LOCK:
            info = ml_eda.export_group_rows(
                data, target, body.columns, id=body.id or None, split=split,
                name=body.name, overwrite=body.overwrite
            )
    except FileExistsError as error:
        detail = str(error) if body.overwrite else f"{body.name} は既にあります"
        raise HTTPException(409, detail) from error
    except INPUT_ERRORS as error:
        raise HTTPException(422, str(error)) from error
    result = {
        "path": str(target), "info": to_json(info),
        "notes": [str(note) for note in info.get("notes") or []],
    }

    return result
