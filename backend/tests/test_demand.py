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

# 合成の記録の表の列
COLUMNS = ["product_id", "date", "category", "units", "stock"]

# 発注の判断 (足りない損, 余る損, 発注の上限)
DECISION = {"type": "order", "shortage_cost": 3, "holding_cost": 1,
            "max_order": 60}

# 合成の記録の日数
DAYS = 84

# 合成の記録の商品の数
PRODUCTS = 5


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


def write_daily(root: Path) -> Path:
    """
    商品ごとの日ごとの売れた数の, 合成の記録の表の CSV を作る関数

    Parameters
    ----------
    root: Path
        書き出す場所

    Returns
    ----------
    path: Path
        CSV のファイル (product_id, date, category, units, stock. 商品 p4
        は最後の 20 日だけの短い記録, p1 は 15 日の抜けの日があり, p2 は
        3 日と 4 日の在庫が 0)
    """
    # 決まった乱数. 商品ごとに水準が違い, 土日に多く売れる
    rng = np.random.default_rng(0)
    days = pd.date_range("2025-01-06", periods=DAYS, freq="D")
    rows = []
    for product in range(PRODUCTS):
        used = days if product != 4 else days[-20:]
        for day in used:
            if product == 1 and day.day == 15:
                continue
            scale = 1.5 if day.weekday() >= 5 else 1.0
            rows.append({
                "product_id": f"p{product}",
                "date": day.strftime("%Y-%m-%d"),
                "category": "food" if product < 3 else "tool",
                "units": int(rng.poisson((5 + 3 * product) * scale)),
                "stock": 0 if product == 2 and day.day in (3, 4) else int(
                    rng.integers(5, 40)
                ),
            })
    root.mkdir(parents=True, exist_ok=True)
    path = root / "daily.csv"
    pd.DataFrame(rows).to_csv(path, index=False)

    return path


def demand_recipe() -> dict[str, Any]:
    """
    ML-EDA の需要の記録の表のレシピを作る関数

    Returns
    ----------
    recipe: dict[str, Any]
        売れた数, 商品の id, 日付, 在庫の数の列, 先の期間の日数, 過去の
        売れた数のずらしと移動平均, 曜日, 符号化, 標準化と時刻の順の分割の
        レシピ
    """
    # ML-EDA の docs/DESIGN.md の「需要の記録の表」の例と同じ形
    recipe: dict[str, Any] = {
        "format_version": 1, "task": "demand", "target": "units",
        "product": "product_id", "date": "date", "stock": "stock",
        "horizon": 7,
        "steps": [{"op": "lag", "columns": ["units"], "lags": [1, 7],
                   "windows": [7], "by": ["product_id"], "time": "date",
                   "freq": "1D"},
                  {"op": "datetime_parts", "columns": ["date"],
                   "parts": ["weekday"]},
                  {"op": "one_hot", "columns": ["category"]},
                  {"op": "standardize", "columns": "auto"}],
        "split": {"method": "time", "valid": 0.2, "test": 0.2},
    }

    return recipe


def register(client: TestClient, tmp_path: Path) -> str:
    """
    合成の記録の表を登録する関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    sid: str
        登録したデータの ID
    """
    # 日付の列を見つけて時系列として読む
    file = write_daily(tmp_path / "raw")
    sid: str = client.post(
        "/api/sources", json={"path": str(file)}
    ).json()["id"]

    return sid


def test_describe(client: TestClient, tmp_path: Path) -> None:
    """
    需要の記録の要約が, 商品ごとの記録の日数と抜けの日, 曜日ごとの売れた数,
    在庫が 0 の日と気付きを返し, 誤りは理由を付けて 422 で返すことを
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
    # 抜けの日, 記録の短い商品, 在庫が 0 の日の気付き
    sid = register(client, tmp_path)
    url = f"/api/sources/{sid}/demand"
    response = client.post(url, json={
        "product": "product_id", "date": "date", "units": "units",
        "stock": "stock", "horizon": 7,
    })
    assert response.status_code == 200
    summary = response.json()
    assert summary["dates"]["days"] == DAYS
    assert summary["products"]["count"] == PRODUCTS
    assert summary["products"]["short"] == 1
    assert summary["products"]["gaps"] == 1
    assert summary["products"]["rows"][0]["product"] == "p4"
    assert len(summary["weekdays"]) == 7
    weekend = summary["weekdays"][5]["units_mean"]
    assert weekend > summary["weekdays"][0]["units_mean"]
    assert summary["stockout"]["rows"] == 4
    codes = [item["code"] for item in summary["findings"]]
    assert {"date_gaps", "short_history", "stockout_days"} <= set(codes)

    # 在庫の数を省くと在庫が 0 の日は None で, 先の期間で記録の短い目安が
    # 変わる
    plain = client.post(url, json={
        "product": "product_id", "date": "date", "units": "units",
        "horizon": 3,
    })
    assert plain.status_code == 200
    assert plain.json()["stockout"] is None
    assert plain.json()["horizon"] == 3
    assert plain.json()["products"]["short"] == 0

    # 無い列, 重なる列, 0 日の先の期間と知らない欄は 422
    missing = client.post(url, json={
        "product": "nothing", "date": "date", "units": "units"
    })
    assert missing.status_code == 422
    assert "nothing" in missing.json()["detail"]
    for body in ({"product": "product_id", "date": "date",
                  "units": "product_id"},
                 {"product": "product_id", "date": "date", "units": "units",
                  "horizon": 0},
                 {"product": "product_id", "date": "date", "units": "units",
                  "extra": 1}):
        assert client.post(url, json=body).status_code == 422


def test_describe_not_table(client: TestClient, tmp_path: Path) -> None:
    """
    表でないデータの需要の記録の要約は, 理由を付けて 422 で返すことを
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
    response = client.post(f"/api/sources/{sid}/demand", json={
        "product": "label", "date": "label", "units": "label"
    })
    assert response.status_code == 422
    assert "表と時系列だけ" in response.json()["detail"]


def test_preview_and_export(client: TestClient, tmp_path: Path) -> None:
    """
    需要の予測のレシピの前処理の様子と書き出しの結果, データセットの一覧が,
    分割ごとの発注を決める日の範囲と期間の合計を返すことを確かめる関数

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
    # 売れた数, 商品の id, 日付, 在庫の数の列は学習に使わない
    sid = register(client, tmp_path)
    url = f"/api/sources/{sid}"
    recipe = demand_recipe()
    previewed = client.post(f"{url}/preview", json={"recipe": recipe,
                                                    "upto": 4})
    assert previewed.status_code == 200
    body = previewed.json()
    demand = body["demand"]
    assert demand["product"] == "product_id" and demand["date"] == "date"
    assert demand["stock"] == "stock" and demand["target"] == "demand"
    assert demand["previous"] == "demand_previous"
    assert demand["horizon"] == 7 and demand["interval"] == 7
    assert set(demand["splits"]) == {"train", "valid", "test"}
    assert demand["splits"]["train"]["date_max"] < (
        demand["splits"]["valid"]["date_min"]
    )
    assert demand["splits"]["train"]["stockout"] is not None
    assert "units_lag1" in body["features"]
    for name in ("units", "product_id", "date", "stock", "demand",
                 "demand_previous"):
        assert name not in body["features"]
    assert body["price"] is None and body["uplift"] is None

    # 書き出しの説明にも同じ数があり, 一覧も説明の demand を返す
    exported = client.post(f"{url}/export", json={
        "recipe": recipe, "name": "daily"
    })
    assert exported.status_code == 200
    assert exported.json()["info"]["demand"] == demand
    assert exported.json()["hints"]["outputs"] == 1
    listed = client.get("/api/datasets").json()
    assert [item["demand"] for item in listed] == [demand]
    assert listed[0]["task"] == "demand"
    assert listed[0]["price"] is None


@pytest.mark.parametrize("change", ["split", "lag_by", "lag_late"])
def test_preview_refused(
    client: TestClient, tmp_path: Path, change: str
) -> None:
    """
    需要の予測の時刻の順でない分割と, 商品ごとでない lag と, 値を学ぶ手順
    より後の lag は ML-EDA の誤りになることを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    change: str
        崩すところ (分割, lag の by, lag の位置)

    Returns
    ----------
    None
    """
    # どれも 422
    sid = register(client, tmp_path)
    wrong = demand_recipe()
    if change == "split":
        wrong["split"]["method"] = "random"
    elif change == "lag_by":
        del wrong["steps"][0]["by"]
    else:
        wrong["steps"].append(wrong["steps"].pop(0))
    response = client.post(f"/api/sources/{sid}/preview", json={
        "recipe": wrong, "upto": len(wrong["steps"])
    })
    assert response.status_code == 422


def test_preview_other_task(client: TestClient, tmp_path: Path) -> None:
    """
    他のタスクに日付の列を書くと ML-EDA の誤りになり, 書かなければ demand
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
    # 回帰に日付の列を書くと 422
    sid = register(client, tmp_path)
    url = f"/api/sources/{sid}"
    plain = {"format_version": 1, "task": "regression", "target": "units",
             "steps": [], "split": {"method": "random", "valid": 0.2,
                                    "test": 0.1}}
    assert client.post(f"{url}/preview", json={
        "recipe": {**plain, "date": "date"}, "upto": 0
    }).status_code == 422
    body = client.post(f"{url}/preview", json={"recipe": plain,
                                               "upto": 0}).json()
    assert body["demand"] is None


def demand_part(problem: dict[str, Any]) -> dict[str, Any]:
    """
    問題の設定の受け持ちを時間をまたぐ量の判断にする関数

    ML-Quest の答えの確かめを通さずに受け持ちの答えを書く (時間をまたぐ量の
    判断の問いに答えずに, この画面の見分けと止まり方を確かめるため)

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2)

    Returns
    ----------
    problem: dict[str, Any]
        受け持ちが予測するで, 正解の種類が先の期間の需要の問題の設定
    """
    # 版 2 の受け持ちの答え
    problem["ml"]["parts"] = [{
        "role": "predict", "unit": "row", "output": "distribution",
        "target": {"kind": "demand", "source": "column"},
        "method": "scratch",
    }]

    return problem


def test_is_demand() -> None:
    """
    時間をまたぐ量の判断の受け持ちの見分けが ML-Quest の骨組みの型と同じで,
    受けない版の ML-Quest では答えで見分けることを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 予測するで正解の種類が先の期間の需要なら時間をまたぐ量の判断
    problem = demand_part(ml_quest.example_problem("解約の引き止め"))
    assert problems.demand_supported()
    assert ml_quest.skeleton_type(problem) == "demand"
    assert problems.is_demand(problem)
    assert not problems.is_anomaly(problem)
    assert not ml_quest.is_column_part(problem)
    ready = demand_part(ml_quest.example_problem("解約の引き止め"))
    ready["ml"]["parts"][0]["method"] = "pretrained"
    assert not problems.is_demand(ready)
    assert not problems.is_demand(ml_quest.example_problem("解約の引き止め"))


def test_is_demand_old_quest(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    時間をまたぐ量の判断を受けない版の ML-Quest でも, 答えのまま見分けること
    を確かめる関数

    Parameters
    ----------
    monkeypatch: pytest.MonkeyPatch
        骨組みの型の並びの差し替え

    Returns
    ----------
    None
    """
    # 骨組みの型に demand の無い版
    monkeypatch.setattr(ml_quest, "SKELETON_TYPES", ("column",))
    assert not problems.demand_supported()
    problem = demand_part(ml_quest.example_problem("解約の引き止め"))
    assert problems.is_demand(problem)
    problem["ml"]["parts"][0]["method"] = "pretrained"
    assert not problems.is_demand(problem)


def start_with(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    data: Path, recipe: dict[str, Any]
) -> Any:
    """
    ML-Quest の受け渡しの時間をまたぐ量の判断のレシピの雛形で, 問題の設定
    から始める関数

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
    problem = demand_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="発注の数", created_at="2000-01-01T00:00:00")
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
    時間をまたぐ量の判断の受け渡しのレシピで始めると, 日ごとの売れた数の列
    を目的の列にして登録し, レシピを保存することを確かめる関数

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
    started = start_with(client, tmp_path, monkeypatch,
                         write_daily(tmp_path / "raw"), demand_recipe())
    assert started.status_code == 201
    body = started.json()
    assert body["form"] is None and body["tab"] is None
    assert body["source"]["target"] == "units"
    assert body["source"]["kind"] in ("table", "timeseries")
    saved = client.get(f"/api/sources/{body['source']['id']}/recipe").json()
    assert saved["task"] == "demand" and saved["product"] == "product_id"
    assert saved["date"] == "date" and saved["stock"] == "stock"
    assert saved["horizon"] == 7
    assert saved["split"]["method"] == "time"


@pytest.mark.parametrize("key", ["target", "product", "date", "stock", "id"])
def test_start_missing_column(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    key: str
) -> None:
    """
    答えた日ごとの売れた数, 商品の id, 日付, 在庫の数か行の id の列が表に
    無ければ, 登録せずに理由を返すことを確かめる関数

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
    recipe = {**demand_recipe(), key: "missing_column"}
    started = start_with(client, tmp_path, monkeypatch,
                         write_daily(tmp_path / "raw"), recipe)
    assert started.status_code == 422
    assert "missing_column" in started.json()["detail"]
    assert client.get("/api/sources").json() == []


def test_start_not_table(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    表でないデータを入れた時間をまたぐ量の判断の問題の設定は, 登録せずに
    理由を返すことを確かめる関数

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
    recipe = {"format_version": 1, "task": "demand", "target": "label",
              "product": "text", "date": "path", "steps": [],
              "split": {"method": "time", "valid": 0.2, "test": 0.2}}
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
    path = tmp_path / "pathfinder" / "problems" / "daily" / "problem.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump(problem, allow_unicode=True), "utf-8")

    return path


def test_start_old_quest(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    組の ML-Quest が時間をまたぐ量の判断を受けない版なら, 時間をまたぐ量の
    判断の問題の設定は理由を付けて 422 で止まり, 一覧でも始められないこと
    を確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        置き場の環境変数と骨組みの型の並びの差し替え

    Returns
    ----------
    None
    """
    # 表を入れた時間をまたぐ量の判断の問題の設定と, 受けない版の ML-Quest
    data = write_daily(tmp_path / "raw")
    problem = demand_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="発注の数", created_at="2000-01-01T00:00:00")
    problem["data"] = {"source": str(data), "loader": "csv", "options": {}}
    path = save_problem(tmp_path, problem)
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))
    monkeypatch.setattr(ml_quest, "SKELETON_TYPES", ("column",))

    # 始めると 422 で版の理由があり, データは登録しない
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 422
    detail = started.json()["detail"]
    assert "問題を渡せません" in detail
    assert "時間をまたぐ量の判断を受けない版" in detail
    assert client.get("/api/sources").json() == []

    # 一覧でも始められず, 同じ理由がある
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [False]
    assert listed[0]["reason"] == detail


def test_start_refused(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    時間をまたぐ量の判断の問いに答えていない問題の設定は, ML-Quest の理由を
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
    # 表を入れ, 商品の id の列などの問いに答えていない問題の設定
    data = write_daily(tmp_path / "raw")
    problem = demand_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="発注の数", created_at="2000-01-01T00:00:00")
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
    ML-Quest で時間をまたぐ量の判断の問題の設定を作り, データを入れて
    プロジェクトを書き出した記録を付けて, ML-Pathfinder の置き場に保存する
    関数

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
        ("role", "predict"), ("unit", "row"), ("output", "distribution"),
        ("target.kind", "demand"), ("target.source", "column"),
        ("method", "scratch"), ("what", "先の 7 日の売れる数"),
        ("item", "商品と発注を決める日ごとの 1 行"),
        ("baseline", "前の 7 日と同じ数を発注する"),
        ("demand.product", "product_id"), ("demand.date", "date"),
        ("demand.units", "units"), ("demand.stock", "stock"),
        ("demand.columns", ["category"]), ("evaluation.metric", "loss"),
        ("evaluation.link", "分位点の損失が小さいほど発注の数の損の見込み"
         "が当たる"),
    ]:
        problem = ml_quest.answer(problem, f"{PART}.{key}", value)
    problem = ml_quest.answer(problem, "action.decision", DECISION)
    problem = ml_quest.attach_data(problem, str(data))
    project = tmp_path / "project"
    ml_quest.make_project(problem, project)
    problem = ml_quest.record_project(problem, project)
    path = tmp_path / "pathfinder" / "problems" / "daily"
    ml_quest.save_problem(problem, path)
    paths = (path, project)

    return paths


def test_quest_demand(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    ML-Quest の時間をまたぐ量の判断の問題の設定から始め, 書き戻して, 約束
    のとおりのデータセットをプロジェクトへ書き出すことを確かめる関数

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
    # 一覧で始められ, 受け渡しの値で作ったレシピで始まる
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))
    path, project = quest_problem(tmp_path, write_daily(tmp_path / "raw"))
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [True]
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    source = started.json()["source"]
    assert source["target"] == "units"
    url = f"/api/sources/{source['id']}"
    recipe = client.get(f"{url}/recipe").json()
    assert recipe["task"] == "demand" and recipe["product"] == "product_id"
    assert recipe["date"] == "date" and recipe["stock"] == "stock"
    assert recipe["horizon"] == 7 and "id" not in recipe
    assert recipe["split"]["method"] == "time"
    assert [step["op"] for step in recipe["steps"]] == [
        "lag", "datetime_parts", "standardize"
    ]

    # 種類の列を数にしたレシピは食い違いの誤りが無く書き戻せる. 時刻の順で
    # ない分割は ML-EDA の誤り, 答えと違う先の期間の日数は食い違いの誤り
    recipe["steps"].insert(2, {"op": "one_hot", "columns": ["category"]})
    result = client.post(f"{url}/problem/check", json={
        "recipe": recipe
    }).json()
    assert [item for item in result["conflicts"]
            if item["level"] == "error"] == []
    wrong = {**recipe, "split": {**recipe["split"], "method": "random"}}
    assert client.post(f"{url}/problem/check", json={
        "recipe": wrong
    }).status_code == 422
    longer = client.post(f"{url}/problem/check", json={
        "recipe": {**recipe, "horizon": 14}
    }).json()
    assert [item["level"] for item in longer["conflicts"]] == ["error"]
    assert client.post(f"{url}/problem/write", json={
        "recipe": recipe, "version": result["version"]
    }).status_code == 200
    problem = ml_quest.load_problem(path / "problem.yaml")
    assert ml_quest.get_value(problem, "data.recipe")["task"] == "demand"

    # プロジェクトへの書き出しは需要の記録の表で, 正解は先の期間の合計
    exported = client.post(f"{url}/export_project", json={"recipe": recipe})
    assert exported.status_code == 200
    dataset = ml_eda.load_dataset(Path(exported.json()["path"]))
    assert dataset.info["task"] == "demand"
    assert dataset.info["demand"]["horizon"] == 7
    assert set(dataset.info["demand"]["splits"]) == {"train", "valid", "test"}
    assert Path(exported.json()["path"]).is_relative_to(project)
