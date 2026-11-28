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

# 合成の介入の記録の表の行の数
ROWS = 200


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


def write_coupons(root: Path) -> Path:
    """
    クーポンを無作為に配った, 合成の介入の記録の表の CSV を作る関数

    Parameters
    ----------
    root: Path
        書き出す場所

    Returns
    ----------
    path: Path
        CSV のファイル (customer_id, age, visits, coupon, purchased, used.
        used は配った群でだけ値が変わる, 処置の後に決まる列)
    """
    # 決まった乱数. 配った群は買う確率が上がる
    rng = np.random.default_rng(0)
    coupon = rng.integers(0, 2, ROWS)
    age = rng.normal(40, 10, ROWS).round(1)
    visits = rng.poisson(3, ROWS)
    chance = 0.2 + 0.2 * coupon
    frame = pd.DataFrame({
        "customer_id": [f"c{index:03d}" for index in range(ROWS)],
        "age": age, "visits": visits, "coupon": coupon,
        "purchased": (rng.random(ROWS) < chance).astype(int),
        "used": np.where(coupon == 1, rng.integers(0, 2, ROWS), 0),
    })
    root.mkdir(parents=True, exist_ok=True)
    path = root / "coupons.csv"
    frame.to_csv(path, index=False)

    return path


def uplift_recipe() -> dict[str, Any]:
    """
    ML-EDA の介入の記録の表のレシピを作る関数

    Returns
    ----------
    recipe: dict[str, Any]
        結果の列, 処置の列, 結果の種類, 行の id の列, 処置の後に決まる列を
        落とす手順, 標準化と層化の分割のレシピ (ML-Quest の雛形と同じ形)
    """
    # ML-Quest の recipe_from の雛形と同じ形
    recipe: dict[str, Any] = {
        "format_version": 1, "task": "uplift", "target": "purchased",
        "treatment": "coupon", "outcome": "binary", "id": "customer_id",
        "steps": [{"op": "drop_columns", "columns": ["used"]},
                  {"op": "standardize", "columns": "auto"}],
        "split": {"method": "stratified", "valid": 0.2, "test": 0.2,
                  "seed": 0, "unlabeled": "drop"},
    }

    return recipe


def uplift_part(problem: dict[str, Any]) -> dict[str, Any]:
    """
    問題の設定の受け持ちを効果の見積もりにする関数

    ML-Quest の答えの確かめを通さずに受け持ちの答えを書く (効果の見積もり
    の問いに答えずに, この画面の見分けと止まり方を確かめるため)

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2)

    Returns
    ----------
    problem: dict[str, Any]
        受け持ちが効果を見積もるで, 方策でなく今ある記録から集める問題の
        設定
    """
    # 版 2 の受け持ちの答え
    problem["ml"]["parts"] = [{
        "role": "effect", "unit": "row", "output": "effect",
        "method": "scratch", "autonomous": False, "collect": "log",
    }]

    return problem


def test_describe(client: TestClient, tmp_path: Path) -> None:
    """
    介入の記録の要約が, 群の数, 結果の差, 釣り合いと処置の後に決まる列の
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
    # 群の行の数の合計と, 処置の後に決まる列の気付き
    file = write_coupons(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    url = f"/api/sources/{sid}/uplift"
    response = client.post(url, json={
        "treatment": "coupon", "outcome": "purchased",
        "outcome_kind": "binary", "id": "customer_id",
    })
    assert response.status_code == 200
    summary = response.json()
    groups = summary["groups"]
    assert groups["treated"]["rows"] + groups["control"]["rows"] == ROWS
    assert summary["rows"] == ROWS and summary["outcome_kind"] == "binary"
    assert summary["effect"] == pytest.approx(
        groups["treated"]["mean"] - groups["control"]["mean"]
    )
    assert "customer_id" not in [item["column"]
                                 for item in summary["balance"]]
    posts = [item for item in summary["findings"]
             if item["code"] == "post_treatment"]
    assert [item["columns"] for item in posts] == [["used"]]

    # 無い列と知らない結果の種類と知らない欄は 422
    missing = client.post(url, json={"treatment": "nothing",
                                     "outcome": "purchased"})
    assert missing.status_code == 422
    assert "nothing" in missing.json()["detail"]
    assert client.post(url, json={
        "treatment": "coupon", "outcome": "purchased", "outcome_kind": "x"
    }).status_code == 422
    assert client.post(url, json={
        "treatment": "coupon", "outcome": "purchased", "extra": 1
    }).status_code == 422


def test_describe_not_table(client: TestClient, tmp_path: Path) -> None:
    """
    表でないデータの介入の記録の要約は, 理由を付けて 422 で返すことを
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
    # 文のディレクトリ (クラスのフォルダ)
    root = tmp_path / "texts"
    for label in ("a", "b"):
        (root / label).mkdir(parents=True)
        for index in range(3):
            (root / label / f"{index}.txt").write_text(f"{label} {index}")
    sid = client.post("/api/sources", json={"path": str(root)}).json()["id"]
    response = client.post(f"/api/sources/{sid}/uplift", json={
        "treatment": "label", "outcome": "label"
    })
    assert response.status_code == 422
    assert "表と時系列だけ" in response.json()["detail"]


def test_preview_and_export(client: TestClient, tmp_path: Path) -> None:
    """
    効果を見積もるのレシピの前処理の様子と書き出しの結果, データセットの
    一覧が, 分割ごとの群の行の数と結果の平均を返すことを確かめる関数

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
    # 全ての分割に処置の群と対照の群があり, 処置の列は学習に使わない
    file = write_coupons(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    url = f"/api/sources/{sid}"
    recipe = uplift_recipe()
    previewed = client.post(f"{url}/preview", json={"recipe": recipe,
                                                    "upto": 2})
    assert previewed.status_code == 200
    body = previewed.json()
    uplift = body["uplift"]
    assert uplift["treatment"] == "coupon" and uplift["outcome"] == "binary"
    assert uplift["id"] == "customer_id"
    assert set(uplift["splits"]) == {"train", "valid", "test"}
    for split in uplift["splits"].values():
        assert split["treated"] > 0 and split["control"] > 0
    assert sum(split["treated"] + split["control"]
               for split in uplift["splits"].values()) == ROWS
    assert "coupon" not in body["features"]
    assert "customer_id" not in body["features"]

    # 書き出しの説明にも同じ数があり, 一覧も説明の uplift を返す
    exported = client.post(f"{url}/export", json={
        "recipe": recipe, "name": "coupons"
    })
    assert exported.status_code == 200
    assert exported.json()["info"]["uplift"] == uplift
    assert exported.json()["hints"]["outputs"] == 1
    listed = client.get("/api/datasets").json()
    assert [item["uplift"] for item in listed] == [uplift]
    assert listed[0]["task"] == "uplift"
    assert listed[0]["anomaly"] is None


def test_preview_wrong_split(client: TestClient, tmp_path: Path) -> None:
    """
    効果を見積もるの層化でない分割と, 他のタスクの処置の列は ML-EDA の誤り
    になり, 他のタスクでは uplift が None であることを確かめる関数

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
    # 無作為の分割は 422
    file = write_coupons(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    url = f"/api/sources/{sid}"
    wrong = uplift_recipe()
    wrong["split"]["method"] = "random"
    assert client.post(f"{url}/preview", json={
        "recipe": wrong, "upto": 2
    }).status_code == 422

    # 分類に処置の列を書くと 422, 書かなければ uplift は None
    plain = {"format_version": 1, "task": "classification",
             "target": "purchased", "steps": [],
             "split": {"method": "stratified", "valid": 0.2, "test": 0.1}}
    assert client.post(f"{url}/preview", json={
        "recipe": {**plain, "treatment": "coupon"}, "upto": 0
    }).status_code == 422
    body = client.post(f"{url}/preview", json={"recipe": plain,
                                               "upto": 0}).json()
    assert body["uplift"] is None


def test_is_uplift() -> None:
    """
    効果の見積もりの受け持ちの見分けを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 方策, 試して集めるもの, 既製のモデルをそのまま使うものは違う
    problem = uplift_part(ml_quest.example_problem("解約の引き止め"))
    assert problems.is_uplift(problem)
    for key, value in (("autonomous", True), ("collect", "online"),
                       ("method", "pretrained")):
        other = uplift_part(ml_quest.example_problem("解約の引き止め"))
        other["ml"]["parts"][0][key] = value
        assert not problems.is_uplift(other)
    assert not problems.is_uplift(ml_quest.example_problem("解約の引き止め"))


def start_with(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    data: Path, recipe: dict[str, Any]
) -> Any:
    """
    ML-Quest の受け渡しの効果の見積もりのレシピの雛形で, 問題の設定から
    始める関数

    ML-Quest が作らない形のレシピ (表に無い列, 表でないデータなど) でも
    始める流れを確かめるため, 受け渡しの形 (recipe_from のレシピと load)
    のまま recipe_from を差し替える

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        recipe_from の差し替え
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
    problem = uplift_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="クーポンの効果", created_at="2000-01-01T00:00:00")
    path = tmp_path / "problem" / "problem.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump(problem, allow_unicode=True), "utf-8")
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
    効果の見積もりの受け渡しのレシピで始めると, 結果の列を目的の列にして
    登録し, レシピを保存することを確かめる関数

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
    # 結果の列が目的の列, レシピは受け渡しのまま
    recipe = uplift_recipe()
    started = start_with(client, tmp_path, monkeypatch,
                         write_coupons(tmp_path / "raw"), recipe)
    assert started.status_code == 201
    body = started.json()
    assert body["form"] is None and body["tab"] is None
    assert body["source"]["target"] == "purchased"
    assert body["source"]["kind"] == "table"
    saved = client.get(f"/api/sources/{body['source']['id']}/recipe").json()
    assert saved["task"] == "uplift" and saved["treatment"] == "coupon"
    assert saved["outcome"] == "binary" and saved["id"] == "customer_id"
    assert saved["split"]["method"] == "stratified"


@pytest.mark.parametrize("key", ["target", "treatment", "id"])
def test_start_missing_column(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    key: str
) -> None:
    """
    答えた結果の列, 処置の列か行の id の列が表に無ければ, 登録せずに理由
    を返すことを確かめる関数

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
    recipe = {**uplift_recipe(), key: "missing_column"}
    started = start_with(client, tmp_path, monkeypatch,
                         write_coupons(tmp_path / "raw"), recipe)
    assert started.status_code == 422
    assert "missing_column" in started.json()["detail"]
    assert client.get("/api/sources").json() == []


def test_start_not_table(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    表でないデータを入れた効果の見積もりの問題の設定は, 登録せずに理由を
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
    recipe = {**uplift_recipe(), "target": "label", "treatment": "flag"}
    del recipe["id"]
    started = start_with(client, tmp_path, monkeypatch, root, recipe)
    assert started.status_code == 422
    assert "表ではありません" in started.json()["detail"]
    assert client.get("/api/sources").json() == []


def test_start_refused(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    ML-Quest が効果の見積もりの問題の設定を受けない場合 (効果の見積もりの
    問いに答えていない場合), 理由を付けて 422 で止まり, 一覧でも始められ
    ないことを確かめる関数

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
    # 表を入れ, 効果の見積もりの問いに答えていない問題の設定 (ML-Quest の
    # 答えの確かめを通さずに書いたもの)
    data = write_coupons(tmp_path / "raw")
    problem = uplift_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="クーポンの効果", created_at="2000-01-01T00:00:00")
    problem["data"] = {"source": str(data), "loader": "csv", "options": {}}
    path = tmp_path / "pathfinder" / "problems" / "coupon" / "problem.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump(problem, allow_unicode=True), "utf-8")
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))

    # 始めると 422 で ML-Quest の理由があり, データは登録しない
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 422
    detail = started.json()["detail"]
    assert "問題を渡せません" in detail
    assert client.get("/api/sources").json() == []

    # 一覧でも始められず, 同じ理由がある
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [False]
    assert listed[0]["reason"] == detail


def quest_problem(tmp_path: Path, data: Path) -> tuple[Path, Path]:
    """
    ML-Quest で効果の見積もりの問題の設定を作り, データを入れてプロジェクト
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
    problem = ml_quest.answer(
        problem, "information.columns",
        ["customer_id", "age", "visits", "coupon", "purchased", "used"]
    )
    for key, value in [
        ("role", "effect"), ("unit", "row"), ("output", "effect"),
        ("target.source", "intervention"), ("method", "scratch"),
        ("autonomous", False), ("collect", "log"),
        ("what", "クーポンで買う確率がどれだけ上がるか"),
        ("item", "顧客ごとの 1 行"), ("baseline", "全員に配る"),
        ("uplift.treatment", "coupon"), ("uplift.outcome", "purchased"),
        ("uplift.outcome_kind", "binary"), ("uplift.id", "customer_id"),
        ("uplift.columns", ["age", "visits"]), ("uplift.k", 0.3),
        ("evaluation.metric", "qini"),
        ("evaluation.link", "効果の順が当たるほど配る費用が実る"),
    ]:
        problem = ml_quest.answer(problem, f"{PART}.{key}", value)
    problem = ml_quest.answer(problem, "action.decision",
                              {"type": "treat", "budget": 50})
    problem = ml_quest.attach_data(problem, str(data))
    # 効果の見積もりの骨組みを書き出せない ML-Quest のための, 骨組みの config
    # と同じ場所 (data.dataset) の記録
    project = tmp_path / "project"
    config = project / "configs" / "default" / "train.yaml"
    config.parent.mkdir(parents=True)
    config.write_text(yaml.safe_dump({"data": {
        "dataset": str(project / "data" / "dataset")
    }}), "utf-8")
    problem = ml_quest.record_project(problem, project)
    path = tmp_path / "pathfinder" / "problems" / "coupon"
    ml_quest.save_problem(problem, path)
    paths = (path, project)

    return paths


def test_quest_uplift(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    ML-Quest の効果の見積もりの問題の設定から始め, 書き戻して, 約束の
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
    # 一覧で始められることと, 受け渡しの値で作ったレシピの始まり
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))
    path, project = quest_problem(tmp_path, write_coupons(tmp_path / "raw"))
    passed = ml_quest.handoff(ml_quest.load_problem(path / "problem.yaml"))
    assert passed["uplift"]["treatment"] == "coupon"
    assert passed["data"]["task"] == "uplift"
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [True]
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    source = started.json()["source"]
    assert source["target"] == "purchased"
    url = f"/api/sources/{source['id']}"
    recipe = client.get(f"{url}/recipe").json()
    assert recipe["task"] == "uplift" and recipe["treatment"] == "coupon"
    assert recipe["outcome"] == "binary" and recipe["id"] == "customer_id"
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
    assert ml_quest.get_value(problem, "data.recipe")["task"] == "uplift"

    # プロジェクトへの書き出しは介入の記録の表で, 全ての分割に両方の群
    exported = client.post(f"{url}/export_project", json={"recipe": recipe})
    assert exported.status_code == 200
    dataset = ml_eda.load_dataset(Path(exported.json()["path"]))
    assert dataset.info["task"] == "uplift"
    for split in dataset.info["uplift"]["splits"].values():
        assert split["treated"] > 0 and split["control"] > 0
    assert Path(exported.json()["path"]).is_relative_to(project)
