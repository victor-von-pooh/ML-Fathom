import hashlib
from pathlib import Path
from typing import Any

import ml_quest
import pandas as pd
import pytest
import yaml
from fastapi.testclient import TestClient
from ml_quest.examples import example_problem

from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"


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


def write_problem(tmp_path: Path) -> Path:
    """
    総菜の見本の問題の設定に, 日々の売れた数の表を入れて保存する関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    path: Path
        problem.yaml を持つディレクトリ
    """
    # 40 日 × 2 店 × 2 品. 客数は予測の時点で分からない列
    rows = [
        {"date": day.strftime("%Y-%m-%d"), "store": store, "item": item,
         "sales": 10 + day.day_of_week, "temperature_forecast": 15.0,
         "promo": 0, "customers": (10 + day.day_of_week) * 3}
        for day in pd.date_range("2025-01-01", periods=40)
        for store in ("east", "west") for item in ("a", "b")
    ]
    data = tmp_path / "sozai.csv"
    pd.DataFrame(rows).to_csv(data, index=False)
    problem = ml_quest.attach_data(example_problem("総菜の作る量"), data)
    path = tmp_path / "problem"
    ml_quest.save_problem(problem, path)

    return path


def current(path: Path) -> str:
    """
    問題の設定のファイルの今の中身の印を返す関数

    Parameters
    ----------
    path: Path
        problem.yaml を持つディレクトリ

    Returns
    ----------
    version: str
        中身の sha256 の 16 進
    """
    # 画面が確かめで受け取るものと同じ
    version = hashlib.sha256((path / "problem.yaml").read_bytes()).hexdigest()

    return version


def without_drop(recipe: dict[str, Any]) -> dict[str, Any]:
    """
    レシピから列を落とす手順を除く関数

    Parameters
    ----------
    recipe: dict[str, Any]
        レシピ

    Returns
    ----------
    changed: dict[str, Any]
        drop_columns の無いレシピ
    """
    # 分からない列 (客数) を使うレシピにする
    changed = {**recipe, "steps": [
        step for step in recipe["steps"] if step["op"] != "drop_columns"
    ]}

    return changed


def to_version1(path: Path) -> None:
    """
    保存した版 2 の問題の設定を, 版 1 の形に書き直す関数

    版 1 は受け持ちの項目を ml の直下に, 指標を evaluation に持つ

    Parameters
    ----------
    path: Path
        problem.yaml を持つディレクトリ

    Returns
    ----------
    None
    """
    # 受け持ちの 1 つ目を ml の直下へ (版 2 で足した型の答えは除く)
    file = path / "problem.yaml"
    problem = yaml.safe_load(file.read_text(encoding="utf-8"))
    part = problem["ml"].pop("parts")[0]
    for key in ("role", "unit", "output", "method"):
        part.pop(key, None)
    target = part.pop("target")
    problem["evaluation"] = {
        **(problem.get("evaluation") or {}), **part.pop("evaluation"),
    }
    problem["ml"].update(
        part, target=target["column"], predict=part.pop("what"),
        row=part.pop("item")
    )
    problem["format_version"] = 1
    file.write_text(
        yaml.safe_dump(problem, allow_unicode=True, sort_keys=False),
        encoding="utf-8"
    )


def test_start_from_problem(client: TestClient, tmp_path: Path) -> None:
    """
    問題の設定から始めると, データと決めた状態のレシピが入ることを
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
    # 目的の列, タスク, 分割, 落とす列, 決める時点で分かる期からの過去の値
    path = write_problem(tmp_path)
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 201
    source = response.json()["source"]
    assert source["target"] == "sales"
    assert source["problem"] == str((path / "problem.yaml").resolve())
    recipe = client.get(f"/api/sources/{source['id']}/recipe").json()
    assert recipe["task"] == "forecasting"
    assert recipe["split"]["method"] == "time"
    ops = {step["op"]: step for step in recipe["steps"]}
    assert ops["drop_columns"]["columns"] == ["customers"]
    assert ops["lag"]["lags"] == [2]
    assert ops["lag"]["by"] == ["store", "item"]

    # 無い場所と, データを入れていない問題の設定
    assert client.post("/api/problems/start", json={
        "path": str(tmp_path / "none")
    }).status_code == 404
    for broken in ("/tmp/a\x00b", "~nosuchuser0123/problem.yaml",
                   "/" + "a" * 5000):
        assert client.post("/api/problems/start", json={
            "path": broken
        }).status_code == 422
    empty = tmp_path / "empty"
    ml_quest.save_problem(example_problem("総菜の作る量"), empty)
    response = client.post("/api/problems/start", json={"path": str(empty)})
    assert response.status_code == 422
    assert "データが入っていません" in response.json()["detail"]


def test_check_and_write(client: TestClient, tmp_path: Path) -> None:
    """
    食い違いを試しに書き戻して出し, 選んだ答えとともに書き戻すことを
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
    # 客数を使い, 1 期前の値を使うレシピ
    path = write_problem(tmp_path)
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}/problem"
    recipe = without_drop(client.get(
        f"/api/sources/{source['id']}/recipe"
    ).json())
    for step in recipe["steps"]:
        if step["op"] == "lag":
            step["lags"] = [1]
    checked = client.post(f"{url}/check", json={"recipe": recipe}).json()
    assert [c["column"] for c in checked["choices"]] == ["customers"]
    assert any(
        c["id"] == f"{ml_quest.PART}.available_lag"
        for c in checked["conflicts"]
    )
    assert ml_quest.load_problem(path)["data"].get("recipe") is None

    # 選ばずに書き戻すと誤り. 落とすと選ぶと, 両方のレシピに入る
    assert client.post(
        f"{url}/write", json={"recipe": recipe, "version": current(path)}
    ).status_code == 409
    written = client.post(f"{url}/write", json={
        "recipe": recipe, "choices": {"customers": "drop"},
        "version": current(path),
    }).json()
    assert "customers をレシピで落とした" in written["changes"]
    saved = ml_quest.load_problem(path)
    drop = next(step for step in saved["data"]["recipe"]["steps"]
                if step["op"] == "drop_columns")
    assert drop["columns"] == ["customers"]
    here = client.get(f"/api/sources/{source['id']}/recipe").json()
    assert here == written["recipe"]

    # 分かる列に移すと選ぶと, 問題の設定の列の使い方が変わる
    client.post(f"{url}/write", json={
        "recipe": recipe, "choices": {"customers": "known"},
        "version": current(path),
    })
    saved = ml_quest.load_problem(path)
    assert "customers" in saved["information"]["known"]
    assert "customers" not in (saved["information"].get("unknown") or [])


def test_forbidden_and_unlinked(client: TestClient, tmp_path: Path) -> None:
    """
    使ってはいけない列を使うレシピは書き戻せず, 問題の設定から始めて
    いないデータと消えた問題の設定は理由を返すことを確かめる関数

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
    # 販促の列を使ってはいけない列にする (レシピは落としていない)
    path = write_problem(tmp_path)
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    problem = ml_quest.answer(
        ml_quest.load_problem(path), "information.forbidden", ["promo"]
    )
    ml_quest.save_problem(problem, path)
    url = f"/api/sources/{source['id']}/problem"
    recipe = client.get(f"/api/sources/{source['id']}/recipe").json()
    checked = client.post(f"{url}/check", json={"recipe": recipe}).json()
    assert any(c["level"] == "error" for c in checked["conflicts"])
    response = client.post(f"{url}/write", json={
        "recipe": recipe, "version": current(path)
    })
    assert response.status_code == 409 and "promo" in response.json()[
        "detail"
    ]

    # 問題の設定から始めていないデータと, 消えた問題の設定
    plain = client.post("/api/sources", json={
        "path": str(tmp_path / "sozai.csv")
    }).json()
    assert client.post(f"/api/sources/{plain['id']}/problem/check", json={
        "recipe": recipe
    }).status_code == 404
    (path / "problem.yaml").unlink()
    assert client.post(f"{url}/check", json={
        "recipe": recipe
    }).status_code == 404


def test_review_cases(client: TestClient, tmp_path: Path) -> None:
    """
    置き換わった問題の設定, 拡張子の無いファイル, 確かめた後の変更, 列を
    使う手順の後で落とすこと, 目的の列の変更を確かめる関数

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
    # 客数の過去の値を使い, 客数は落とすと選ぶ (前処理にかけられる)
    path = write_problem(tmp_path)
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}/problem"
    recipe = without_drop(client.get(
        f"/api/sources/{source['id']}/recipe"
    ).json())
    recipe["steps"].append({"op": "lag", "columns": ["customers"],
                            "lags": [2], "by": ["store", "item"]})
    checked = client.post(f"{url}/check", json={"recipe": recipe}).json()
    written = client.post(f"{url}/write", json={
        "recipe": recipe, "choices": {"customers": "drop"},
        "version": checked["version"],
    })
    assert written.status_code == 200
    preview = client.post(f"/api/sources/{source['id']}/preview", json={
        "recipe": written.json()["recipe"],
        "upto": len(written.json()["recipe"]["steps"]),
    })
    assert preview.status_code == 200

    # 確かめた後に変わった問題の設定には書き戻さない
    stale = client.post(f"{url}/write", json={
        "recipe": recipe, "choices": {"customers": "drop"},
        "version": checked["version"],
    })
    assert stale.status_code == 409 and "他で変わりました" in stale.json()[
        "detail"
    ]

    # 目的の列を変えると, 前の目的の列をどう扱うかを選ぶ
    other = dict(written.json()["recipe"], target="customers", steps=[
        {"op": "lag", "columns": ["sales"], "lags": [2],
         "by": ["store", "item"]},
    ])
    checked = client.post(f"{url}/check", json={"recipe": other}).json()
    assert "sales" in [c["column"] for c in checked["choices"]]

    # 拡張子の無いファイルと, 問題の設定でない YAML (レシピ)
    plain = tmp_path / "myproblem"
    plain.write_text((path / "problem.yaml").read_text("utf-8"), "utf-8")
    assert client.post("/api/problems/start", json={
        "path": str(plain)
    }).status_code == 422
    (path / "problem.yaml").write_text(yaml.safe_dump(recipe), "utf-8")
    replaced = client.post(f"{url}/check", json={"recipe": recipe})
    assert replaced.status_code == 422


def test_version1_file(client: TestClient, tmp_path: Path) -> None:
    """
    版 1 の問題の設定から始め, 書き戻すと版 2 で保存することを確かめる
    関数

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
    # 版 1 のファイルも, 読んだ後に版 2 に移して始める
    path = write_problem(tmp_path)
    to_version1(path)
    assert yaml.safe_load(
        (path / "problem.yaml").read_text(encoding="utf-8")
    )["format_version"] == 1
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 201
    source = response.json()["source"]
    assert source["target"] == "sales"
    recipe = client.get(f"/api/sources/{source['id']}/recipe").json()
    assert recipe["split"]["method"] == "time"

    # 食い違いの場所は版 2 の名前. 書き戻すと版 2 のファイルになる
    url = f"/api/sources/{source['id']}/problem"
    changed = without_drop(recipe)
    checked = client.post(f"{url}/check", json={"recipe": changed}).json()
    assert [c["column"] for c in checked["choices"]] == ["customers"]
    written = client.post(f"{url}/write", json={
        "recipe": changed, "choices": {"customers": "drop"},
        "version": current(path),
    })
    assert written.status_code == 200
    raw = yaml.safe_load((path / "problem.yaml").read_text(encoding="utf-8"))
    assert raw["format_version"] == 2
    assert raw["ml"]["parts"][0]["target"]["column"] == "sales"
    saved = ml_quest.load_problem(path)
    assert ml_quest.get_value(saved, "ml.target") == "sales"
    assert saved["data"]["recipe"]["target"] == "sales"


def test_not_column_role(client: TestClient, tmp_path: Path) -> None:
    """
    列の予測でない受け持ちの問題の設定は, 始めるのと書き戻しで理由を
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
    # 列の予測から始めてから, 正解の種類を点群に変える
    path = write_problem(tmp_path)
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    problem = ml_quest.answer(
        ml_quest.load_problem(path), f"{ml_quest.PART}.target.kind",
        "point_cloud"
    )
    ml_quest.save_problem(problem, path)

    # 始めるのも, 確かめと書き戻しも 422 で, 受け持ちと正解の種類を出す
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "predict" in detail and "point_cloud" in detail
    assert "データを追加" in detail
    url = f"/api/sources/{source['id']}/problem"
    recipe = client.get(f"/api/sources/{source['id']}/recipe").json()
    checked = client.post(f"{url}/check", json={"recipe": recipe})
    assert checked.status_code == 422
    assert "point_cloud" in checked.json()["detail"]
    assert client.post(f"{url}/write", json={
        "recipe": recipe, "version": current(path)
    }).status_code == 422

    # 受け持ちが作るでも同じ
    problem = ml_quest.answer(
        ml_quest.load_problem(path), f"{ml_quest.PART}.role", "generate"
    )
    ml_quest.save_problem(problem, path)
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    assert "generate" in response.json()["detail"]


def with_project(path: Path, project: Path, dataset: Path) -> None:
    """
    保存した問題の設定に, ML-Quest のプロジェクトの記録を足す関数

    Parameters
    ----------
    path: Path
        problem.yaml を持つディレクトリ
    project: Path
        プロジェクトのディレクトリ
    dataset: Path
        学習のスクリプトがデータセットを読む場所

    Returns
    ----------
    None
    """
    # make_project が書く欄と同じ名前 (project.path, dataset, model_spec)
    problem = ml_quest.load_problem(path / "problem.yaml")
    problem["project"] = {
        "path": str(project), "dataset": str(dataset),
        "model_spec": str(project / "models" / "model.yaml"),
    }
    ml_quest.save_problem(problem, path)


def test_list_problems(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    ML-Pathfinder の置き場の問題の設定を, 始められるかと理由を付けて
    並べることを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数を変える道具

    Returns
    ----------
    None
    """
    # 置き場が無ければ空
    home = tmp_path / "pathfinder"
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(home))
    listed = client.get("/api/problems").json()
    assert listed["problems"] == [] and listed["error"] is None
    assert listed["root"] == str((home / "problems").resolve())

    # データを入れたもの, 入れていないもの, 問題の設定でないもの
    problems = home / "problems"
    ready = write_problem(tmp_path)
    problems.mkdir(parents=True)
    ready.rename(problems / "ready")
    with_project(
        problems / "ready", tmp_path / "proj", tmp_path / "proj" / "data"
    )
    ml_quest.save_problem(
        example_problem("総菜の作る量"), problems / "empty"
    )
    (problems / "other").mkdir()
    (problems / "other" / "problem.yaml").write_text(
        "format_version: 1\nsteps: []\n", encoding="utf-8"
    )
    (problems / "nofile").mkdir()
    entries = {
        Path(item["path"]).parent.name: item
        for item in client.get("/api/problems").json()["problems"]
    }
    assert set(entries) == {"ready", "empty", "other"}
    assert entries["ready"]["startable"] is True
    assert entries["ready"]["name"] == "総菜の作る量"
    assert entries["ready"]["project"]["dataset"] == str(
        tmp_path / "proj" / "data"
    )
    assert entries["ready"]["updated_at"]
    assert entries["empty"]["startable"] is False
    assert "データが入っていません" in entries["empty"]["reason"]
    assert entries["empty"]["project"] is None
    assert entries["other"]["startable"] is False
    assert "問題の設定のファイルではありません" in entries["other"]["reason"]

    # 一覧の場所からそのまま始められる
    response = client.post(
        "/api/problems/start", json={"path": entries["ready"]["path"]}
    )
    assert response.status_code == 201


def test_export_project(client: TestClient, tmp_path: Path) -> None:
    """
    問題の設定のプロジェクトの書き出し先に書き出し, 置き換えは指定した
    場合だけ, データセットでないものは置き換えないことを確かめる関数

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
    # 記録の無い問題の設定では書き出せない
    path = write_problem(tmp_path)
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    recipe = client.get(f"{url}/recipe").json()
    shown = client.get(f"{url}/project").json()
    assert shown["dataset"] is None and shown["ready"] is False
    assert "project.dataset" in shown["reason"]
    assert client.post(f"{url}/export_project", json={
        "recipe": recipe
    }).status_code == 422

    # プロジェクトの中の, まだ無い親の下に書き出す
    project = tmp_path / "proj"
    project.mkdir()
    dataset = project / "data" / "dataset"
    with_project(path, project, dataset)
    shown = client.get(f"{url}/project").json()
    assert shown == {
        "project": str(project), "dataset": str(dataset),
        "state": "missing", "ready": True, "reason": None,
    }
    exported = client.post(f"{url}/export_project", json={"recipe": recipe})
    assert exported.status_code == 200
    assert (dataset / "dataset.yaml").is_file()
    assert exported.json()["hints"]["outputs"] == 1
    assert client.get(f"{url}/project").json()["state"] == "dataset"

    # 置き換えは指定した場合だけ
    again = client.post(f"{url}/export_project", json={"recipe": recipe})
    assert again.status_code == 409 and "既に" in again.json()["detail"]
    assert client.post(f"{url}/export_project", json={
        "recipe": recipe, "overwrite": True
    }).status_code == 200

    # 一覧にプロジェクトのものとして並び, モデルに要るものを持つ
    listed = [
        item for item in client.get("/api/datasets").json()
        if item["path"] == str(dataset)
    ]
    assert len(listed) == 1 and listed[0]["project"] == source["name"]
    model = listed[0]["model"]
    assert model["task"] == "forecasting" and model["outputs"] == 1
    assert model["inputs"][0]["shape"] == [None, listed[0]["features"]]

    # データセットでないものは置き換えない
    other = project / "data" / "other"
    other.mkdir()
    (other / "keep.txt").write_text("x", encoding="utf-8")
    with_project(path, project, other)
    shown = client.get(f"{url}/project").json()
    assert shown["state"] == "occupied" and shown["ready"] is False
    refused = client.post(f"{url}/export_project", json={
        "recipe": recipe, "overwrite": True
    })
    assert refused.status_code == 409
    assert (other / "keep.txt").is_file()

    # プロジェクトが無いか, プロジェクトの外の親が無ければ書き出さない
    with_project(path, tmp_path / "gone", tmp_path / "gone" / "data")
    assert client.post(f"{url}/export_project", json={
        "recipe": recipe
    }).status_code == 404
    with_project(path, project, tmp_path / "nowhere" / "dataset")
    assert client.post(f"{url}/export_project", json={
        "recipe": recipe
    }).status_code == 404
    assert not (tmp_path / "gone").exists()
    assert not (tmp_path / "nowhere").exists()


def test_write_keeps_project(client: TestClient, tmp_path: Path) -> None:
    """
    問題の設定に書き戻しても, プロジェクトの記録が残ることを確かめる関数

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
    # 記録を足してから始め, そのまま書き戻す
    path = write_problem(tmp_path)
    with_project(path, tmp_path / "proj", tmp_path / "proj" / "data")
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}/problem"
    recipe = client.get(f"/api/sources/{source['id']}/recipe").json()
    checked = client.post(f"{url}/check", json={"recipe": recipe}).json()
    written = client.post(f"{url}/write", json={
        "recipe": recipe, "version": checked["version"]
    })
    assert written.status_code == 200
    saved = yaml.safe_load((path / "problem.yaml").read_text("utf-8"))
    assert saved["project"]["dataset"] == str(tmp_path / "proj" / "data")
