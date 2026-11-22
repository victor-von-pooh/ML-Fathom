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
    check_step_limits,
    export_message,
    find_source,
    get_store,
    load_source,
    model_hints,
    pair_result,
    source_view,
)
from ml_fathom.jsonable import to_json
from ml_fathom.settings import get_problems_dir

router = APIRouter(prefix="/api")

# 問題の設定のファイルを読めないときの例外
READ_ERRORS = (OSError, ValueError, yaml.YAMLError)

# 問題の設定の形が崩れているときに ML-Quest から出る例外
SHAPE_ERRORS = (ValueError, TypeError, AttributeError, KeyError)

# 問題の設定のファイルの拡張子
SUFFIXES = (".yaml", ".yml")

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
    # 版の番号の他に, 名前と作った時刻 (ML-Quest が必ず書く) を持つこと
    try:
        problem: dict[str, Any] = ml_quest.load_problem(path)
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

    return problem


def require_column(problem: dict[str, Any]) -> None:
    """
    受け持ちが列の予測 (予測するで, 正解が表の列) でなければ止める関数

    ML-Quest の版 2 の問題の設定は, 受け持ち (作る, 並べるなど) と正解の
    種類 (領域, 点群など) を持つ. 登録したデータのレシピの下書きと書き戻し
    は列の予測だけ (ファイルの組の受け持ちは require_items)

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
        列の予測でない場合は 422 (受け持ちと正解の種類と, できることの文)
    """
    # 受け持ちと正解の種類 (答えていなければ未定)
    if is_column_part(problem):
        return
    part = ml_quest.PART
    role = ml_quest.get_value(problem, f"{part}.role") or "未定"
    kind = ml_quest.get_value(problem, f"{part}.target.kind") or "未定"
    raise HTTPException(
        422,
        f"この問題の設定の受け持ちは {role} (正解の種類 {kind}) です. "
        "問題の設定から始めることと書き戻しは, 今は予測する (predict) で"
        "正解が表の列 (column), 画像の領域 (mask), 点群 (point_cloud) の"
        "場合だけです. データは「データを追加」から入れて分析できます"
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
        列の予測なら 422 (データの画面から始める), 他は require_column と
        同じ 422
    """
    # 列の予測は登録したデータで始める
    if is_items_part(problem):
        return
    if is_column_part(problem):
        raise HTTPException(
            422, "この問題の設定は列の予測です. データの画面の「問題の設定"
            "から始める」で始めてください"
        )
    require_column(problem)


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
        問題の設定から始めていないか無い場合は 404, 読めないか別の問題の
        設定に置き換わった場合は 422
    """
    # 登録したデータに持つ場所と, 始めたときの作った時刻
    source = find_source(request, source_id)
    text = source.get("problem")
    if not isinstance(text, str):
        raise HTTPException(404, "問題の設定から始めたデータではありません")
    path = problem_file(text)
    problem = read_problem(path)
    created = source.get("problem_created")
    if created and str(problem.get("created_at")) != created:
        raise HTTPException(
            422, f"{path} が始めたときと別の問題の設定に置き換わっています"
        )
    linked = (source, path, problem)

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
        raise HTTPException(
            409, "問題の設定が他で変わりました. 確かめ直したので, 見直して"
            "からもう一度書き戻してください"
        )


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
    # 列の予測であることと, レシピの形を確かめてから
    require_column(problem)
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
        欄. 列の予測では None), notes (知らせの文の並び)

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
            "notes": draft["notes"],
        }
        return started
    require_column(problem)
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

    # 読めること, 目的の列があることを確かめて登録し, レシピを保存
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
    if target not in [str(name) for name in data.frame.columns]:
        raise HTTPException(
            422, f"目的の列 {target} がデータにありません"
        )
    store = get_store(request)
    source = store.add(data_path, problem["name"], loader, data.kind, options)
    source = store.update(source["id"], {
        "target": target, "problem": str(path),
        "problem_created": str(problem["created_at"]),
    }) or source
    store.write_recipe(source["id"], recipe)
    started = {"source": source_view(source), "problem": str(path),
               "form": None, "notes": start["notes"]}

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
        設定の形の誤り, ディレクトリが無い, 書き出しの誤りは 422,
        プロジェクトが無ければ 404, 問題の設定が変わった, 食い違いの誤り,
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

    # 始めるときと同じ確かめ (列の予測はデータを入れてあること.
    # ファイルの組の受け持ちはディレクトリを画面で選べる)
    try:
        if not is_items_part(problem):
            require_column(problem)
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
        記録 (dataset と path) が無いか絶対パスでない場合は 422,
        プロジェクトか, プロジェクトの外の親のディレクトリが無い場合は 404
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

    # プロジェクトがあること. 親はプロジェクトの中なら作り, 外なら既にある
    # ものだけ (消したか動かしたプロジェクトの場所に作らないように)
    if not root.is_dir():
        raise HTTPException(
            404, f"プロジェクト {project} がありません. 消したか動かした"
            "場合は, ML-Pathfinder でプロジェクトを作り直してください"
        )
    inside = target.resolve().is_relative_to(root.resolve())
    if not inside and not target.parent.is_dir():
        raise HTTPException(404, f"{target.parent} がありません")

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
    result = project_place(project_record(problem))

    return result


def project_place(record: Optional[dict[str, str]]) -> dict[str, Any]:
    """
    プロジェクトの記録から, 書き出し先とその様子を返す関数

    Parameters
    ----------
    record: Optional[dict[str, str]]
        問題の設定のプロジェクトの記録

    Returns
    ----------
    result: dict[str, Any]
        project, dataset, state (missing, dataset, occupied. 書き出し先が
        無ければ None), ready (書き出せるか), reason (書き出せない理由)
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
    state = place_state(target)
    result["state"] = state
    if state == "occupied":
        result["reason"] = (
            f"{target} はデータセットではないので置き換えません"
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
        記録が無いか前処理の失敗は 422, プロジェクトが無ければ 404,
        データセットでないものがあるか, 置き換えを指定せずにデータセット
        がある場合は 409
    """
    # 書き出し先と, 置き換えてよいか (確かめと書き出しの間に変わらない
    # ように, 書き出しと同じ鍵の中で確かめる)
    source, _, problem = linked_problem(request, source_id)
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
