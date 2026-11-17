import hashlib
from pathlib import Path
from typing import Any, Literal

import ml_eda
import ml_quest
import yaml
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ml_fathom.api import find_source, get_store, load_source, source_view

router = APIRouter(prefix="/api")

# 問題の設定のファイルを読めないときの例外
READ_ERRORS = (OSError, ValueError, yaml.YAMLError)

# 問題の設定の形が崩れているときに ML-Quest から出る例外
SHAPE_ERRORS = (ValueError, TypeError, AttributeError, KeyError)

# 問題の設定のファイルの拡張子
SUFFIXES = (".yaml", ".yml")


class ProblemStart(BaseModel):
    path: str = Field(description="problem.yaml か, それを持つディレクトリ")


class ProblemCheck(BaseModel):
    recipe: dict[str, Any]


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
    # ディレクトリなら中の problem.yaml
    path = Path(text.strip()).expanduser().resolve()
    if path.is_dir():
        path = path / "problem.yaml"
    if not path.is_file():
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
    # ファイルの中身の要約
    version = hashlib.sha256(path.read_bytes()).hexdigest()

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
    # レシピの形を確かめてから
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
        source (登録したデータ), notes (知らせの文の並び)

    Raises
    ----------
    HTTPException
        問題の設定かデータが無ければ 404, 渡せないか読めなければ 422
    """
    # 渡せる問題の設定と, 入れたデータ
    path = problem_file(body.path)
    problem = read_problem(path)
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
    started = {"source": source_view(source), "notes": start["notes"]}

    return started


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
