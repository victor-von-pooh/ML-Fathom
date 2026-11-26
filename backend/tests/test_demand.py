from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"

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
