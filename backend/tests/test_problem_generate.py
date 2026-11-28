from pathlib import Path
from typing import Any

import ml_eda
import ml_quest
import numpy as np
import pandas as pd
import pytest
import yaml
from fastapi.testclient import TestClient
from ml_quest import example_problem
from PIL import Image

from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"

# 受け持ちの場所
PART = ml_quest.PART


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    """
    一時ディレクトリを置き場にしたアプリのクライアントを作る関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    client: TestClient
        トークンを送るクライアント
    """
    app = create_app(
        data_dir=tmp_path / "home", token=TOKEN, allowed_hosts=["testserver"]
    )
    client = TestClient(app, headers={"x-fathom-token": TOKEN})

    return client


def generate_problem(kind: str) -> dict[str, Any]:
    """
    見本の課題から, 作るの受け持ちの問題の設定を作る関数

    Parameters
    ----------
    kind: str
        作るものの正解の種類 (image か table)

    Returns
    ----------
    problem: dict[str, Any]
        作るで正解の種類と出力の形が kind, 指標が loss の問題の設定 (データ
        は入れていない)
    """
    # 1 から 4 と 9, 10 は見本のまま, 受け持ちは作り直し
    problem = example_problem("総菜の作る量")
    problem["ml"]["parts"] = [{}]
    for key in ("decision", "basis", "current"):
        problem["action"].pop(key, None)
    for key, value in [("role", "generate"), ("unit", "row"),
                       ("output", kind), ("target.source", "self"),
                       ("target.kind", kind), ("method", "scratch"),
                       ("what", "似た見本"), ("item", "1 件"),
                       ("baseline", "手で作る"),
                       ("evaluation.metric", "loss"),
                       ("evaluation.link", "見本で確かめる")]:
        problem = ml_quest.answer(problem, f"{PART}.{key}", value)

    return problem


def write_table(root: Path) -> Path:
    """
    ID の列と欠損のある, 数と種類の列の表の CSV を作る関数

    Parameters
    ----------
    root: Path
        書き出す場所

    Returns
    ----------
    path: Path
        CSV のファイル
    """
    # 決まった乱数. ID の列は作らない列, 年齢の一部は欠損
    rng = np.random.default_rng(0)
    rows = 60
    frame = pd.DataFrame({
        "id": [f"u{index}" for index in range(rows)],
        "age": rng.normal(40, 10, rows).round(1),
        "visits": rng.integers(0, 10, rows),
        "city": rng.choice(["a", "b", "c"], rows),
    })
    frame.loc[:5, "age"] = np.nan
    root.mkdir(parents=True, exist_ok=True)
    path = root / "customers.csv"
    frame.to_csv(path, index=False)

    return path


def write_images(root: Path) -> Path:
    """
    クラスの無い, 大きさの混ざった画像のディレクトリを作る関数

    Parameters
    ----------
    root: Path
        書き出す場所

    Returns
    ----------
    path: Path
        <番号>.png のディレクトリ
    """
    # 黒地に白の丸. 1 枚だけ大きさが違う
    path = root / "images"
    path.mkdir(parents=True)
    for index in range(12):
        size = 10 if index == 0 else 8
        image = Image.new("L", (size, size), "black")
        image.putpixel((index % 4 + 2, 3), 255)
        image.save(path / f"{index}.png")

    return path


def saved_problem(
    tmp_path: Path, kind: str, source: Path
) -> tuple[Path, Path]:
    """
    データを入れた作るの問題の設定から ML-Quest でプロジェクトを作り,
    記録とともに保存する関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    kind: str
        作るものの正解の種類
    source: Path
        入れるデータ

    Returns
    ----------
    paths: tuple[Path, Path]
        problem.yaml を持つディレクトリと, プロジェクトのディレクトリ
    """
    # 骨組みの書き出しと, その記録 (project.dataset は config の
    # data.dataset)
    problem = ml_quest.attach_data(generate_problem(kind), str(source))
    project = tmp_path / "project"
    ml_quest.make_project(problem, project)
    problem = ml_quest.record_project(problem, project)
    path = tmp_path / "problem"
    ml_quest.save_problem(problem, path)
    paths = (path, project)

    return paths


def config_dataset(project: Path) -> Path:
    """
    骨組みの config の, 学習のスクリプトがデータセットを読む場所を返す関数

    Parameters
    ----------
    project: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    place: Path
        config の data.dataset (プロジェクトからの場所)
    """
    # 既定の config
    config = yaml.safe_load(
        (project / "configs" / "default" / "train.yaml").read_text("utf-8")
    )
    place = project / config["data"]["dataset"]

    return place


def test_generate_table(client: TestClient, tmp_path: Path) -> None:
    """
    作るものが表の問題の設定から, 目的の列の無いレシピで始めて書き戻し,
    表の生成の骨組みが読む形でプロジェクトに書き出すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 始められるものとして並び, 目的の列の無い task: none のレシピで始まる
    path, project = saved_problem(
        tmp_path, "table", write_table(tmp_path / "raw")
    )
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    body = started.json()
    assert body["form"] is None and body["source"]["target"] is None
    assert body["source"]["kind"] == "table"
    assert body["source"]["problem_notes"] == body["notes"]
    assert any("drop_columns" in note for note in body["notes"])
    url = f"/api/sources/{body['source']['id']}"
    recipe = client.get(f"{url}/recipe").json()
    assert recipe["task"] == "none" and recipe.get("target") is None

    # ID の列を落とし欠損を埋めたレシピは, 選ぶ問いも誤りも無い
    recipe["steps"] = [
        {"op": "drop_columns", "columns": ["id"]},
        {"op": "impute", "columns": ["age"], "strategy": "median"},
    ]
    checked = client.post(f"{url}/problem/check", json={"recipe": recipe})
    assert checked.status_code == 200
    result = checked.json()
    assert result["choices"] == [] and result["conflicts"] == []

    # 目的の列を書いたレシピは誤りの食い違いで, 書き戻さない
    wrong = {**recipe, "target": "city", "task": "classification"}
    conflicts = client.post(
        f"{url}/problem/check", json={"recipe": wrong}
    ).json()["conflicts"]
    assert [item["level"] for item in conflicts] == ["error"]
    assert client.post(f"{url}/problem/write", json={
        "recipe": wrong, "version": result["version"]
    }).status_code == 409

    # 書き戻すとレシピを問題の設定の data.recipe に持ち, 受け渡せる
    written = client.post(f"{url}/problem/write", json={
        "recipe": recipe, "version": result["version"]
    })
    assert written.status_code == 200
    problem = ml_quest.load_problem(path / "problem.yaml")
    saved = ml_quest.get_value(problem, "data.recipe")
    assert saved["steps"] == recipe["steps"] and saved["task"] == "none"
    assert ml_quest.handoff(problem)["data"]["target"] is None
    assert problem["project"]["path"] == str(project)

    # 骨組みの config の場所に, 目的の列と欠損の無い表のデータセット
    # (検証用の分割付き) を書き出す
    exported = client.post(f"{url}/export_project", json={"recipe": recipe})
    assert exported.status_code == 200
    place = Path(exported.json()["path"])
    assert place == config_dataset(project)
    dataset = ml_eda.load_dataset(place)
    assert dataset.info["kind"] == "table" and dataset.info["task"] == "none"
    assert dataset.target is None and "valid" in dataset.frames
    assert set(dataset.features) == {"age", "visits", "city"}
    for frame in dataset.frames.values():
        assert not frame[list(dataset.features)].isna().any().any()


def test_generate_image(client: TestClient, tmp_path: Path) -> None:
    """
    作るものが画像の問題の設定から, 目的の列の無いレシピと中身の手順で
    始めて書き戻し, 画像の生成の骨組みが読む形でプロジェクトに書き出す
    ことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 画像のディレクトリを登録し, ファイルの組の書き出しの画面には移らない
    path, project = saved_problem(
        tmp_path, "image", write_images(tmp_path / "raw")
    )
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    body = started.json()
    assert body["form"] is None and body["source"]["kind"] == "image"
    assert any("resize" in note for note in body["notes"])
    assert client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).status_code == 422

    # 大きさをそろえる中身の手順を足して書き戻す
    url = f"/api/sources/{body['source']['id']}"
    recipe = client.get(f"{url}/recipe").json()
    assert recipe["task"] == "none" and recipe.get("target") is None
    recipe["item_steps"] = [{"op": "resize", "width": 8, "height": 8}]
    result = client.post(
        f"{url}/problem/check", json={"recipe": recipe}
    ).json()
    assert result["choices"] == [] and result["conflicts"] == []
    assert client.post(f"{url}/problem/write", json={
        "recipe": recipe, "version": result["version"]
    }).status_code == 200
    problem = ml_quest.load_problem(path / "problem.yaml")
    assert ml_quest.get_value(problem, "data.recipe")["item_steps"] == (
        recipe["item_steps"]
    )

    # 骨組みの config の場所に, 目的の列の無い画像のデータセット
    exported = client.post(f"{url}/export_project", json={"recipe": recipe})
    assert exported.status_code == 200
    place = Path(exported.json()["path"])
    assert place == config_dataset(project)
    info = yaml.safe_load((place / "dataset.yaml").read_text("utf-8"))
    assert info["kind"] == "image" and info["task"] == "none"
    assert info.get("target") is None and "valid" in info["splits"]
    assert info["splits"]["train"]["shape"][1:] == [1, 8, 8]


def test_generate_wrong_data(client: TestClient, tmp_path: Path) -> None:
    """
    作るものの種類に合わないデータを入れた問題の設定は, 登録せずに理由を
    返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 作るものが表なのに画像のディレクトリ
    problem = ml_quest.attach_data(
        generate_problem("table"), str(write_images(tmp_path))
    )
    path = tmp_path / "problem"
    ml_quest.save_problem(problem, path)
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "表のデータではありません" in detail
    assert "image_folder" not in detail and "読み込み" not in detail
    assert client.get("/api/sources").json() == []

    # 作るものが画像なのに, ディレクトリでない表のファイル
    table = write_table(tmp_path / "raw")
    problem = ml_quest.attach_data(generate_problem("image"), str(table))
    ml_quest.save_problem(problem, path)
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    assert "画像のデータではありません" in response.json()["detail"]
    assert client.get("/api/sources").json() == []


def test_generate_timeseries_table(
    client: TestClient, tmp_path: Path
) -> None:
    """
    日時の列を持ち時系列として読まれる表も, 作るものが表の問題の設定で
    始められることを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 日ごとの行 (ML-EDA は日時の列を見つけて timeseries にする)
    rows = 40
    data = tmp_path / "daily.csv"
    pd.DataFrame({
        "date": pd.date_range("2025-01-01", periods=rows).strftime(
            "%Y-%m-%d"
        ),
        "sales": np.arange(rows) % 7 + 10,
        "store": ["east", "west"] * (rows // 2),
    }).to_csv(data, index=False)
    path, _ = saved_problem(tmp_path, "table", data)
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    source = started.json()["source"]
    assert source["kind"] == "timeseries" and source["target"] is None

    # 目的の列の無いレシピのまま, 食い違いなく確かめられる
    recipe = client.get(f"/api/sources/{source['id']}/recipe").json()
    assert recipe["task"] == "none"
    checked = client.post(
        f"/api/sources/{source['id']}/problem/check", json={"recipe": recipe}
    ).json()
    assert checked["conflicts"] == [] and checked["choices"] == []


def test_other_roles(client: TestClient, tmp_path: Path) -> None:
    """
    方策など他の受け持ちは, 使えない受け持ちが分かる理由で断ることを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 効果を見積もるの方策
    policy = ml_quest.answer(
        example_problem("総菜の作る量"), f"{PART}.role", "effect"
    )
    policy = ml_quest.answer(policy, f"{PART}.autonomous", True)
    ml_quest.save_problem(policy, tmp_path / "policy")
    response = client.post(
        "/api/problems/start", json={"path": str(tmp_path / "policy")}
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "「効果を見積もる」(effect)" in detail and "方策" in detail
    assert "使えません" in detail and "データを登録" in detail

    # 既製のモデルをそのまま使う並べる
    rank = ml_quest.answer(
        example_problem("総菜の作る量"), f"{PART}.role", "rank"
    )
    rank = ml_quest.answer(rank, f"{PART}.method", "pretrained")
    ml_quest.save_problem(rank, tmp_path / "rank")
    response = client.post(
        "/api/problems/start", json={"path": str(tmp_path / "rank")}
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "「並べる」(rank)" in detail and "学習しない" in detail

    # 作るでも正解の種類が文なら断る
    text = ml_quest.answer(generate_problem("table"), f"{PART}.output", "text")
    text = ml_quest.answer(text, f"{PART}.target.kind", "text")
    ml_quest.save_problem(text, tmp_path / "text")
    response = client.post(
        "/api/problems/start", json={"path": str(tmp_path / "text")}
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "「作る」(generate)" in detail and "「文」(text)" in detail
    assert "まだ扱えません" in detail
