from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from ml_fathom.app import create_app
from ml_fathom.items import item_view

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
    hints = exported.json()["hints"]
    assert hints["input_dtype"] == "float32"
    assert hints["outputs"] == (
        len(exported.json()["info"]["classes"])
        if body["recipe"]["task"] == "classification" else 1
    )
    assert hints["input_shape"] == [len(exported.json()["info"]["features"])]
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
    # 数件の前と後 (画像は PNG の data URL, 後の形は (3, 8, 8))
    shown = client.post(
        f"/api/sources/{sid}/item_preview",
        json={"recipe": recipe, "count": 3},
    ).json()
    assert len(shown["items"]) == 3
    assert shown["items"][0]["shape"] == [3, 8, 8]
    assert shown["items"][0]["after"].startswith("data:image/png;base64,")

    # 4 チャンネル (RGBA) の後も PNG にできる. 0 から 1 の値は伸ばさない
    rgba = np.full((4, 5, 6), 0.2, dtype=np.float32)
    assert item_view(rgba, "image", True).startswith("data:image/png")

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


def test_samples(client: TestClient) -> None:
    """
    見本のデータを作って登録し, 2 回目は登録し直さないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント

    Returns
    ----------
    None
    """
    pytest.importorskip("PIL.Image")

    # 5 種類が目的の列付きで登録される
    sources = client.post("/api/samples").json()
    kinds = {item["kind"]: item["target"] for item in sources}
    assert kinds == {
        "table": "churn", "timeseries": "usage_kwh", "image": "label",
        "text": "label", "pointcloud": "label",
    }
    assert client.post("/api/samples").json() == []

    # 文の中身の手順の後は [番号, 語] の並び
    text = next(item for item in sources if item["kind"] == "text")
    shown = client.post(
        f"/api/sources/{text['id']}/item_preview",
        json={"recipe": {
            "target": "label", "task": "classification",
            "item_steps": [{"op": "vocabulary", "length": 5}],
        }, "count": 2},
    ).json()
    pair = shown["items"][0]["after"][0]
    assert isinstance(pair[0], int) and isinstance(pair[1], str)

    # 書き出すと, モデルを組むときの数 (入力の形, 語彙の大きさ, クラス)
    exported = client.post(f"/api/sources/{text['id']}/export", json={
        "recipe": {
            "target": "label", "task": "classification",
            "item_steps": [{"op": "vocabulary", "unit": "char", "length": 8}],
            "split": {"method": "none"},
        },
        "name": "reviews",
    }).json()
    assert exported["hints"]["input_shape"] == [8]
    assert exported["hints"]["input_dtype"] == "int64"
    assert exported["hints"]["vocabulary"] > 2
    assert exported["hints"]["outputs"] == len(
        exported["info"]["classes"]
    )

    # 画像は (チャンネル, 高さ, 幅), 点群は (点の数, 3). 語彙は無い
    for kind, steps, shape in (
        ("image", [{"op": "resize", "width": 8, "height": 6},
                   {"op": "rgb"}], [3, 6, 8]),
        ("pointcloud", [{"op": "sample_points", "points": 16}], [16, 3]),
    ):
        media = next(item for item in sources if item["kind"] == kind)
        hints = client.post(f"/api/sources/{media['id']}/export", json={
            "recipe": {
                "target": "label", "task": "classification",
                # 見本の画像には読めない件があるので除く
                "steps": [
                    {"op": "filter_rows", "column": "width",
                     "compare": "notna"}
                ] if kind == "image" else [],
                "item_steps": steps, "split": {"method": "none"},
            },
            "name": kind,
        }).json()["hints"]
        assert hints["input_shape"] == shape and "vocabulary" not in hints
        assert hints["input_dtype"] == "float32" and hints["outputs"] >= 2

    # 目的の無いデータセットは出力の幅を出さない
    table = next(item for item in sources if item["kind"] == "table")
    hints = client.post(f"/api/sources/{table['id']}/export", json={
        "recipe": {
            "target": None, "task": "none",
            "steps": [{"op": "drop_columns", "columns": ["customer_id"]}],
            "split": {"method": "none"},
        },
        "name": "no_target",
    }).json()["hints"]
    assert hints["outputs"] is None

    # 見本は学習の前に直すことを含む
    table = next(item for item in sources if item["kind"] == "table")
    codes = {
        item["code"]
        for item in client.get(
            f"/api/sources/{table['id']}/profile"
        ).json()["findings"]
    }
    assert {"id_like", "target_leak", "high_missing"} <= codes

    # 利用者が変えた見本は書き直さない
    path = Path(table["path"])
    path.write_text("a,b\n1,2\n", encoding="utf-8")
    client.delete(f"/api/sources/{table['id']}")
    again = client.post("/api/samples").json()
    assert [item["kind"] for item in again] == ["table"]
    assert path.read_text(encoding="utf-8") == "a,b\n1,2\n"


def test_loader_options(client: TestClient, tmp_path: Path) -> None:
    """
    読み込みの設定の誤りは 422 になり, 読み直して目的の列が無くなれば
    外すことを確かめる関数

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
    # 目的の列を決めた表
    file = write_table(tmp_path)
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    client.patch(f"/api/sources/{sid}", json={"target": "label"})

    # 無い文字コードは 422 (設定は変えない)
    bad = client.patch(
        f"/api/sources/{sid}", json={"options": {"encoding": "nope"}}
    )
    assert bad.status_code == 422
    assert client.get("/api/sources").json()[0]["options"] == {}

    # ヘッダーの行を無くすと列の名前が変わり, 目的の列を外す
    changed = client.patch(
        f"/api/sources/{sid}", json={"options": {"header": None}}
    ).json()
    assert changed["target"] is None
