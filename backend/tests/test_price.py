from pathlib import Path
from typing import Any

import ml_eda
import ml_quest
import numpy as np
import pandas as pd
import pytest
import yaml
from fastapi.testclient import TestClient

from ml_fathom import problems
from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"

# 受け持ちの場所
PART = ml_quest.PART

# 合成の値段を変えた記録の表の行の数
ROWS = 240

# 合成の表の列
COLUMNS = ["record_id", "product_id", "category", "weekday", "price",
           "units", "unit_cost", "leftover"]


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


def write_sales(root: Path) -> Path:
    """
    試しに値段を変えた, 合成の売れ行きの記録の表の CSV を作る関数

    Parameters
    ----------
    root: Path
        書き出す場所

    Returns
    ----------
    path: Path
        CSV のファイル (record_id, product_id, category, weekday, price,
        units, unit_cost, leftover. 商品 p9 は試した値段が 1 つ. leftover
        は売れた後に決まる列)
    """
    # 決まった乱数. 商品ごとの元の値段を無作為に 0.8 から 1.2 倍に変え,
    # 値段を上げると売れた数が減る
    rng = np.random.default_rng(0)
    product = rng.integers(0, 10, ROWS)
    base = 100 + 20 * product
    scale = rng.choice([0.8, 0.9, 1.0, 1.1, 1.2], ROWS)
    scale = np.where(product == 9, 1.0, scale)
    price = (base * scale).round(0)
    units = rng.poisson(20 * scale ** -1.5)
    frame = pd.DataFrame({
        "record_id": [f"r{index:03d}" for index in range(ROWS)],
        "product_id": [f"p{index}" for index in product],
        "category": np.where(product < 5, "food", "tool"),
        "weekday": rng.integers(0, 7, ROWS),
        "price": price, "units": units,
        "unit_cost": (base * 0.6).round(0),
        "leftover": 30 - units,
    })
    root.mkdir(parents=True, exist_ok=True)
    path = root / "sales.csv"
    frame.to_csv(path, index=False)

    return path


def price_recipe() -> dict[str, Any]:
    """
    ML-EDA の値段を変えた記録の表のレシピを作る関数

    Returns
    ----------
    recipe: dict[str, Any]
        売れた数, 値段, 原価, 商品の id, 行の id の列, 予測に使わない列を
        落とす手順, 標準化と層化の分割のレシピ (ML-Quest の雛形と同じ形)
    """
    # ML-Quest の recipe_from の雛形と同じ形
    recipe: dict[str, Any] = {
        "format_version": 1, "task": "price", "target": "units",
        "price": "price", "cost": "unit_cost", "product": "product_id",
        "id": "record_id",
        "steps": [{"op": "drop_columns", "columns": ["leftover"]},
                  {"op": "one_hot", "columns": ["category"]},
                  {"op": "standardize", "columns": "auto"}],
        "split": {"method": "stratified", "valid": 0.2, "test": 0.2,
                  "seed": 0, "unlabeled": "drop"},
    }

    return recipe


def price_part(problem: dict[str, Any]) -> dict[str, Any]:
    """
    問題の設定の受け持ちを値段を変える判断にする関数

    ML-Quest の答えの確かめを通さずに受け持ちの答えを書く (値段を変える判断
    の問いに答えずに, この画面の見分けと止まり方を確かめるため)

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2)

    Returns
    ----------
    problem: dict[str, Any]
        受け持ちが効果を見積もるで, 方策でなく今ある記録で値段を変えた問題
        の設定
    """
    # 版 2 の受け持ちの答え
    problem["ml"]["parts"] = [{
        "role": "effect", "unit": "row", "output": "effect",
        "method": "scratch", "autonomous": False, "collect": "log",
        "varied": "price",
    }]

    return problem


def test_describe(client: TestClient, tmp_path: Path) -> None:
    """
    値段を変えた記録の要約が, 値段の幅と数, 弾力性, 商品ごとの試した値段と
    気付きを返し, 誤りは理由を付けて 422 で返すことを確かめる関数

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
    # 商品の数, 試した値段が 1 つの商品の気付きと, 値段を上げると減る関わり
    file = write_sales(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    url = f"/api/sources/{sid}/price"
    response = client.post(url, json={
        "price": "price", "units": "units", "cost": "unit_cost",
        "product": "product_id", "id": "record_id",
    })
    assert response.status_code == 200
    summary = response.json()
    assert summary["rows"] == ROWS
    assert summary["price_stats"]["distinct"] >= 3
    assert summary["products"]["count"] == 10
    assert summary["products"]["single_price"] == 1
    assert summary["relation"]["elasticity"] < 0
    assert summary["cost_stats"]["rows"] == ROWS
    codes = [item["code"] for item in summary["findings"]]
    assert "single_price_products" in codes
    assert "record_id" not in [item["column"]
                               for item in summary["confounding"]]

    # 原価と商品の id を省くと, その要約は None
    plain = client.post(url, json={"price": "price", "units": "units"})
    assert plain.status_code == 200
    assert plain.json()["products"] is None
    assert plain.json()["cost_stats"] is None

    # 無い列, 重なる列と知らない欄は 422
    missing = client.post(url, json={"price": "nothing", "units": "units"})
    assert missing.status_code == 422
    assert "nothing" in missing.json()["detail"]
    assert client.post(url, json={
        "price": "price", "units": "price"
    }).status_code == 422
    assert client.post(url, json={
        "price": "price", "units": "units", "extra": 1
    }).status_code == 422


def test_describe_not_table(client: TestClient, tmp_path: Path) -> None:
    """
    表でないデータの値段を変えた記録の要約は, 理由を付けて 422 で返すこと
    を確かめる関数

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
    # 文のディレクトリ (クラスのフォルダ)
    root = tmp_path / "texts"
    for label in ("a", "b"):
        (root / label).mkdir(parents=True)
        for index in range(3):
            (root / label / f"{index}.txt").write_text(f"{label} {index}")
    sid = client.post("/api/sources", json={"path": str(root)}).json()["id"]
    response = client.post(f"/api/sources/{sid}/price", json={
        "price": "label", "units": "label"
    })
    assert response.status_code == 422
    assert "表と時系列だけ" in response.json()["detail"]


def test_preview_and_export(client: TestClient, tmp_path: Path) -> None:
    """
    値段を変える判断のレシピの前処理の様子と書き出しの結果, データセットの
    一覧が, 分割ごとの値段の範囲と売れた数の平均を返すことを確かめる関数

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
    # 値段の列は学習に使う列の最後で, 原価, 商品の id, 行の id は使わない
    file = write_sales(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    url = f"/api/sources/{sid}"
    recipe = price_recipe()
    previewed = client.post(f"{url}/preview", json={"recipe": recipe,
                                                    "upto": 3})
    assert previewed.status_code == 200
    body = previewed.json()
    price = body["price"]
    assert price["price"] == "price" and price["raw"] == "price_raw"
    assert price["cost"] == "unit_cost" and price["product"] == "product_id"
    assert price["id"] == "record_id"
    assert price["steps"] == ["standardize"]
    assert set(price["splits"]) == {"train", "valid", "test"}
    assert sum(split["rows"] for split in price["splits"].values()) == ROWS
    assert body["features"][-1] == "price"
    for name in ("unit_cost", "product_id", "record_id", "units"):
        assert name not in body["features"]
    assert body["uplift"] is None and body["anomaly"] is None

    # 書き出しの説明にも同じ数があり, 一覧も説明の price を返す
    exported = client.post(f"{url}/export", json={
        "recipe": recipe, "name": "sales"
    })
    assert exported.status_code == 200
    assert exported.json()["info"]["price"] == price
    assert exported.json()["hints"]["outputs"] == 1
    listed = client.get("/api/datasets").json()
    assert [item["price"] for item in listed] == [price]
    assert listed[0]["task"] == "price"
    assert listed[0]["uplift"] is None


@pytest.mark.parametrize("change", ["split", "drop_price", "impute_price"])
def test_preview_refused(
    client: TestClient, tmp_path: Path, change: str
) -> None:
    """
    値段を変える判断の層化でない分割と, 値段の手順でない手順で値段の列を
    変えるレシピは ML-EDA の誤りになることを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    change: str
        崩すところ (分割, 値段の列を落とす, 値段の列を埋める)

    Returns
    ----------
    None
    """
    # どれも 422
    file = write_sales(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    wrong = price_recipe()
    if change == "split":
        wrong["split"]["method"] = "random"
    elif change == "drop_price":
        wrong["steps"].append({"op": "drop_columns", "columns": ["price"]})
    else:
        wrong["steps"].append({"op": "impute", "columns": ["price"]})
    response = client.post(f"/api/sources/{sid}/preview", json={
        "recipe": wrong, "upto": len(wrong["steps"])
    })
    assert response.status_code == 422


def test_preview_other_task(client: TestClient, tmp_path: Path) -> None:
    """
    他のタスクに値段の列を書くと ML-EDA の誤りになり, 書かなければ price
    が None であることを確かめる関数

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
    # 回帰に値段の列を書くと 422
    file = write_sales(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    url = f"/api/sources/{sid}"
    plain = {"format_version": 1, "task": "regression", "target": "units",
             "steps": [], "split": {"method": "random", "valid": 0.2,
                                    "test": 0.1}}
    assert client.post(f"{url}/preview", json={
        "recipe": {**plain, "price": "price"}, "upto": 0
    }).status_code == 422
    body = client.post(f"{url}/preview", json={"recipe": plain,
                                               "upto": 0}).json()
    assert body["price"] is None


def test_is_price() -> None:
    """
    値段を変える判断と効果の見積もりの受け持ちの見分けを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 記録で変えたものが値段なら値段を変える判断で, 効果の見積もりではない
    problem = price_part(ml_quest.example_problem("解約の引き止め"))
    assert problems.is_price(problem)
    assert not problems.is_uplift(problem)
    treat = price_part(ml_quest.example_problem("解約の引き止め"))
    treat["ml"]["parts"][0]["varied"] = "treat"
    assert problems.is_uplift(treat) and not problems.is_price(treat)
    for key, value in (("autonomous", True), ("collect", "online"),
                       ("method", "pretrained")):
        other = price_part(ml_quest.example_problem("解約の引き止め"))
        other["ml"]["parts"][0][key] = value
        assert not problems.is_price(other)


def start_with(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    data: Path, recipe: dict[str, Any]
) -> Any:
    """
    ML-Quest の受け渡しの値段を変える判断のレシピの雛形で, 問題の設定から
    始める関数

    ML-Quest が作らない形のレシピ (表に無い列, 表でないデータなど) でも
    始める流れを確かめるため, 受け渡しの形 (recipe_from のレシピと load)
    のまま recipe_from を差し替え, 組の ML-Quest が値段を変える判断を受ける
    ことにする

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        recipe_from と price_supported の差し替え
    data: Path
        入れたデータ
    recipe: dict[str, Any]
        recipe_from が返すレシピ

    Returns
    ----------
    response: Any
        POST /api/problems/start の応答
    """
    # 名前と作った時刻を持つ問題の設定
    problem = price_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="値段の見直し", created_at="2000-01-01T00:00:00")
    path = tmp_path / "problem" / "problem.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump(problem, allow_unicode=True), "utf-8")
    monkeypatch.setattr(problems, "price_supported", lambda: True)
    monkeypatch.setattr(ml_quest, "recipe_from", lambda _: {
        "load": {"path": str(data), "loader": None, "options": {}},
        "recipe": recipe, "notes": ["骨組みは数の列だけを読みます"],
    })
    response = client.post("/api/problems/start", json={"path": str(path)})

    return response


def test_start_handoff(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    値段を変える判断の受け渡しのレシピで始めると, 売れた数の列を目的の列に
    して登録し, レシピを保存することを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        差し替え

    Returns
    ----------
    None
    """
    # 売れた数の列が目的の列, レシピは受け渡しのまま
    recipe = price_recipe()
    started = start_with(client, tmp_path, monkeypatch,
                         write_sales(tmp_path / "raw"), recipe)
    assert started.status_code == 201
    body = started.json()
    assert body["form"] is None and body["tab"] is None
    assert body["source"]["target"] == "units"
    assert body["source"]["kind"] == "table"
    saved = client.get(f"/api/sources/{body['source']['id']}/recipe").json()
    assert saved["task"] == "price" and saved["price"] == "price"
    assert saved["cost"] == "unit_cost" and saved["product"] == "product_id"
    assert saved["id"] == "record_id"
    assert saved["split"]["method"] == "stratified"


@pytest.mark.parametrize("key", ["target", "price", "cost", "product", "id"])
def test_start_missing_column(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    key: str
) -> None:
    """
    答えた売れた数, 値段, 原価, 商品の id か行の id の列が表に無ければ,
    登録せずに理由を返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        差し替え
    key: str
        無い列にするレシピの鍵

    Returns
    ----------
    None
    """
    # 列の名前を挙げた 422
    recipe = {**price_recipe(), key: "missing_column"}
    started = start_with(client, tmp_path, monkeypatch,
                         write_sales(tmp_path / "raw"), recipe)
    assert started.status_code == 422
    assert "missing_column" in started.json()["detail"]
    assert client.get("/api/sources").json() == []


def test_start_not_table(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    表でないデータを入れた値段を変える判断の問題の設定は, 登録せずに理由を
    返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        差し替え

    Returns
    ----------
    None
    """
    # 文のディレクトリ (クラスのフォルダ)
    root = tmp_path / "texts"
    for label in ("a", "b"):
        (root / label).mkdir(parents=True)
        for index in range(3):
            (root / label / f"{index}.txt").write_text(f"{label} {index}")
    recipe = {"format_version": 1, "task": "price", "target": "label",
              "price": "price", "steps": [],
              "split": {"method": "stratified", "valid": 0.2, "test": 0.2}}
    started = start_with(client, tmp_path, monkeypatch, root, recipe)
    assert started.status_code == 422
    assert "表ではありません" in started.json()["detail"]
    assert client.get("/api/sources").json() == []


def save_problem(tmp_path: Path, problem: dict[str, Any]) -> Path:
    """
    問題の設定を ML-Pathfinder の置き場に書く関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    problem: dict[str, Any]
        問題の設定

    Returns
    ----------
    path: Path
        problem.yaml
    """
    # ML-Quest の答えの確かめを通さずに書く
    path = tmp_path / "pathfinder" / "problems" / "sales" / "problem.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump(problem, allow_unicode=True), "utf-8")

    return path


def test_start_old_quest(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    組の ML-Quest が値段を変える判断を受けない版なら, 値段を変える判断の
    問題の設定は効果の見積もりと取り違えずに理由を付けて 422 で止まり,
    一覧でも始められないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        置き場の環境変数と price_supported の差し替え

    Returns
    ----------
    None
    """
    # 表を入れた値段を変える判断の問題の設定と, 受けない版の ML-Quest
    data = write_sales(tmp_path / "raw")
    problem = price_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="値段の見直し", created_at="2000-01-01T00:00:00")
    problem["data"] = {"source": str(data), "loader": "csv", "options": {}}
    path = save_problem(tmp_path, problem)
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))
    monkeypatch.setattr(problems, "price_supported", lambda: False)

    # 始めると 422 で版の理由があり, データは登録しない
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 422
    detail = started.json()["detail"]
    assert "問題を渡せません" in detail
    assert "値段を変える判断を受けない版" in detail
    assert client.get("/api/sources").json() == []

    # 一覧でも始められず, 同じ理由がある
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [False]
    assert listed[0]["reason"] == detail


def test_start_refused(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    値段を変える判断の問いに答えていない問題の設定は, ML-Quest の理由を
    付けて 422 で止まり, 一覧でも始められないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        置き場の環境変数の差し替え

    Returns
    ----------
    None
    """
    # 表を入れ, 値段の列の問いに答えていない問題の設定
    data = write_sales(tmp_path / "raw")
    problem = price_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="値段の見直し", created_at="2000-01-01T00:00:00")
    problem["data"] = {"source": str(data), "loader": "csv", "options": {}}
    path = save_problem(tmp_path, problem)
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))

    # 始めると 422 で ML-Quest の理由があり, データは登録しない
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 422
    detail = started.json()["detail"]
    assert "問題を渡せません" in detail
    assert client.get("/api/sources").json() == []
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [False]
    assert listed[0]["reason"] == detail


def quest_problem(tmp_path: Path, data: Path) -> tuple[Path, Path]:
    """
    ML-Quest で値段を変える判断の問題の設定を作り, データを入れてプロジェクト
    の記録を付けて, ML-Pathfinder の置き場に保存する関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    data: Path
        入れる表

    Returns
    ----------
    paths: tuple[Path, Path]
        problem.yaml を持つディレクトリと, プロジェクトのディレクトリ
    """
    # 1 から 4 と 9, 10 は見本のまま, 受け持ちは作り直し
    problem = ml_quest.example_problem("解約の引き止め")
    problem["ml"]["parts"] = [{}]
    for key in ("decision", "basis", "current"):
        problem["action"].pop(key, None)
    problem = ml_quest.answer(problem, "information.columns", COLUMNS)
    for key, value in [
        ("role", "effect"), ("unit", "row"), ("output", "effect"),
        ("target.source", "intervention"), ("method", "scratch"),
        ("autonomous", False), ("collect", "log"), ("varied", "price"),
        ("what", "値段を変えたときの売れた数"),
        ("item", "商品と日ごとの 1 行"), ("baseline", "今の値段のまま"),
        ("price.price", "price"), ("price.units", "units"),
        ("price.cost", "unit_cost"), ("price.product", "product_id"),
        ("price.id", "record_id"),
        ("price.columns", ["category", "weekday"]),
        ("evaluation.metric", "mae"),
        ("evaluation.link", "売れた数の外れが小さいほど選ぶ値段の利益の"
         "見込みが当たる"),
    ]:
        problem = ml_quest.answer(problem, f"{PART}.{key}", value)
    problem = ml_quest.answer(problem, "action.decision", {
        "type": "price", "candidates": [-0.1, 0, 0.1], "max_change": 0.1
    })
    problem = ml_quest.attach_data(problem, str(data))
    # 値段を変える判断の骨組みを書き出せない ML-Quest のための, 骨組みの
    # config と同じ場所 (data.dataset) の記録
    project = tmp_path / "project"
    config = project / "configs" / "default" / "train.yaml"
    config.parent.mkdir(parents=True)
    config.write_text(yaml.safe_dump({"data": {
        "dataset": str(project / "data" / "dataset")
    }}), "utf-8")
    problem = ml_quest.record_project(problem, project)
    path = tmp_path / "pathfinder" / "problems" / "sales"
    ml_quest.save_problem(problem, path)
    paths = (path, project)

    return paths


def test_quest_price(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    ML-Quest の値段を変える判断の問題の設定から始め, 書き戻して, 約束の
    とおりのデータセットをプロジェクトへ書き出すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        置き場の環境変数の差し替え

    Returns
    ----------
    None
    """
    # 受け渡しの値段の分 (最上位の price と, known の最後が値段の列)
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))
    path, project = quest_problem(tmp_path, write_sales(tmp_path / "raw"))
    passed = ml_quest.handoff(ml_quest.load_problem(path / "problem.yaml"))
    assert passed["price"]["price"] == "price"
    assert passed["data"]["task"] == "price"
    assert passed["data"]["split"] == "stratified"
    assert passed["data"]["known"][-1] == "price"

    # 一覧で始められ, 受け渡しの値で作ったレシピで始まる
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [True]
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    source = started.json()["source"]
    assert source["target"] == "units"
    url = f"/api/sources/{source['id']}"
    recipe = client.get(f"{url}/recipe").json()
    assert recipe["task"] == "price" and recipe["price"] == "price"
    assert recipe["cost"] == "unit_cost"
    assert recipe["product"] == "product_id"
    assert recipe["id"] == "record_id"
    assert recipe["split"]["method"] == passed["data"]["split"]

    # 食い違いの誤りが無く書き戻せ, 分割を変えると誤り
    result = client.post(f"{url}/problem/check", json={
        "recipe": recipe
    }).json()
    assert [item for item in result["conflicts"]
            if item["level"] == "error"] == []
    wrong = {**recipe, "split": {**recipe["split"], "method": "random"}}
    assert client.post(f"{url}/problem/check", json={
        "recipe": wrong
    }).status_code == 422
    assert client.post(f"{url}/problem/write", json={
        "recipe": recipe, "version": result["version"]
    }).status_code == 200
    problem = ml_quest.load_problem(path / "problem.yaml")
    assert ml_quest.get_value(problem, "data.recipe")["task"] == "price"

    # プロジェクトへの書き出しは値段を変えた記録の表で, 値段の列が最後
    exported = client.post(f"{url}/export_project", json={"recipe": recipe})
    assert exported.status_code == 200
    dataset = ml_eda.load_dataset(Path(exported.json()["path"]))
    assert dataset.info["task"] == "price"
    assert dataset.features[-1] == "price"
    assert set(dataset.info["price"]["splits"]) == {"train", "valid", "test"}
    assert Path(exported.json()["path"]).is_relative_to(project)
