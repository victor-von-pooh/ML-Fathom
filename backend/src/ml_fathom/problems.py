from pathlib import Path
from typing import Any, Literal

import ml_eda
import ml_quest
import yaml
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ml_fathom.api import find_source, get_store, load_source, source_view

router = APIRouter(prefix="/api")

# 問題の設定を読めないときの例外
READ_ERRORS = (OSError, ValueError, yaml.YAMLError, TypeError, KeyError)


class ProblemStart(BaseModel):
    path: str = Field(description="problem.yaml か, それを持つディレクトリ")


class ProblemCheck(BaseModel):
    recipe: dict[str, Any]


class ProblemWrite(BaseModel):
    recipe: dict[str, Any]
    choices: dict[str, Literal["known", "drop"]] = Field(default_factory=dict)


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
        無い場合は 404
    """
    # ディレクトリなら中の problem.yaml
    path = Path(text.strip()).expanduser().resolve()
    if path.is_dir():
        path = path / "problem.yaml"
    if not path.is_file():
        raise HTTPException(404, f"{path} に問題の設定がありません")

    return path


def read_problem(path: Path) -> dict[str, Any]:
    """
    問題の設定を読む関数

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
        読めない場合は 422
    """
    # 形の違うファイルは誤り
    try:
        problem: dict[str, Any] = ml_quest.load_problem(path)
    except READ_ERRORS as error:
        raise HTTPException(
            422, f"問題の設定を読めません: {error}"
        ) from error

    return problem


def linked_problem(
    request: Request, source_id: str
) -> tuple[Path, dict[str, Any]]:
    """
    登録したデータの, 始めた問題の設定の場所と中身を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    linked: tuple[Path, dict[str, Any]]
        problem.yaml の場所と問題の設定

    Raises
    ----------
    HTTPException
        問題の設定から始めていない場合は 404, 読めない場合は 404 か 422
    """
    # 登録したデータに持つ場所
    source = find_source(request, source_id)
    text = source.get("problem")
    if not isinstance(text, str):
        raise HTTPException(404, "問題の設定から始めたデータではありません")
    path = problem_file(text)
    linked = (path, read_problem(path))

    return linked


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
    trial: dict
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
    except (ValueError, TypeError, AttributeError) as error:
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
        問題の設定が無ければ 404, 渡せないか読めなければ 422
    """
    # 渡せる問題の設定と, 入れたデータ
    path = problem_file(body.path)
    problem = read_problem(path)
    try:
        start = ml_quest.recipe_from(problem)
    except ValueError as error:
        raise HTTPException(
            422, f"問題の設定を渡せません: {error}"
        ) from error
    load = start["load"]
    if load is None:
        raise HTTPException(
            422, "問題の設定にデータが入っていません (ML-Pathfinder の "
            "「手元のデータは」で入れてください)"
        )

    # 読めることを確かめて登録し, レシピを保存
    data_path = Path(load["path"])
    if not data_path.exists():
        raise HTTPException(404, f"{data_path} がありません")
    options = dict(load.get("options") or {})
    loader = load.get("loader") or ml_eda.detect(data_path)[0]["loader"]
    draft = {"path": str(data_path), "loader": loader, "options": options}
    data = load_source(draft)
    try:
        recipe = ml_eda.load_recipe(start["recipe"])
    except (ValueError, TypeError, AttributeError) as error:
        raise HTTPException(422, str(error)) from error
    store = get_store(request)
    name = str(problem.get("name") or data_path.name)
    source = store.add(data_path, name, loader, data.kind, options)
    source = store.update(source["id"], {
        "target": recipe.get("target"), "problem": str(path),
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
        name (問題の設定の名前), path, changes, conflicts, choices
    """
    # 保存はしない
    path, problem = linked_problem(request, source_id)
    trial = trial_of(problem, body.recipe)
    result = {
        "name": problem.get("name"), "path": str(path),
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
        レシピと, 選ぶ問いへの答え (列ごとに known か drop)

    Returns
    ----------
    result: dict[str, Any]
        changes (変えた点の文), recipe (ここに保存したレシピ), path

    Raises
    ----------
    HTTPException
        答えていない選ぶ問いと, 誤りの食い違いがあれば 409
    """
    # 選ぶ問いに全て答え, 誤りが無いこと
    path, problem = linked_problem(request, source_id)
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

    # 選んだ答えを重ねて保存. 落とすと選んだ列はレシピにも
    updated = trial["problem"]
    changes = list(trial["changes"])
    for name in columns:
        option = body.choices[name]
        updated = ml_quest.resolve_choice(updated, name, option)
        changes.append(
            f"{name} を予測の時点で分かる列にした" if option == "known"
            else f"{name} をレシピで落とした"
        )
    recipe = ml_eda.load_recipe(ml_quest.get_value(updated, "data.recipe"))
    try:
        ml_quest.save_problem(updated, path)
    except OSError as error:
        raise HTTPException(
            422, f"問題の設定を保存できません: {error}"
        ) from error
    get_store(request).write_recipe(source_id, recipe)
    result = {"changes": changes, "recipe": recipe, "path": str(path)}

    return result
