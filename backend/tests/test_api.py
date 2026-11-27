from pathlib import Path

import ml_quest
import numpy as np
import pandas as pd
import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ml_fathom.app import cookie_name, create_api, create_app
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


def test_standalone_checks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    単独の起動のアプリが確かめ, /api/auth, 画面の配信を持つことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        画面の置き場の差し替え

    Returns
    ----------
    None
    """
    # ビルド済みの画面の代わり
    static_dir = (tmp_path / "static").resolve()
    (static_dir / "assets").mkdir(parents=True)
    (static_dir / "index.html").write_text("画面", encoding="utf-8")
    (static_dir / "assets" / "a.js").write_text("1", encoding="utf-8")
    monkeypatch.setattr("ml_fathom.app.STATIC_DIR", static_dir)
    standalone = create_app(data_dir=tmp_path / "home", token=TOKEN,
                            allowed_hosts=["testserver"])
    client = TestClient(standalone)

    # 違うトークンは 401, 合うトークンは Cookie を置いて画面へ
    assert client.get("/api/auth?token=x").status_code == 401
    # GET でない /api/auth もトークンの確かめの対象
    assert client.post("/api/auth?token=x").status_code == 401
    assert client.get("/api/sources").status_code == 401
    moved = client.get(f"/api/auth?token={TOKEN}", follow_redirects=False)
    assert moved.status_code == 303 and moved.headers["location"] == "/"
    assert cookie_name(TOKEN) in moved.cookies
    assert client.get("/api/sources").json() == []

    # 別の Origin の書き込みは 403, 同じ Origin は受け付ける
    file = write_table(tmp_path)
    foreign = client.post("/api/sources", json={"path": str(file)},
                          headers={"origin": "http://evil.example"})
    assert foreign.status_code == 403
    same = client.post("/api/sources", json={"path": str(file)},
                       headers={"origin": "http://testserver"})
    assert same.status_code == 201
    assert (tmp_path / "home" / "sources.json").is_file()

    # 別のホスト名は断る
    other = client.get("/api/sources", headers={"host": "evil.example"})
    assert other.status_code == 400

    # 画面の配信と, 無い API と仕様の画面の 404 (根の仕様の画面も出さず,
    # 画面の中の移動先として index.html)
    assert client.get("/").text == "画面"
    assert client.get(f"/sources/{same.json()['id']}").text == "画面"
    assert client.get("/assets/a.js").text == "1"
    for path in ["/api", "/api/nothing", "/api/openapi.json", "/api/docs"]:
        assert client.get(path).status_code == 404, path
    for path in ["/docs", "/openapi.json"]:
        assert client.get(path).text == "画面", path

    # HEAD も GET と同じく受け付け, 本体は返さない
    for path in ["/", "/sources/x", "/assets/a.js"]:
        head = client.head(path)
        assert head.status_code == 200 and head.content == b"", path

    # NUL の字や長すぎる名前のように調べられない経路も index.html
    for path in ["/a%00b", "/" + "a" * 300, "/a/" + "b" * 300 + "/c"]:
        assert client.get(path).text == "画面", path


def test_empty_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str]
) -> None:
    """
    空のトークンを渡した場合にランダムに作り, 開き方を表示することを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数の差し替え
    capsys: pytest.CaptureFixture[str]
        表示の取り込み

    Returns
    ----------
    None
    """
    monkeypatch.delenv("ML_FATHOM_TOKEN", raising=False)
    standalone = create_app(data_dir=tmp_path, token="",
                            allowed_hosts=["testserver"])
    token = standalone.state.token
    assert token
    assert f"/api/auth?token={token}" in capsys.readouterr().out

    # 空のトークンでは呼べず, 作ったトークンで呼べる
    client = TestClient(standalone)
    assert client.get("/api/sources",
                      headers={"x-fathom-token": ""}).status_code == 401
    assert client.get("/api/sources",
                      headers={"x-fathom-token": token}).json() == []


def test_create_api_mounted(tmp_path: Path) -> None:
    """
    API だけのアプリを別の頭の下に mount して, データの登録, 分析,
    レシピ, 書き出し, 問題の設定の一覧が動き, 確かめを持たないことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 渡した問題の設定の置き場に 1 つ置く (環境変数の置き場とは別)
    problems_dir = tmp_path / "shared" / "problems"
    problem = ml_quest.example_problem("解約の引き止め")
    problem["name"] = "試し"
    place = problems_dir / "churn" / "problem.yaml"
    place.parent.mkdir(parents=True)
    place.write_text(yaml.safe_dump(problem, allow_unicode=True), "utf-8")

    # 殻の代わりのアプリ (確かめは殻が持つので, ここでは付けない)
    shell = FastAPI()
    shell.mount("/api/data",
                create_api(tmp_path / "home", problems_dir=problems_dir))
    client = TestClient(shell)

    # トークン無しで, 別の Origin からも登録できる (確かめは殻の役目)
    file = write_table(tmp_path)
    created = client.post("/api/data/sources", json={"path": str(file)},
                          headers={"origin": "http://other.example"})
    assert created.status_code == 201, created.text
    sid = created.json()["id"]
    assert (tmp_path / "home" / "sources.json").is_file()

    # 分析, レシピの保存, 書き出し, データセットの一覧
    url = f"/api/data/sources/{sid}"
    assert client.get(f"{url}/profile").json()["columns"]["id"][
        "type"
    ] == "id"
    recipe = client.get(f"{url}/recipe").json()
    recipe.update({
        "target": "label", "task": "classification",
        "steps": [{"op": "drop_columns", "columns": ["id"]}],
        "split": {"method": "stratified", "valid": 0.25, "test": 0.0},
    })
    saved = client.put(f"{url}/recipe", json={"recipe": recipe})
    assert saved.status_code == 200
    exported = client.post(f"{url}/export",
                           json={"recipe": recipe, "name": "demo"})
    assert exported.status_code == 200, exported.text
    assert (tmp_path / "home" / "datasets" / "demo" / "dataset.yaml").is_file()
    names = [item["name"] for item in client.get("/api/data/datasets").json()]
    assert names == ["demo"]

    # 問題の設定の一覧は渡した置き場から
    listed = client.get("/api/data/problems").json()
    assert listed["root"] == str(problems_dir)
    assert [item["name"] for item in listed["problems"]] == ["試し"]

    # /auth も仕様の画面も持たない
    for path in ["/auth", "/openapi.json", "/docs", "/redoc"]:
        assert client.get(f"/api/data{path}").status_code == 404, path

    # problems_dir を渡さなければ ML_PATHFINDER_HOME の下の problems
    default = TestClient(create_api(tmp_path / "home"))
    expected = tmp_path / "pathfinder" / "problems"
    assert default.get("/problems").json()["root"] == str(expected)


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


def test_rows_with_nullable_values(
    client: TestClient, tmp_path: Path
) -> None:
    """
    欠損を持てる真偽と整数, 無限大の列を持つ表の中身を返し, 欠損と
    無限大を None にすることを確かめる関数

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
    # 欠損を持てる型は parquet で保つ
    file = tmp_path / "nullable.parquet"
    pd.DataFrame({
        "flag": pd.array([True, None, False], dtype="boolean"),
        "count": pd.array([1, None, 3], dtype="Int64"),
        "v": [1.5, np.inf, np.nan],
    }).to_parquet(file)
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    response = client.get(f"/api/sources/{sid}/rows")
    assert response.status_code == 200
    assert response.json()["rows"] == [
        [True, 1, 1.5], [None, None, None], [False, 3, None]
    ]


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
    assert view["findings"] == []

    # グループの列を選ぶと, 層化でも分割をまたぐ同じ値を気付きにする
    grouped = {**recipe, "split": {**recipe["split"], "column": "color"}}
    view = client.post(
        f"/api/sources/{sid}/preview", json={"recipe": grouped, "upto": 3}
    ).json()
    overlap = view["findings"][0]
    assert overlap["code"] == "group_overlap"
    assert overlap["severity"] == "warning"
    assert overlap["columns"] == ["color"]
    assert overlap["message"] in view["notes"]

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


def test_unlabeled_split(client: TestClient, tmp_path: Path) -> None:
    """
    正解の欠けた行を unlabeled の分割に残すレシピの保存と書き出しを確かめる関数

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
    # 目的の列の 20 行が欠けた表
    file = write_table(tmp_path)
    frame = pd.read_csv(file)
    frame.loc[100:, "label"] = np.nan
    frame.to_csv(file, index=False)
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    recipe = {
        "format_version": 1, "target": "label", "task": "classification",
        "steps": [
            {"op": "drop_columns", "columns": ["id"]},
            {"op": "impute", "columns": ["x"], "strategy": "median"},
            {"op": "one_hot", "columns": "auto"},
        ],
        "split": {
            "method": "random", "valid": 0.25, "test": 0.0, "seed": 0,
            "unlabeled": "keep",
        },
    }

    # 保存して読み直すと keep のまま. 知らない値は 422
    url = f"/api/sources/{sid}/recipe"
    assert client.put(url, json={"recipe": recipe}).status_code == 200
    assert client.get(url).json()["split"]["unlabeled"] == "keep"
    bad = {**recipe, "split": {**recipe["split"], "unlabeled": "yes"}}
    assert client.put(url, json={"recipe": bad}).status_code == 422

    # 正解の付いた分割は落とす場合と同じで, 欠けた行は unlabeled に
    view = client.post(
        f"/api/sources/{sid}/preview", json={"recipe": recipe, "upto": 3}
    ).json()
    assert view["splits"] == {"train": 75, "valid": 25, "unlabeled": 20}
    dropped = {**recipe, "split": {**recipe["split"], "unlabeled": "drop"}}
    view = client.post(
        f"/api/sources/{sid}/preview", json={"recipe": dropped, "upto": 3}
    ).json()
    assert view["splits"] == {"train": 75, "valid": 25}

    # 目的の列の無い keep は誤り
    untargeted = {**recipe, "target": None, "task": "none"}
    assert client.post(
        f"/api/sources/{sid}/preview", json={"recipe": untargeted, "upto": 3}
    ).status_code == 422

    # 書き出しと一覧にも unlabeled の分割が並ぶ
    exported = client.post(
        f"/api/sources/{sid}/export", json={"recipe": recipe, "name": "semi"}
    )
    assert exported.status_code == 200
    assert exported.json()["hints"]["outputs"] == 2
    datasets = client.get("/api/datasets").json()
    assert datasets[0]["splits"] == {"train": 75, "valid": 25, "unlabeled": 20}


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

    # 上限を超えた画像の辺は, 見本と書き出しの前に 422
    wrong = {**recipe, "item_steps": [
        {"op": "resize", "width": 4097, "height": 8}
    ]}
    assert client.post(
        f"/api/sources/{sid}/item_preview",
        json={"recipe": wrong, "count": 3},
    ).status_code == 422
    assert client.post(
        f"/api/sources/{sid}/export", json={"recipe": wrong, "name": "big"}
    ).status_code == 422


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
