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
    assert any(c["id"] == "ml.available_lag" for c in checked["conflicts"])
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
