from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

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


def write_table(path: Path) -> Path:
    """
    分析と前処理を試す表を csv で保存する関数

    Parameters
    ----------
    path: Path
        ディレクトリ

    Returns
    ----------
    file: Path
        保存した csv
    """
    # 欠損とカテゴリと 2 クラスの目的の列を持つ表
    rng = np.random.default_rng(0)
    frame = pd.DataFrame({
        "id": range(120),
        "x": rng.normal(0, 1, 120),
        "color": rng.choice(["red", "blue"], 120),
        "label": rng.choice(["a", "b"], 120),
    })
    frame.loc[:10, "x"] = np.nan
    file = path / "table.csv"
    frame.to_csv(file, index=False)

    return file


def test_token_required(tmp_path: Path) -> None:
    """
    トークンの無い API の呼び出しを断ることを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    app = create_app(
        data_dir=tmp_path, token=TOKEN, allowed_hosts=["testserver"]
    )
    assert TestClient(app).get("/api/sources").status_code == 401


def test_source_profile_and_rows(client: TestClient, tmp_path: Path) -> None:
    """
    データを登録し, 分析と表の中身と目的の列の指定ができることを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 場所の候補と登録
    file = write_table(tmp_path)
    assert client.post("/api/detect", json={"path": str(file)}).json()[0][
        "loader"
    ] == "csv"
    created = client.post("/api/sources", json={"path": str(file)})
    assert created.status_code == 201
    source = created.json()
    assert source["kind"] == "table" and source["exists"]

    # 分析と気付き
    sid = source["id"]
    result = client.get(f"/api/sources/{sid}/profile").json()
    assert result["columns"]["id"]["type"] == "id"
    assert result["target"] is None

    # 目的の列を決めると目的の列との関係が出る. 無い列は断る
    assert client.patch(
        f"/api/sources/{sid}", json={"target": "nope"}
    ).status_code == 422
    client.patch(f"/api/sources/{sid}", json={"target": "label"})
    result = client.get(f"/api/sources/{sid}/profile").json()
    assert result["target"]["task"] == "classification"

    # 表の中身の絞り込みと並べ替え
    rows = client.get(
        f"/api/sources/{sid}/rows",
        params={"sort": "x", "descending": True, "limit": 5}
    ).json()
    assert rows["total"] == 120 and len(rows["rows"]) == 5
    filtered = client.get(
        f"/api/sources/{sid}/rows", params={"query": "red"}
    ).json()
    assert 0 < filtered["total"] < 120

    # ディレクトリの中身
    listing = client.get("/api/browse", params={"path": str(tmp_path)}).json()
    assert "table.csv" in [entry["name"] for entry in listing["entries"]]


def test_recipe_preview_and_export(
    client: TestClient, tmp_path: Path
) -> None:
    """
    レシピの保存, 前と後の様子, 書き出しを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 登録して空のレシピを受け取る
    file = write_table(tmp_path)
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    recipe = client.get(f"/api/sources/{sid}/recipe").json()
    assert recipe["steps"] == []

    # 手順を足して保存
    recipe.update({
        "target": "label", "task": "classification",
        "steps": [
            {"op": "drop_columns", "columns": ["id"]},
            {"op": "impute", "columns": ["x"], "strategy": "median"},
            {"op": "one_hot", "columns": "auto"},
        ],
        "split": {"method": "stratified", "valid": 0.25, "test": 0.0},
    })
    assert client.put(
        f"/api/sources/{sid}/recipe", json={"recipe": recipe}
    ).status_code == 200
    bad = {**recipe, "steps": [{"op": "magic"}]}
    assert client.put(
        f"/api/sources/{sid}/recipe", json={"recipe": bad}
    ).status_code == 422

    # 最後の手順までの様子に, 学習に使う列と分割の件数が付く
    view = client.post(
        f"/api/sources/{sid}/preview", json={"recipe": recipe, "upto": 3}
    ).json()
    assert "color=red" in view["added"]
    assert view["splits"] == {"train": 90, "valid": 30}
    assert view["classes"] == ["a", "b"]

    # 書き出しと一覧. 同じ名前は置き換えの指定が無ければ 409
    body = {"recipe": recipe, "name": "demo"}
    exported = client.post(f"/api/sources/{sid}/export", json=body)
    assert exported.status_code == 200
    assert Path(exported.json()["path"], "dataset.yaml").is_file()
    assert client.post(
        f"/api/sources/{sid}/export", json=body
    ).status_code == 409
    assert client.post(
        f"/api/sources/{sid}/export", json={**body, "name": "../x"}
    ).status_code == 422
    datasets = client.get("/api/datasets").json()
    assert datasets[0]["name"] == "demo"

    # 登録を外すと一覧から消える
    assert client.delete(f"/api/sources/{sid}").status_code == 204
    assert client.get("/api/sources").json() == []


def test_images(client: TestClient, tmp_path: Path) -> None:
    """
    画像のフォルダの登録, 中身の PNG, 中身の手順の様子と書き出しを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    image = pytest.importorskip("PIL.Image")

    # 2 クラスの画像を, 大きさを混ぜて保存
    rng = np.random.default_rng(0)
    for label in ("cat", "dog"):
        (tmp_path / "pets" / label).mkdir(parents=True)
        for index in range(6):
            size = 10 if index == 0 else 8
            pixels = rng.integers(0, 255, (size, size, 3), dtype=np.uint8)
            image.fromarray(pixels).save(
                tmp_path / "pets" / label / f"{index}.png"
            )

    # 登録すると label が目的の列になり, 中身の手順の一覧も返る
    source = client.post(
        "/api/sources", json={"path": str(tmp_path / "pets")}
    ).json()
    sid = source["id"]
    assert source["kind"] == "image" and source["target"] == "label"
    info = client.get("/api/info").json()
    assert "resize" in {item["op"] for item in info["item_steps"]}

    # 中身は PNG, 範囲の外は 404
    item = client.get(f"/api/sources/{sid}/items/0")
    assert item.headers["content-type"] == "image/png"
    assert client.get(f"/api/sources/{sid}/items/99").status_code == 404
    import io

    small = client.get(f"/api/sources/{sid}/items/0", params={"size": 16})
    assert max(image.open(io.BytesIO(small.content)).size) <= 16

    # 中身の手順が無ければ注意, あれば分割の件数とクラス
    recipe = {
        "target": "label", "task": "classification",
        "split": {"method": "stratified", "valid": 0.25},
    }
    view = client.post(
        f"/api/sources/{sid}/preview", json={"recipe": recipe, "upto": 0}
    ).json()
    assert view["notes"] and view["classes"] == ["cat", "dog"]
    recipe["item_steps"] = [
        {"op": "resize", "width": 8, "height": 8}, {"op": "normalize"}
    ]
    view = client.post(
        f"/api/sources/{sid}/preview", json={"recipe": recipe, "upto": 0}
    ).json()
    assert view["notes"] == [] and sum(view["splits"].values()) == 12
    wrong = {**recipe, "item_steps": [{"op": "sample_points", "points": 8}]}
    assert client.post(
        f"/api/sources/{sid}/preview", json={"recipe": wrong, "upto": 0}
    ).status_code == 422

    # 書き出すと (件数, 3, 8, 8) の配列
    exported = client.post(
        f"/api/sources/{sid}/export", json={"recipe": recipe, "name": "pets"}
    ).json()
    assert exported["info"]["splits"]["train"]["shape"][1:] == [3, 8, 8]


def test_points_response() -> None:
    """
    有限でない点を除き, 0 から 1 の色を 0 から 255 にすることを確かめる
    関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    import json

    from ml_fathom.items import points_response

    points = np.array([[0, 0, 0], [np.nan, 0, 0], [1, 1, np.inf], [1, 2, 3]])
    colors = np.array([[1.0, 0.5, 0], [0, 0, 0], [0, 0, 0], [0, 1.0, 0]])
    body = json.loads(
        points_response({"points": points, "colors": colors}).body
    )
    assert body["count"] == 4 and len(body["points"]) == 6
    assert body["colors"] == [255, 127, 0, 0, 255, 0]
