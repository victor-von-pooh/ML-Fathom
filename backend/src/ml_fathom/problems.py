import datetime as dt
import hashlib
from pathlib import Path
from typing import Any, Literal, Optional

import ml_eda
import ml_quest
import yaml
from fastapi import APIRouter, HTTPException, Request
from ml_quest import is_column_part, is_items_part
from pydantic import BaseModel, ConfigDict, Field

from ml_fathom.api import (
    EXPORT_LOCK,
    check_recipe_limits,
    check_step_limits,
    export_message,
    find_source,
    get_store,
    load_source,
    model_hints,
    pair_result,
    source_view,
)
from ml_fathom.groups import (
    MAX_COLUMNS,
    MAX_GROUPS,
    check_group_columns,
    group_answers,
    is_group,
)
from ml_fathom.jsonable import to_json
from ml_fathom.reactions import (
    REACTIONS_KIND,
    copy_file,
    data_place,
    describe,
    file_state,
    is_rank,
    rank_answers,
    read_reactions,
)
from ml_fathom.settings import get_problems_dir

router = APIRouter(prefix="/api")

# 問題の設定のファイルを読めないときの例外
READ_ERRORS = (OSError, ValueError, yaml.YAMLError)

# 確かめた後に問題の設定が他で変わったときの断りの文
CHANGED = (
    "問題の設定が他で変わりました. 確かめ直したので, 見直してからもう一度"
    "書き戻してください"
)

# 問題の設定の形が崩れているときに ML-Quest から出る例外
SHAPE_ERRORS = (ValueError, TypeError, AttributeError, KeyError)

# 問題の設定のファイルの拡張子
SUFFIXES = (".yaml", ".yml")

# 作るの受け持ちのうち登録したデータとレシピで書き出す正解の種類から, 合う
# データの種類 (ML-EDA の Data.kind. 日時の列を見つけた表は timeseries に
# なるが, 中身は表なので表を作る課題に使える)
GENERATE_KINDS = {"image": ("image",), "table": ("table", "timeseries")}

# 作るものの正解の種類の, 理由の文の名前
KIND_NAMES = {"image": "画像", "table": "表"}

# まとめるの問題の設定から始められる表の種類 (群分けのタブが読むもの. 日時
# の列を見つけた表は timeseries になる)
GROUP_KINDS = ("table", "timeseries")

# ML-Quest の書き出しの関数の名前から, ファイルの組の書き出しの画面の欄
PAIR_FORMS = {
    "export_image_masks": "image_masks",
    "export_capture_clouds": "capture_clouds",
}


class ProblemStart(BaseModel):
    path: str = Field(description="problem.yaml か, それを持つディレクトリ")


class ProblemCheck(BaseModel):
    recipe: dict[str, Any]


class ProjectExport(BaseModel):
    recipe: dict[str, Any]
    overwrite: bool = Field(
        False, description="前に書き出したデータセットを置き換えるか"
    )


class ReactionsExport(BaseModel):
    overwrite: bool = Field(
        False, description="前に置いた反応の表を置き換えるか"
    )


class GroupProjectExport(BaseModel):
    overwrite: bool = Field(
        False, description="前に置いた表を置き換えるか"
    )


class GroupChoice(BaseModel):
    # 知らない欄は断り, 書いた欄だけを書き戻す (安定性の数え方はタブで選ば
    # ないので送らない)
    model_config = ConfigDict(extra="forbid")
    columns: Optional[list[str]] = Field(
        None, max_length=MAX_COLUMNS, description="群を作る列"
    )
    id: Optional[str] = Field(
        None, description="行を見分ける列 (None は外す)"
    )
    k: Optional[int] = Field(
        None, ge=2, le=MAX_GROUPS, description="群の数"
    )
    stability: Optional[Literal["seed", "sample"]] = Field(
        None, description="群の安定性の数え方"
    )


class GroupCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group: GroupChoice


class GroupWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group: GroupChoice
    version: str = Field(
        description="確かめたときの問題の設定のファイルの中身の印"
    )


class PairsExport(BaseModel):
    # 知らない欄は断る (古い画面の item_steps を黙って捨てないため)
    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="problem.yaml か, それを持つディレクトリ")
    version: str = Field(
        description="確かめたときの問題の設定のファイルの中身の印"
    )
    export: dict[str, Any] = Field(
        description="ML-Quest の書き出しの設定 (function, inputs, targets, "
        "split, groups, origin, options. 中身の手順は options.item_steps)"
    )
    overwrite: bool = Field(
        False, description="前に書き出したデータセットを置き換えるか"
    )


class ProblemWrite(BaseModel):
    recipe: dict[str, Any]
    choices: dict[str, Literal["known", "drop"]] = Field(default_factory=dict)
    version: str = Field(
        description="確かめたときの問題の設定のファイルの中身の印"
    )


def problem_file(text: str) -> Path:
    """
    画面から受け取った問題の設定の場所を, problem.yaml の絶対パスにする
    関数

    Parameters
    ----------
    text: str
        problem.yaml か, それを持つディレクトリ (~ から書ける)

    Returns
    ----------
    path: Path
        problem.yaml の絶対パス

    Raises
    ----------
    HTTPException
        無い場合は 404, YAML のファイルでない場合は 422
    """
    # ディレクトリなら中の problem.yaml (読めない場所の形は 422)
    try:
        path = Path(text.strip()).expanduser().resolve()
        if path.is_dir():
            path = path / "problem.yaml"
        found = path.is_file()
    except (OSError, ValueError, RuntimeError) as error:
        raise HTTPException(
            422, f"問題の設定の場所として読めません: {error}"
        ) from error
    if not found:
        raise HTTPException(404, f"{path} に問題の設定がありません")
    if path.suffix.lower() not in SUFFIXES:
        raise HTTPException(
            422, f"{path.name} は YAML のファイル (.yaml) ではありません"
        )

    return path


def read_problem(path: Path) -> dict[str, Any]:
    """
    問題の設定を読み, 問題の設定のファイルであることを確かめる関数

    Parameters
    ----------
    path: Path
        problem.yaml

    Returns
    ----------
    problem: dict[str, Any]
        問題の設定

    Raises
    ----------
    HTTPException
        読めない場合と, 問題の設定のファイルでない場合 (レシピなど) は 422
    """
    # 中身の印は使わない
    problem, _ = read_problem_bytes(path)

    return problem


def read_problem_bytes(path: Path) -> tuple[dict[str, Any], str]:
    """
    問題の設定を一度だけ読み, 同じ中身から問題の設定と中身の印を作る関数

    読んだ後に外で保存されても, 印と中身が別の版から来ないように

    Parameters
    ----------
    path: Path
        problem.yaml

    Returns
    ----------
    read: tuple[dict[str, Any], str]
        問題の設定 (版 2) と, 同じ中身の sha256 の 16 進

    Raises
    ----------
    HTTPException
        読めない場合と, 問題の設定のファイルでない場合 (レシピなど) は 422
    """
    # 版の番号の他に, 名前と作った時刻 (ML-Quest が必ず書く) を持つこと.
    # 版 1 は ML-Quest の load_problem と同じく版 2 に移す
    try:
        data = path.read_bytes()
        loaded = yaml.safe_load(data.decode("utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError(
                f"{path.name} は問題の設定のファイルではありません "
                "(format_version がありません)"
            )
        problem: dict[str, Any] = ml_quest.upgrade_problem(
            loaded, path.name
        )
    except READ_ERRORS as error:
        raise HTTPException(
            422, f"問題の設定を読めません: {error}"
        ) from error
    if not isinstance(problem.get("name"), str) or not problem.get(
        "created_at"
    ):
        raise HTTPException(
            422, f"{path.name} は問題の設定のファイルではありません"
        )
    read = (problem, hashlib.sha256(data).hexdigest())

    return read


def is_generate(problem: dict[str, Any]) -> bool:
    """
    受け持ちが画像か表の生成 (作るで, 正解の種類が画像か表) かを返す関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2)

    Returns
    ----------
    generate: bool
        画像か表の生成の受け持ちか
    """
    # 受け持ちと正解の種類の答え (要らない問いの古い答えは除外)
    part = ml_quest.PART
    role = ml_quest.active_value(problem, f"{part}.role")
    kind = ml_quest.active_value(problem, f"{part}.target.kind")
    generate = role == "generate" and kind in GENERATE_KINDS

    return generate


def choice_text(choices: list[dict[str, Any]], value: Any) -> str:
    """
    ML-Quest の選択肢の値を, 画面の言葉と値の組の文にする関数

    Parameters
    ----------
    choices: list[dict[str, Any]]
        選択肢 (value と label)
    value: Any
        答えの値 (答えていなければ None)

    Returns
    ----------
    text: str
        「言葉」(値) の文 (答えていなければ未定, 選択肢に無ければ値のまま)
    """
    # 言葉は説明の括弧の前まで
    if value is None:
        text = "未定"
        return text
    labels = [str(item["label"]).split(" (")[0] for item in choices
              if item["value"] == value]
    text = f"「{labels[0]}」({value})" if labels else str(value)

    return text


def require_recipe(problem: dict[str, Any]) -> None:
    """
    受け持ちが, 登録したデータとレシピで書き出すもの (列の予測と, 画像か
    表の生成) でなければ止める関数

    ML-Quest の版 2 の問題の設定は, 受け持ち (作る, 並べるなど) と正解の
    種類 (領域, 点群など) を持つ. 登録したデータのレシピの下書きと書き戻し
    は列の予測と画像か表の生成だけ (ファイルの組の受け持ちは require_items)

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2. load_problem が版 1 を移したもの)

    Returns
    ----------
    None

    Raises
    ----------
    HTTPException
        他の受け持ちは 422 (使えない受け持ちと正解の種類, 理由, 使える
        受け持ちの文)
    """
    # 使えない受け持ちと正解の種類を, 画面の選択肢と同じ言葉で
    if is_column_part(problem) or is_generate(problem):
        return
    part = ml_quest.PART
    role = ml_quest.active_value(problem, f"{part}.role")
    kind = ml_quest.active_value(problem, f"{part}.target.kind")
    if is_rank(problem):
        raise HTTPException(
            422, "並べるの問題の設定はレシピを持ちません (反応の表をファイル "
            "1 つのまま骨組みに渡し, 分割は骨組みが時刻で行うため). 反応の表"
            "の分析の画面から, そのままプロジェクトへ書き出してください"
        )
    if is_group(problem):
        raise HTTPException(
            422, "まとめるの問題の設定はレシピを持ちません (表をファイル 1 つ"
            "のまま骨組みに渡し, 分割は骨組みが行うため). 群分けのタブから, "
            "そのままプロジェクトへ書き出してください"
        )
    if role == "effect" and ml_quest.active_value(
        problem, f"{part}.autonomous"
    ) is True:
        why = ("方策は行動の結果を環境とのやり取りで集めるので, データの"
               "分析の段階を通りません")
    elif role in ("predict", "rank", "group") and ml_quest.active_value(
        problem, f"{part}.method"
    ) == "pretrained":
        name = {"predict": "予測", "rank": "並べる", "group": "まとめる"}[role]
        why = (f"既製のモデルをそのまま使う{name}は学習しないので, データの"
               "分析の段階を通りません")
    else:
        why = "この受け持ちと正解の種類はまだ扱えません"
    raise HTTPException(
        422,
        f"この問題の設定の受け持ち {choice_text(ml_quest.ROLES, role)} "
        f"(正解の種類 {choice_text(ml_quest.TARGET_KINDS, kind)}) は, "
        f"問題の設定から始めることと書き戻しに使えません ({why}). 使える"
        "のは, 予測するで正解の種類が表の列, 画像の領域, 点群の場合と, "
        "作るで正解の種類が画像か表の場合と, 並べるかまとめるで学習する"
        "場合です. "
        "データは「データを追加」から入れて分析できます"
    )


def require_items(problem: dict[str, Any]) -> None:
    """
    受け持ちがファイルの組 (予測するで, 正解が画像の領域か点群) でなければ
    止める関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2)

    Returns
    ----------
    None

    Raises
    ----------
    HTTPException
        列の予測と画像か表の生成なら 422 (データの画面から始める), 他は
        require_recipe と同じ 422
    """
    # 列の予測と画像か表の生成は登録したデータで始める
    if is_items_part(problem):
        return
    if is_column_part(problem) or is_generate(problem) or is_rank(problem) or (
        is_group(problem)
    ):
        raise HTTPException(
            422, "この問題の設定は列の予測か, 画像か表の生成か, 並べるか, "
            "まとめるです. "
            "データの画面の「問題の設定から始める」で始めてください"
        )
    require_recipe(problem)


def linked_problem(
    request: Request, source_id: str
) -> tuple[dict[str, Any], Path, dict[str, Any]]:
    """
    登録したデータと, 始めた問題の設定の場所と中身を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    linked: tuple[dict[str, Any], Path, dict[str, Any]]
        登録したデータ, problem.yaml の場所, 問題の設定

    Raises
    ----------
    HTTPException
        linked_versioned と同じ
    """
    # 中身の印は使わない
    source, path, problem, _ = linked_versioned(request, source_id)
    linked = (source, path, problem)

    return linked


def linked_versioned(
    request: Request, source_id: str
) -> tuple[dict[str, Any], Path, dict[str, Any], str]:
    """
    登録したデータと, 始めた問題の設定の場所, 中身と, 同じ中身から作った
    中身の印を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    linked: tuple[dict[str, Any], Path, dict[str, Any], str]
        登録したデータ, problem.yaml の場所, 問題の設定, 中身の印

    Raises
    ----------
    HTTPException
        問題の設定から始めていないか無い場合は 404, 読めないか別の問題の
        設定に置き換わった場合は 422
    """
    # 登録したデータに持つ場所と, 始めたときの作った時刻
    source = find_source(request, source_id)
    text = source.get("problem")
    if not isinstance(text, str):
        raise HTTPException(404, "問題の設定から始めたデータではありません")
    path = problem_file(text)
    problem, version = read_problem_bytes(path)
    created = source.get("problem_created")
    if created and str(problem.get("created_at")) != created:
        raise HTTPException(
            422, f"{path} が始めたときと別の問題の設定に置き換わっています"
        )
    linked = (source, path, problem, version)

    return linked


def version_of(path: Path) -> str:
    """
    問題の設定のファイルの中身の印 (sha256) を返す関数

    更新の時刻は秒の単位なので, 同じ秒の変更も見分けられるように中身で

    Parameters
    ----------
    path: Path
        problem.yaml

    Returns
    ----------
    version: str
        中身の sha256 の 16 進
    """
    # ファイルの中身の要約 (読んだ後に消えた場合も 422)
    try:
        version = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        raise HTTPException(
            422, f"問題の設定を読めません: {error}"
        ) from error

    return version


def unchanged(path: Path, version: str) -> None:
    """
    問題の設定のファイルが, 確かめたときから変わっていないことを確かめる
    関数

    Parameters
    ----------
    path: Path
        problem.yaml
    version: str
        確かめたときの中身の印

    Returns
    ----------
    None

    Raises
    ----------
    HTTPException
        変わった場合は 409
    """
    # 中身の印の比べ
    if version_of(path) != version:
        raise HTTPException(409, CHANGED)


def trial_of(
    problem: dict[str, Any], recipe: dict[str, Any]
) -> dict[str, Any]:
    """
    レシピを問題の設定に試しに書き戻す関数 (保存はしない)

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定
    recipe: dict[str, Any]
        ML-EDA のレシピ

    Returns
    ----------
    trial: dict[str, Any]
        apply_recipe の結果 (problem, changes, conflicts, choices)

    Raises
    ----------
    HTTPException
        レシピの形の誤りと, 書き戻せない答えは 422
    """
    # レシピで書き出す受け持ちであることと, レシピの形を確かめてから
    require_recipe(problem)
    try:
        checked = ml_eda.load_recipe(recipe)
        trial: dict[str, Any] = ml_quest.apply_recipe(problem, checked)
    except SHAPE_ERRORS as error:
        raise HTTPException(422, str(error)) from error

    return trial


@router.post("/problems/start", status_code=201)
def start_from_problem(
    request: Request, body: ProblemStart
) -> dict[str, Any]:
    """
    問題の設定から, データを登録してレシピの雛形を保存する関数

    Parameters
    ----------
    request: Request
        リクエスト
    body: ProblemStart
        問題の設定の場所

    Returns
    ----------
    started: dict[str, Any]
        source (登録したデータ. ファイルの組の受け持ちでは None),
        problem (problem.yaml の場所), form (ファイルの組の書き出しの画面の
        欄. 列の予測と画像か表の生成では None), notes (知らせの文の並び),
        tab (開くタブ. まとめるでは groups, 他は None)

    Raises
    ----------
    HTTPException
        問題の設定かデータが無ければ 404, 渡せないか読めなければ 422
    """
    # 渡せる問題の設定と, 入れたデータ. ファイルの組の受け持ちは登録せず,
    # 書き出しの画面へ
    path = problem_file(body.path)
    problem = read_problem(path)
    if is_items_part(problem):
        draft = pairs_draft(problem)
        started: dict[str, Any] = {
            "source": None, "problem": str(path),
            "form": PAIR_FORMS[draft["export"]["function"]],
            "notes": draft["notes"], "tab": None,
        }
        return started
    if is_rank(problem):
        started = start_rank(request, path, problem)
        return started
    if is_group(problem):
        started = start_group(request, path, problem)
        return started
    require_recipe(problem)
    try:
        start = ml_quest.recipe_from(problem)
        recipe = ml_eda.load_recipe(start["recipe"])
    except SHAPE_ERRORS as error:
        raise HTTPException(
            422, f"問題の設定を渡せません: {error}"
        ) from error
    load = start["load"]
    if load is None:
        raise HTTPException(
            422, "問題の設定にデータが入っていません (ML-Pathfinder の "
            "「手元のデータは」で入れてください)"
        )

    # 読めること, 目的の列があること (画像か表の生成は目的の列が無く,
    # データの種類が正解の種類に合うこと) を確かめて登録し, レシピを保存
    data_path = Path(load["path"])
    if not data_path.exists():
        raise HTTPException(404, f"{data_path} がありません")
    options = dict(load.get("options") or {})
    loader = load.get("loader")
    if not loader:
        candidates = ml_eda.detect(data_path)
        if not candidates:
            raise HTTPException(
                422, f"{data_path.name} を読める読み込みがありません"
            )
        loader = candidates[0]["loader"]
    data = load_source(
        {"path": str(data_path), "loader": loader, "options": options}
    )
    target = recipe.get("target")
    if is_generate(problem):
        kind = ml_quest.active_value(problem, f"{ml_quest.PART}.target.kind")
        name = KIND_NAMES[kind]
        if data.kind not in GENERATE_KINDS[kind]:
            raise HTTPException(
                422, f"{data_path.name} は{name}のデータではありません. "
                f"作るものが{name}の問題の設定には, ML-Pathfinder の「手元"
                f"のデータは」で{name}のデータを入れてください"
            )
    elif target not in [str(name) for name in data.frame.columns]:
        raise HTTPException(
            422, f"目的の列 {target} がデータにありません"
        )
    store = get_store(request)
    source = store.add(data_path, problem["name"], loader, data.kind, options)
    # 知らせ (作るものの落とす列と欠損, 画像の大きさなど) は画面の問題の
    # 設定のカードに出し続けるので, 登録したデータに持つ
    source = store.update(source["id"], {
        "target": target, "problem": str(path),
        "problem_created": str(problem["created_at"]),
        "problem_notes": [str(note) for note in start["notes"]],
    }) or source
    store.write_recipe(source["id"], recipe)
    started = {"source": source_view(source), "problem": str(path),
               "form": None, "notes": start["notes"], "tab": None}

    return started


def project_reason(problem: dict[str, Any]) -> Optional[str]:
    """
    問題の設定から骨組みを書き出せない理由を返す関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定

    Returns
    ----------
    reason: Optional[str]
        ML-Quest の project_error の文 (書き出せれば None)
    """
    # 形の崩れた問題の設定も理由の文にする
    try:
        error = ml_quest.project_error(problem)
    except SHAPE_ERRORS as shape:
        error = str(shape)
    reason = f"問題の設定を渡せません: {error}" if error else None

    return reason


def skeleton_reason(problem: dict[str, Any]) -> Optional[str]:
    """
    並べるかまとめるの問題の設定から始められない理由を返す関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (並べるかまとめるで学習する受け持ち)

    Returns
    ----------
    reason: Optional[str]
        骨組みを書き出せない理由 (ML-Quest の project_error) か, データを
        入れていない旨 (始められれば None)
    """
    # 骨組みを書き出せること (入れたデータが表か, 出力の形が順位か群かも)
    reason_text = project_reason(problem)
    if reason_text is None and data_place(problem) is None:
        reason_text = (
            "データが入っていません (ML-Pathfinder の「手元のデータは」で"
            "入れてください)"
        )

    return reason_text


def load_place(
    problem: dict[str, Any], what: str
) -> tuple[Path, str, dict[str, Any], ml_eda.Data]:
    """
    並べるかまとめるの問題の設定に入れた表を, 問題の設定の読み方で読む関数

    読み方が無ければ, 骨組みの load_data と同じく読み込みの候補の先頭

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (並べるかまとめるで学習する受け持ち)
    what: str
        理由の文の表の呼び方 (並べるの反応の表など)

    Returns
    ----------
    loaded: tuple[Path, str, dict[str, Any], ml_eda.Data]
        表の場所, 読み込みの名前, 読み込みの設定, 読み込んだ表

    Raises
    ----------
    HTTPException
        データが無ければ 404, 渡せないか, ファイルでないか読めなければ 422
    """
    # 骨組みを書き出せて, データを入れてあること
    reason = skeleton_reason(problem)
    place = data_place(problem)
    if reason or place is None:
        raise HTTPException(422, reason)
    data_path = Path(place["path"])
    if not data_path.exists():
        raise HTTPException(404, f"{data_path} がありません")
    if not data_path.is_file():
        raise HTTPException(
            422, f"{data_path.name} はファイルではありません. {what}は"
            "ファイル 1 つで入れてください"
        )
    loader = place["loader"]
    if not loader:
        candidates = ml_eda.detect(data_path)
        if not candidates:
            raise HTTPException(
                422, f"{data_path.name} を読める読み込みがありません"
            )
        loader = candidates[0]["loader"]
    options = place["options"]
    data = load_source(
        {"path": str(data_path), "loader": loader, "options": options}
    )
    loaded = (data_path, str(loader), options, data)

    return loaded


def register_linked(
    request: Request, path: Path, problem: dict[str, Any],
    loaded: tuple[Path, str, dict[str, Any], ml_eda.Data], kind: str
) -> dict[str, Any]:
    """
    読んだ表を, 始めた問題の設定と結んで登録する関数 (レシピは保存しない)

    Parameters
    ----------
    request: Request
        リクエスト
    path: Path
        problem.yaml
    problem: dict[str, Any]
        問題の設定
    loaded: tuple[Path, str, dict[str, Any], ml_eda.Data]
        load_place の結果
    kind: str
        登録するデータの種類

    Returns
    ----------
    source: dict[str, Any]
        登録したデータ
    """
    # 始めたときの知らせは無い
    data_path, loader, options, _ = loaded
    store = get_store(request)
    source = store.add(data_path, problem["name"], loader, kind, options)
    source = store.update(source["id"], {
        "problem": str(path),
        "problem_created": str(problem["created_at"]),
        "problem_notes": [],
    }) or source

    return source


def start_rank(
    request: Request, path: Path, problem: dict[str, Any]
) -> dict[str, Any]:
    """
    並べるの問題の設定から, 入れた反応の表を登録する関数

    並べるはレシピを持たないので, レシピは保存しない. 読み方は問題の設定の
    手元のデータの読み方 (骨組みの学習のスクリプトと同じ)

    Parameters
    ----------
    request: Request
        リクエスト
    path: Path
        problem.yaml
    problem: dict[str, Any]
        問題の設定 (並べるで学習する受け持ち)

    Returns
    ----------
    started: dict[str, Any]
        source (登録したデータ), problem, form (None), notes (空), tab
        (None)

    Raises
    ----------
    HTTPException
        データが無ければ 404, 渡せないか, 反応の表として読めなければ 422
    """
    # 問題の設定の列で反応の表として読めること
    loaded = load_place(problem, "並べるの反応の表")
    read_reactions(loaded[3], rank_answers(problem))
    source = register_linked(request, path, problem, loaded, REACTIONS_KIND)
    started: dict[str, Any] = {
        "source": source_view(source), "problem": str(path), "form": None,
        "notes": [], "tab": None,
    }

    return started


def start_group(
    request: Request, path: Path, problem: dict[str, Any]
) -> dict[str, Any]:
    """
    まとめるの問題の設定から, 入れた表を登録する関数

    まとめるはレシピを持たないので, レシピは保存しない. 読み方は問題の設定
    の手元のデータの読み方 (骨組みの学習のスクリプトと同じ). 種類は読み
    込みのまま (表か時系列) で, 表の分析も使える

    Parameters
    ----------
    request: Request
        リクエスト
    path: Path
        problem.yaml
    problem: dict[str, Any]
        問題の設定 (まとめるで学習する受け持ち)

    Returns
    ----------
    started: dict[str, Any]
        source (登録したデータ), problem, form (None), notes (空), tab
        (groups. 群分けのタブを開く)

    Raises
    ----------
    HTTPException
        データが無ければ 404, 渡せないか, 表として読めないか, 答えた列が
        表に無ければ 422
    """
    # 群分けのタブが読む種類で, 骨組みが読む列があること
    loaded = load_place(problem, "まとめるの表")
    data = loaded[3]
    if data.kind not in GROUP_KINDS:
        raise HTTPException(
            422, f"{loaded[0].name} は表として読めません (読み込みの種類 "
            f"{data.kind}). まとめるの問題の設定には, ML-Pathfinder の「手元"
            "のデータは」で 1 行が 1 つの対象の表を入れてください"
        )
    check_group_columns(data, group_answers(problem))
    source = register_linked(request, path, problem, loaded, data.kind)
    started: dict[str, Any] = {
        "source": source_view(source), "problem": str(path), "form": None,
        "notes": [], "tab": "groups",
    }

    return started


def pairs_draft(problem: dict[str, Any]) -> dict[str, Any]:
    """
    ファイルの組の受け持ちの問題の設定から, 書き出しの設定の下書きを返す
    関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定

    Returns
    ----------
    start: dict[str, Any]
        ML-Quest の recipe_from の結果 (export と notes)

    Raises
    ----------
    HTTPException
        渡せない問題の設定は 422
    """
    # 渡せること (確かめに誤りが無いこと) も ML-Quest で
    try:
        start: dict[str, Any] = ml_quest.recipe_from(problem)
    except SHAPE_ERRORS as error:
        raise HTTPException(
            422, f"問題の設定を渡せません: {error}"
        ) from error

    return start


@router.get("/problems/pairs")
def get_problem_pairs(path: str) -> dict[str, Any]:
    """
    ファイルの組の受け持ちの問題の設定の, 書き出しの設定の下書きと書き出し
    先を返す関数

    Parameters
    ----------
    path: str
        problem.yaml か, それを持つディレクトリ

    Returns
    ----------
    result: dict[str, Any]
        name, path, version (書き出すときに送り返す中身の印), form (画面の
        欄), export (書き出しの設定. 書き戻した設定があればそれ), notes,
        project (書き出し先とその様子. get_project と同じ形)

    Raises
    ----------
    HTTPException
        無ければ 404, 読めないか渡せないかファイルの組の受け持ちでなければ
        422
    """
    # 中身の印は読む前に (読んだ後に変わっても書き出しで気付く)
    found = problem_file(path)
    version = version_of(found)
    problem = read_problem(found)
    require_items(problem)
    draft = pairs_draft(problem)
    result = {
        "name": problem.get("name"), "path": str(found), "version": version,
        "form": PAIR_FORMS[draft["export"]["function"]],
        "export": draft["export"], "notes": draft["notes"],
        "project": project_place(project_record(problem)),
    }

    return result


def pair_call(
    settings: dict[str, Any], target: Path, overwrite: bool
) -> dict[str, Any]:
    """
    書き出しの設定のまま, ML-EDA のファイルの組の書き出しを呼ぶ関数

    Parameters
    ----------
    settings: dict[str, Any]
        ML-Quest が決まった形にした書き出しの設定 (中身の手順は
        options.item_steps)
    target: Path
        書き出し先
    overwrite: bool
        前のデータセットを置き換えるか

    Returns
    ----------
    info: dict[str, Any]
        書き出した dataset.yaml の中身
    """
    # 関数は ML-Quest が確かめた 2 つのどちらか. 中身の手順は他の引数から
    # 取り出して 1 度だけ渡す
    function = getattr(ml_eda, settings["function"])
    options = dict(settings["options"])
    item_steps = options.pop("item_steps", None)
    info: dict[str, Any] = function(
        Path(settings["inputs"]).expanduser(),
        Path(settings["targets"]).expanduser(), target,
        split=settings["split"] or None, groups=settings["groups"],
        origin=settings["origin"] or None, name=target.name,
        overwrite=overwrite, item_steps=item_steps or None, **options
    )

    return info


@router.post("/problems/pairs/export")
def export_problem_pairs(body: PairsExport) -> dict[str, Any]:
    """
    ファイルの組を問題の設定のプロジェクトの書き出し先に書き出し, 書き出し
    の設定を問題の設定に書き戻す関数

    Parameters
    ----------
    body: PairsExport
        問題の設定の場所, 確かめたときの中身の印, 書き出しの設定 (中身の
        手順も含む), 置き換えるか

    Returns
    ----------
    result: dict[str, Any]
        書き出した場所, dataset.yaml の中身, 注意 (pair_result と同じ) と,
        changes (書き戻した点), conflicts (注意の食い違い), version (書き
        戻した後の中身の印)

    Raises
    ----------
    HTTPException
        設定の形の誤り, ディレクトリが無い, 書き出し先がプロジェクトの外か
        プロジェクトそのもの, 書き出しの誤りは 422, プロジェクトが無ければ
        404, 問題の設定が変わった, 食い違いの誤り,
        置き換えられない書き出し先は 409
    """
    # 確かめたときから変わっていない問題の設定に, 試しに書き戻す
    path = problem_file(body.path)
    unchanged(path, body.version)
    problem = read_problem(path)
    require_items(problem)
    options = body.export.get("options")
    if isinstance(options, dict):
        check_step_limits(options.get("item_steps"))
    try:
        trial: dict[str, Any] = ml_quest.apply_recipe(problem, body.export)
    except SHAPE_ERRORS as error:
        raise HTTPException(422, str(error)) from error
    errors = [item["message"] for item in trial["conflicts"]
              if item["level"] == "error"]
    if errors:
        raise HTTPException(409, " / ".join(errors))
    updated = trial["problem"]
    settings = ml_quest.get_value(updated, "data.export")
    if not settings["inputs"] or not settings["targets"]:
        raise HTTPException(
            422, "入力と正解のディレクトリを選んでください"
        )

    # 書き出し先と, 置き換えてよいか (書き出しと同じ鍵の中で)
    try:
        with EXPORT_LOCK:
            target = export_place(project_record(problem))
            state = place_state(target)
            if state == "occupied":
                raise HTTPException(
                    409, f"{target} はデータセットではないので置き換えません"
                )
            if state == "dataset" and not body.overwrite:
                raise HTTPException(
                    409, f"{target} には既にデータセットがあります. 置き換え"
                    "てよいかを確かめてから書き出してください"
                )
            info = pair_call(settings, target, body.overwrite)
    except HTTPException:
        raise
    except FileExistsError as error:
        raise HTTPException(409, str(error)) from error
    except Exception as error:  # noqa: BLE001 (壊れたファイルも理由を返す)
        raise HTTPException(422, export_message(error)) from error

    # 保存の直前にも変わっていないこと (変わっていれば書き戻さない)
    if version_of(path) != body.version:
        raise HTTPException(
            409, f"{target} に書き出しましたが, 問題の設定が他で変わったので"
            "書き戻していません. 開き直して書き出し直してください"
        )
    try:
        ml_quest.save_problem(updated, path)
    except OSError as error:
        raise HTTPException(
            422, f"問題の設定を保存できません: {error}"
        ) from error
    result = {
        **pair_result(target, info), "changes": trial["changes"],
        "conflicts": trial["conflicts"], "version": version_of(path),
    }

    return result


@router.post("/sources/{source_id}/problem/check")
def check_problem(
    request: Request, source_id: str, body: ProblemCheck
) -> dict[str, Any]:
    """
    編集中のレシピを問題の設定に試しに書き戻した結果を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: ProblemCheck
        編集中のレシピ

    Returns
    ----------
    result: dict[str, Any]
        name (問題の設定の名前), path, version (書き戻すときに送り返す
        中身の印), changes, conflicts, choices
    """
    # 保存はしない
    _, path, problem = linked_problem(request, source_id)
    trial = trial_of(problem, body.recipe)
    result = {
        "name": problem.get("name"), "path": str(path),
        "version": version_of(path),
        "changes": trial["changes"], "conflicts": trial["conflicts"],
        "choices": trial["choices"],
    }

    return result


@router.post("/sources/{source_id}/problem/write")
def write_problem(
    request: Request, source_id: str, body: ProblemWrite
) -> dict[str, Any]:
    """
    選んだ答えとともに, レシピを問題の設定に書き戻す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: ProblemWrite
        レシピ, 選ぶ問いへの答え (列ごとに known か drop), 確かめたときの
        問題の設定の中身の印

    Returns
    ----------
    result: dict[str, Any]
        changes (変えた点の文), recipe (ここに保存したレシピ), path

    Raises
    ----------
    HTTPException
        確かめた後に問題の設定が変わった場合, 答えていない選ぶ問いと誤りの
        食い違いがある場合, 書き戻した後に渡せないか前処理にかけられない
        場合は 409
    """
    # 確かめた後に変わっていないこと (読む前と後の中身の印も同じ)
    source, path, problem = linked_problem(request, source_id)
    unchanged(path, body.version)

    # 選ぶ問いに全て答え, 誤りが無いこと
    trial = trial_of(problem, body.recipe)
    columns = [choice["column"] for choice in trial["choices"]]
    missing = [name for name in columns if name not in body.choices]
    if missing:
        raise HTTPException(
            409, f"{', '.join(missing)} をどう扱うかを選んでください"
        )
    errors = [item["message"] for item in trial["conflicts"]
              if item["level"] == "error"]
    if errors:
        raise HTTPException(409, " / ".join(errors))

    # 選んだ答えを重ね, 渡せることと前処理にかけられることを確かめて保存
    updated = trial["problem"]
    changes = list(trial["changes"])
    for name in columns:
        option = body.choices[name]
        updated = ml_quest.resolve_choice(updated, name, option)
        changes.append(
            f"{name} を予測の時点で分かる列にした" if option == "known"
            else f"{name} をレシピで落とした"
        )
    try:
        ml_quest.handoff(updated)
        recipe = ml_eda.load_recipe(
            ml_quest.get_value(updated, "data.recipe")
        )
        ml_eda.prepare(load_source(source), recipe, read_items=False)
    except SHAPE_ERRORS as error:
        raise HTTPException(
            409, f"書き戻すと使えなくなります: {error}"
        ) from error
    unchanged(path, body.version)
    try:
        ml_quest.save_problem(updated, path)
    except OSError as error:
        raise HTTPException(
            422, f"問題の設定を保存できません: {error}"
        ) from error
    get_store(request).write_recipe(source_id, recipe)
    result = {"changes": changes, "recipe": recipe, "path": str(path)}

    return result


def project_record(problem: dict[str, Any]) -> Optional[dict[str, str]]:
    """
    問題の設定から, ML-Quest がプロジェクトを作ったときの記録を取り出す
    関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定

    Returns
    ----------
    record: Optional[dict[str, str]]
        path, dataset, model_spec のうち書いてあるもの (無ければ None)
    """
    # 文字で書いた欄だけ (プロジェクトを作っていなければ記録は無い)
    found = problem.get("project")
    record: Optional[dict[str, str]] = None
    if isinstance(found, dict):
        record = {
            key: found[key] for key in ("path", "dataset", "model_spec")
            if isinstance(found.get(key), str) and found[key]
        } or None

    return record


def modified_at(path: Path) -> Optional[str]:
    """
    ファイルの更新時刻を ISO 8601 の文字にする関数

    Parameters
    ----------
    path: Path
        ファイル

    Returns
    ----------
    stamp: Optional[str]
        手元の時刻帯の更新時刻 (読めなければ None)
    """
    # 一覧の並べ替えと表示の時刻
    try:
        moment = dt.datetime.fromtimestamp(path.stat().st_mtime)
    except OSError:
        stamp = None
        return stamp
    stamp = moment.astimezone().isoformat(timespec="seconds")

    return stamp


def problem_entry(path: Path) -> dict[str, Any]:
    """
    ML-Pathfinder の置き場の問題の設定を, 一覧の 1 件にする関数

    Parameters
    ----------
    path: Path
        problem.yaml

    Returns
    ----------
    entry: dict[str, Any]
        場所, 名前, 作った時刻, 更新時刻, 始められるか, 始められない理由,
        プロジェクトの記録
    """
    # 読めないものも理由を付けて並べる (名前はディレクトリの名前)
    entry: dict[str, Any] = {
        "path": str(path), "name": path.parent.name, "created_at": None,
        "updated_at": modified_at(path), "startable": False,
        "reason": None, "project": None,
    }
    try:
        problem = read_problem(path)
    except HTTPException as error:
        entry["reason"] = str(error.detail)
        return entry
    entry.update(
        name=problem["name"], created_at=str(problem["created_at"]),
        project=project_record(problem)
    )

    # 始めるときと同じ確かめ (列の予測と画像か表の生成はデータを入れて
    # あること. ファイルの組の受け持ちはディレクトリを画面で選べる)
    if is_rank(problem) or is_group(problem):
        entry["reason"] = skeleton_reason(problem)
        entry["startable"] = entry["reason"] is None
        return entry
    try:
        if not is_items_part(problem):
            require_recipe(problem)
        load = ml_quest.recipe_from(problem)["load"]
    except HTTPException as error:
        entry["reason"] = str(error.detail)
        return entry
    except SHAPE_ERRORS as error:
        entry["reason"] = f"問題の設定を渡せません: {error}"
        return entry
    if is_items_part(problem):
        entry["startable"] = True
    elif load is None:
        entry["reason"] = (
            "データが入っていません (ML-Pathfinder の「手元のデータは」で"
            "入れてください)"
        )
    else:
        entry["startable"] = True

    return entry


def updated_of(entry: dict[str, Any]) -> str:
    """
    一覧の 1 件の更新時刻を, 並べ替えの鍵にする関数

    Parameters
    ----------
    entry: dict[str, Any]
        一覧の 1 件

    Returns
    ----------
    key: str
        更新時刻の文字 (無ければ空)
    """
    # 時刻の無いものは後ろ
    key = str(entry.get("updated_at") or "")

    return key


@router.get("/problems")
def list_problems() -> dict[str, Any]:
    """
    ML-Pathfinder の置き場にある問題の設定の一覧を返す関数

    Parameters
    ----------
    None

    Returns
    ----------
    result: dict[str, Any]
        root (置き場の problems), problems (更新の新しい順の 1 件の並び),
        error (置き場を読めない場合の理由)
    """
    # problems/<識別子>/problem.yaml (置き場が無ければ空)
    root = get_problems_dir()
    files: list[Path] = []
    error = None
    try:
        if root.is_dir():
            files = [
                child / "problem.yaml" for child in sorted(root.iterdir())
                if (child / "problem.yaml").is_file()
            ]
    except OSError as reason:
        error = f"{root} を読めません: {reason}"
    problems = [problem_entry(file) for file in files]
    problems.sort(key=updated_of, reverse=True)
    result = {"root": str(root), "problems": problems, "error": error}

    return result


def place_state(path: Path) -> str:
    """
    書き出し先の今の様子を返す関数

    Parameters
    ----------
    path: Path
        書き出し先

    Returns
    ----------
    state: str
        missing (無い), dataset (前に書き出したデータセット), occupied
        (データセットでないディレクトリかファイル, シンボリックリンク)
    """
    # 置き換えてよいのは dataset.yaml を持つディレクトリだけ (リンクの先は
    # 書き換えない)
    if path.is_symlink():
        state = "occupied"
    elif not path.exists():
        state = "missing"
    elif path.is_dir() and (path / "dataset.yaml").is_file():
        state = "dataset"
    else:
        state = "occupied"

    return state


def export_place(record: Optional[dict[str, str]]) -> Path:
    """
    プロジェクトの記録から, 書き出し先を決めて確かめる関数

    Parameters
    ----------
    record: Optional[dict[str, str]]
        問題の設定のプロジェクトの記録

    Returns
    ----------
    target: Path
        書き出し先 (project.dataset)

    Raises
    ----------
    HTTPException
        記録 (dataset と path) が無いか絶対パスでない場合と, 書き出し先が
        プロジェクトの中でない場合は 422, プロジェクトが無い場合は 404
    """
    # 記録の書き出し先 (学習のスクリプトがデータセットを読む場所)
    text = (record or {}).get("dataset")
    if not text:
        raise HTTPException(
            422, "この問題の設定にはプロジェクトの記録 (project.dataset) が"
            "ありません. ML-Pathfinder でプロジェクトを作ると書き出せます"
        )
    project = (record or {}).get("path")
    if not project:
        raise HTTPException(
            422, "この問題の設定のプロジェクトの記録に場所 (project.path) "
            "がありません. ML-Pathfinder でプロジェクトを作り直してください"
        )
    target = Path(text)
    root = Path(project)
    if not target.is_absolute() or not root.is_absolute():
        raise HTTPException(
            422, "プロジェクトの記録 (project.path, project.dataset) が"
            "絶対パスではありません"
        )

    # プロジェクトがあること (消したか動かしたプロジェクトの場所に作らない
    # ように)
    if not root.is_dir():
        raise HTTPException(
            404, f"プロジェクト {project} がありません. 消したか動かした"
            "場合は, ML-Pathfinder でプロジェクトを作り直してください"
        )

    # 書き出し先はプロジェクトの中だけ (.. と途中のリンクをたどった後で
    # 比べる. 書き換えた記録で外のファイルを置き換えないように). 書き出し先
    # そのものが中を指すリンクはここでは通し, 置き換えないかは呼び出し側の
    # place_state か file_state が決める
    base = root.resolve()
    place = target.parent.resolve() / target.name
    places = (place, target.resolve())
    if target.name in ("", "..") or base in places or not all(
        item.is_relative_to(base) for item in places
    ):
        raise HTTPException(
            422, f"書き出し先 {target} がプロジェクト {project} の中に"
            "ありません. 外には書き出さないので, ML-Pathfinder で"
            "プロジェクトを作り直してください"
        )

    return target


@router.get("/sources/{source_id}/project")
def get_project(request: Request, source_id: str) -> dict[str, Any]:
    """
    始めた問題の設定のプロジェクトの書き出し先と, その様子を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    result: dict[str, Any]
        project (プロジェクトの場所), dataset (書き出し先), state (missing,
        dataset, occupied. 書き出し先が無ければ None), ready (書き出せるか),
        reason (書き出せない理由)
    """
    # 記録と書き出し先の様子
    _, _, problem = linked_problem(request, source_id)
    single = is_rank(problem) or is_group(problem)
    result = project_place(project_record(problem), single=single)

    return result


def project_place(
    record: Optional[dict[str, str]], single: bool = False
) -> dict[str, Any]:
    """
    プロジェクトの記録から, 書き出し先とその様子を返す関数

    Parameters
    ----------
    record: Optional[dict[str, str]]
        問題の設定のプロジェクトの記録
    single: bool = False
        書き出し先がファイル 1 つ (並べるの反応の表, まとめるの表) か

    Returns
    ----------
    result: dict[str, Any]
        project, dataset, state (missing, dataset, occupied. ファイル 1 つ
        では dataset の代わりに file. 書き出し先が無ければ None), ready
        (書き出せるか), reason (書き出せない理由)
    """
    # 書き出せない理由も画面に出す
    result: dict[str, Any] = {
        "project": (record or {}).get("path"),
        "dataset": (record or {}).get("dataset"),
        "state": None, "ready": False, "reason": None,
    }
    try:
        target = export_place(record)
    except HTTPException as error:
        result["reason"] = str(error.detail)
        return result
    state = file_state(target) if single else place_state(target)
    result["state"] = state
    if state == "occupied":
        result["reason"] = (
            f"{target} はファイルではないので置き換えません" if single
            else f"{target} はデータセットではないので置き換えません"
        )
    else:
        result["ready"] = True

    return result


@router.post("/sources/{source_id}/export_project")
def export_project(
    request: Request, source_id: str, body: ProjectExport
) -> dict[str, Any]:
    """
    レシピで前処理して, 問題の設定のプロジェクトの書き出し先に書き出す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: ProjectExport
        レシピ, 前に書き出したデータセットを置き換えるか

    Returns
    ----------
    result: dict[str, Any]
        書き出した場所と dataset.yaml の中身と, モデルを組むときの数

    Raises
    ----------
    HTTPException
        記録が無いか前処理の失敗か上限を超えた手順の引数と, 書き出し先が
        プロジェクトの外かプロジェクトそのものの場合は 422, プロジェクトが
        無ければ 404,
        データセットでないものがあるか, 置き換えを指定せずにデータセット
        がある場合は 409
    """
    # 手順の引数の上限と, 書き出し先と, 置き換えてよいか (確かめと書き出し
    # の間に変わらないように, 書き出しと同じ鍵の中で確かめる)
    check_recipe_limits(body.recipe)
    source, _, problem = linked_problem(request, source_id)
    require_recipe(problem)
    record = project_record(problem)
    data = load_source(source)
    try:
        with EXPORT_LOCK:
            target = export_place(record)
            state = place_state(target)
            if state == "occupied":
                raise HTTPException(
                    409, f"{target} はデータセットではないので置き換えません"
                )
            if state == "dataset" and not body.overwrite:
                raise HTTPException(
                    409, f"{target} には既にデータセットがあります. 置き換え"
                    "てよいかを確かめてから書き出してください"
                )
            info = ml_eda.export_dataset(
                data, body.recipe, target, name=target.name,
                overwrite=body.overwrite
            )
    except FileExistsError as error:
        raise HTTPException(409, str(error)) from error
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise HTTPException(422, str(error)) from error
    except OSError as error:
        raise HTTPException(
            422, f"{target} に書き出せません: {error}"
        ) from error
    # 書き出してレシピを保存し, 書き出した場所を覚える (一覧に並べるため)
    store = get_store(request)
    store.write_recipe(source_id, ml_eda.load_recipe(body.recipe))
    store.update(source_id, {"project_dataset": str(target)})
    result = {
        "path": str(target), "info": to_json(info),
        "hints": model_hints(target, info),
    }

    return result


def copy_to_project(
    record: Optional[dict[str, str]], data_path: Path, overwrite: bool,
    what: str
) -> tuple[Path, bool]:
    """
    登録した表をファイル 1 つのまま, プロジェクトの書き出し先に写す関数

    書き出し先と, 置き換えてよいかは, 確かめと写しの間に変わらないように,
    写しと同じ鍵の中で確かめる. 骨組みは問題の設定の読み方で読むので,
    拡張子が違えば (読み方を決めていないときの候補が変わるので) 写さない

    Parameters
    ----------
    record: Optional[dict[str, str]]
        問題の設定のプロジェクトの記録
    data_path: Path
        登録した表
    overwrite: bool
        前に置いたファイルを置き換えるか
    what: str
        理由の文の表の呼び方 (反応の表など)

    Returns
    ----------
    copied: tuple[Path, bool]
        書き出し先と, 写したか (書き出し先が登録した表そのものなら False)

    Raises
    ----------
    HTTPException
        記録が無い, 書き出し先がプロジェクトの外かプロジェクトそのもの,
        拡張子が書き出し先と違う, 書けない場合は 422, プロジェクトが無ければ
        404, ファイルでないものがあるか, 置き換えを指定せずにファイルが
        ある場合は 409
    """
    # 書き出し先の様子と拡張子を確かめてから写す
    try:
        with EXPORT_LOCK:
            target = export_place(record)
            state = file_state(target)
            if state == "occupied":
                raise HTTPException(
                    409, f"{target} はファイルではないので置き換えません"
                )
            if state == "file" and not overwrite:
                raise HTTPException(
                    409, f"{target} には既にファイルがあります. 置き換えて"
                    "よいかを確かめてから書き出してください"
                )
            if target.suffix.lower() != data_path.suffix.lower():
                raise HTTPException(
                    422, f"書き出し先 {target.name} と{what} "
                    f"{data_path.name} の拡張子が違います. ML-Pathfinder で"
                    "プロジェクトを作り直してください"
                )
            done = copy_file(data_path, target)
    except OSError as error:
        raise HTTPException(
            422, f"{what}を書き出せません: {error}"
        ) from error
    copied = (target, done)

    return copied


def linked_rank(
    request: Request, source_id: str
) -> tuple[dict[str, Any], Path, dict[str, Any]]:
    """
    並べるの問題の設定から始めたデータと, 問題の設定を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    linked: tuple[dict[str, Any], Path, dict[str, Any]]
        登録したデータ, problem.yaml の場所, 問題の設定

    Raises
    ----------
    HTTPException
        問題の設定から始めていなければ 404, 並べるでなくなっていれば 422
    """
    # 始めた後に受け持ちを答え直した場合も断る
    linked = linked_problem(request, source_id)
    if not is_rank(linked[2]):
        raise HTTPException(
            422, "この問題の設定は並べるで学習する受け持ちではありません. "
            "問題の設定から始め直してください"
        )

    return linked


@router.get("/sources/{source_id}/reactions")
def get_reactions(request: Request, source_id: str) -> dict[str, Any]:
    """
    並べるの問題の設定の列で, 反応の表の要約を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    result: dict[str, Any]
        name (問題の設定の名前), path (problem.yaml), k (並べる件数の答え),
        summary (ML-EDA の describe_reactions の結果)

    Raises
    ----------
    HTTPException
        問題の設定から始めていなければ 404, 並べるでないか反応の表として
        読めなければ 422
    """
    # 読み込み済みの表を渡し, 読み直さない
    source, path, problem = linked_rank(request, source_id)
    answers = rank_answers(problem)
    reactions = read_reactions(load_source(source), answers)
    result = {
        "name": problem.get("name"), "path": str(path), "k": answers["k"],
        "summary": describe(reactions),
    }

    return result


@router.post("/sources/{source_id}/export_reactions")
def export_reactions(
    request: Request, source_id: str, body: ReactionsExport
) -> dict[str, Any]:
    """
    反応の表をファイル 1 つのまま, 問題の設定のプロジェクトの骨組みが読む
    場所 (config の data.dataset) に写す関数

    前処理はかけない (並べるはレシピを持たず, 分割は骨組みが時刻で行う)

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: ReactionsExport
        前に置いた反応の表を置き換えるか

    Returns
    ----------
    result: dict[str, Any]
        path (書き出した場所), copied (写したか. 書き出し先が登録した表
        そのものなら False), reactions (骨組みが反応とみなす行の数),
        dropped (骨組みが除く行の数)

    Raises
    ----------
    HTTPException
        記録が無い, 反応の表として読めない, 書き出し先がプロジェクトの外か
        プロジェクトそのもの, 拡張子が書き出し先と違う, 書けない場合は 422,
        プロジェクトが無ければ 404, ファイルでないものがあるか, 置き換えを
        指定せずにファイルがある場合は 409
    """
    # 骨組みが読めること (列, 時刻) を写す前に確かめる
    source, _, problem = linked_rank(request, source_id)
    record = project_record(problem)
    data_path = Path(source["path"])
    summary = describe(
        read_reactions(load_source(source), rank_answers(problem))
    )

    target, copied = copy_to_project(
        record, data_path, body.overwrite, "反応の表"
    )
    result = {
        "path": str(target), "copied": copied,
        "reactions": summary["reactions"],
        "dropped": summary["dropped"]["total"],
    }

    return result


def linked_group(
    request: Request, source_id: str
) -> tuple[dict[str, Any], Path, dict[str, Any]]:
    """
    まとめるの問題の設定から始めたデータと, 問題の設定を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    linked: tuple[dict[str, Any], Path, dict[str, Any]]
        登録したデータ, problem.yaml の場所, 問題の設定

    Raises
    ----------
    HTTPException
        問題の設定から始めていなければ 404, まとめるでなくなっていれば 422
    """
    # 始めた後に受け持ちを答え直した場合も断る
    linked = linked_problem(request, source_id)
    require_group(linked[2])

    return linked


def require_group(problem: dict[str, Any]) -> None:
    """
    問題の設定がまとめるで学習する受け持ちであることを確かめる関数

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定

    Returns
    ----------
    None

    Raises
    ----------
    HTTPException
        まとめるでなくなっていれば 422
    """
    # 始めた後に受け持ちを答え直した場合
    if not is_group(problem):
        raise HTTPException(
            422, "この問題の設定はまとめるで学習する受け持ちではありません. "
            "問題の設定から始め直してください"
        )


@router.get("/sources/{source_id}/group_problem")
def get_group_problem(request: Request, source_id: str) -> dict[str, Any]:
    """
    始めた問題の設定の, まとめるの答えとプロジェクトの書き出し先を返す関数

    群分けのタブが, 欄を問題の設定の答えで埋めるために開くたびに読む

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    result: dict[str, Any]
        name (問題の設定の名前), path (problem.yaml), group (群を作る列,
        行を見分ける列, 群の数, 安定性の数え方とその言葉. まとめるで学習
        する受け持ちでなければ None), project (書き出し先とその様子.
        group が None なら None)

    Raises
    ----------
    HTTPException
        問題の設定から始めていなければ 404, 読めなければ 422
    """
    # まとめるでなくなっていても名前と場所は返す (画面はカードにそう出す)
    _, path, problem = linked_problem(request, source_id)
    result: dict[str, Any] = {
        "name": problem.get("name"), "path": str(path), "group": None,
        "project": None,
    }
    if not is_group(problem):
        return result
    answers = group_answers(problem)
    choices = next(
        (item.get("choices") or [] for item in ml_quest.QUESTIONS
         if item.get("id") == f"{ml_quest.PART}.group.stability"), []
    )
    label = [str(item["label"]).split(" (")[0] for item in choices
             if item.get("value") == answers["stability"]]
    answers["stability_label"] = label[0] if label else answers["stability"]
    result["group"] = answers
    result["project"] = project_place(project_record(problem), single=True)

    return result


def group_trial(
    problem: dict[str, Any], group: GroupChoice
) -> dict[str, Any]:
    """
    群分けのタブの選び方を問題の設定に試しに書き戻す関数 (保存はしない)

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (まとめるで学習する受け持ち)
    group: GroupChoice
        選び方 (書いた欄だけを書き戻す)

    Returns
    ----------
    trial: dict[str, Any]
        ML-Quest の apply_group の結果 (problem, changes, conflicts,
        choices)

    Raises
    ----------
    HTTPException
        apply_group が断る選び方 (骨組みを組めない問題の設定になるもの)
        は理由を付けて 422
    """
    # 書いた欄だけ (書かない欄は今の答えのまま)
    chosen = group.model_dump(exclude_unset=True)
    try:
        trial: dict[str, Any] = ml_quest.apply_group(problem, chosen)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error

    return trial


@router.post("/sources/{source_id}/group_problem/check")
def check_group_problem(
    request: Request, source_id: str, body: GroupCheck
) -> dict[str, Any]:
    """
    群分けのタブの選び方を, 始めた問題の設定に試しに書き戻した結果を返す
    関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: GroupCheck
        選び方

    Returns
    ----------
    result: dict[str, Any]
        name (問題の設定の名前), path, version (書き戻すときに送り返す
        中身の印), changes (書き戻すと変わる点の文)

    Raises
    ----------
    HTTPException
        問題の設定から始めていなければ 404, まとめるでなくなっているか,
        書き戻せない選び方は 422
    """
    # 保存はしない. 変わる点と印は同じ中身から
    _, path, problem, version = linked_versioned(request, source_id)
    require_group(problem)
    trial = group_trial(problem, body.group)
    result = {
        "name": problem.get("name"), "path": str(path), "version": version,
        "changes": trial["changes"],
    }

    return result


@router.post("/sources/{source_id}/group_problem/write")
def write_group_problem(
    request: Request, source_id: str, body: GroupWrite
) -> dict[str, Any]:
    """
    群分けのタブの選び方を, 始めた問題の設定の ml.parts.<n>.group に書き
    戻して保存する関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: GroupWrite
        選び方と, 確かめたときの問題の設定の中身の印

    Returns
    ----------
    result: dict[str, Any]
        changes (変えた点の文), group (書き戻した後の答え. group_answers
        の結果), path, version (書き戻した後の中身の印)

    Raises
    ----------
    HTTPException
        問題の設定から始めていなければ 404, まとめるでなくなっているか,
        書き戻せない選び方か, 保存できなければ 422, 確かめた後に問題の
        設定が変わった場合は 409
    """
    # 確かめた後に変わっていないこと (書き戻す中身と印は同じ読みから.
    # 保存の直前にも見る)
    _, path, problem, version = linked_versioned(request, source_id)
    if version != body.version:
        raise HTTPException(409, CHANGED)
    require_group(problem)
    trial = group_trial(problem, body.group)
    updated = trial["problem"]
    unchanged(path, body.version)
    try:
        ml_quest.save_problem(updated, path)
    except OSError as error:
        raise HTTPException(
            422, f"問題の設定を保存できません: {error}"
        ) from error
    result = {
        "changes": trial["changes"], "group": group_answers(updated),
        "path": str(path), "version": version_of(path),
    }

    return result


@router.post("/sources/{source_id}/export_group_project")
def export_group_project(
    request: Request, source_id: str, body: GroupProjectExport
) -> dict[str, Any]:
    """
    まとめるの問題の設定から始めた表をファイル 1 つのまま, プロジェクトの
    骨組みが読む場所 (config の data.dataset) に写す関数

    前処理はかけない (まとめるはレシピを持たず, 分割は骨組みが行う). 骨組み
    は問題の設定の読み方で読み, 答えた列だけを使う

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: GroupProjectExport
        前に置いた表を置き換えるか

    Returns
    ----------
    result: dict[str, Any]
        path (書き出した場所), copied (写したか. 書き出し先が登録した表
        そのものなら False), rows (行の数), columns (骨組みが群を作る列),
        id (骨組みが行を見分ける列か None)

    Raises
    ----------
    HTTPException
        記録が無い, 答えた列が表に無い, 書き出し先がプロジェクトの外か
        プロジェクトそのもの, 拡張子が書き出し先と違う, 書けない場合は 422,
        プロジェクトが無ければ 404, ファイルでないものがあるか, 置き換えを
        指定せずにファイルがある場合は 409
    """
    # 骨組みが読めること (今の問題の設定の答えの列) を写す前に確かめる
    source, _, problem = linked_group(request, source_id)
    data = load_source(source)
    answers = group_answers(problem)
    check_group_columns(data, answers)
    # 始めた後に答え直した場合も, 始めるのと同じ ML-Quest の確かめで断る
    reason = project_reason(problem)
    if reason:
        raise HTTPException(422, reason)
    target, copied = copy_to_project(
        project_record(problem), Path(source["path"]), body.overwrite,
        "群分けの表"
    )
    result = {
        "path": str(target), "copied": copied, "rows": len(data.frame),
        "columns": answers["columns"], "id": answers["id"],
    }

    return result
