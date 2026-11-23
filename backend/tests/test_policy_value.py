import shutil
from pathlib import Path

import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from ml_fathom import api, policy_value
from ml_fathom.app import create_app
from ml_fathom.policy_value import (
    csv_table,
    discrete_space,
    make_policy,
    most_frequent_action,
)

# テストで使うトークン
TOKEN = "test-token"

# ML-EDA のテストの見本 (行動を選んだ確率の列を持つ Discrete の軌跡と,
# 確率の列の無い軌跡)
SAMPLES = (
    Path(__file__).resolve().parents[2] / "ML-EDA" / "tests" / "data"
    / "trajectories"
)


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


def register(client: TestClient, path: Path) -> str:
    """
    軌跡を登録して ID を返す関数

    Parameters
    ----------
    client: TestClient
        クライアント
    path: Path
        表か説明

    Returns
    ----------
    sid: str
        データの ID
    """
    response = client.post(
        "/api/sources", json={"path": str(path), "loader": "trajectory"}
    )
    assert response.status_code == 201
    sid: str = response.json()["id"]

    return sid


def copy_sample(tmp_path: Path, name: str) -> Path:
    """
    見本の軌跡の表と説明を一時ディレクトリに写す関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    name: str
        見本の名前

    Returns
    ----------
    table: Path
        写した表
    """
    for suffix in (".csv", ".json"):
        file = f"{name}{suffix}"
        shutil.copyfile(SAMPLES / file, tmp_path / file)
    table = tmp_path / f"{name}.csv"

    return table


def test_estimate(client: TestClient, tmp_path: Path) -> None:
    """
    確率の列のある軌跡で, 一様の方策と ε-greedy の方策の良さを ML-Found
    で見積もることを確かめる関数

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
    # ML-Found (任意の依存 policy) が無い環境では飛ばす
    pytest.importorskip("ml_found")
    assert client.get("/api/info").json()["policy_value"] is True
    table = copy_sample(tmp_path, "prob")
    sid = register(client, table)

    # 一様の方策 (確率 0.5) は, 記録の確率 0.7 と 0.3 で重みが変わる
    response = client.post(
        f"/api/sources/{sid}/policy_value", json={"policy": "uniform"}
    )
    assert response.status_code == 200
    result = response.json()
    assert result["policy"] == {"name": "uniform", "n": 2, "start": 0}
    assert result["gamma"] == 1.0
    estimate = result["estimate"]
    assert estimate["value"] == pytest.approx(2.0)
    assert estimate["behavior_value"] == pytest.approx(2.0)
    assert estimate["ordinary"] == pytest.approx(1.7006802721)
    assert estimate["per_decision"] is not None
    assert estimate["effective_sample_size"] == pytest.approx(2.0)
    assert estimate["episodes"] == 2 and estimate["steps"] == 6
    assert any("守りで止めた" in note for note in estimate["notes"])

    # 説明を登録しても同じ表を読み, ε-greedy は記録で最も多い行動 1 を選ぶ
    sid = register(client, tmp_path / "prob.json")
    result = client.post(
        f"/api/sources/{sid}/policy_value",
        json={"policy": "epsilon_greedy", "epsilon": 0.2, "gamma": 0.9},
    ).json()
    assert result["policy"]["action"] == 1
    assert result["policy"]["epsilon"] == 0.2
    assert result["gamma"] == 0.9
    assert result["estimate"]["episodes"] == 2


def test_estimate_refused(client: TestClient, tmp_path: Path) -> None:
    """
    確率の列の無い軌跡, 軌跡でないデータ, 範囲の外の引数を断ることを
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
    # 確率の列の無い表は, 理由を付けて 422
    pytest.importorskip("ml_found")
    sid = register(client, copy_sample(tmp_path, "guarded"))
    response = client.post(
        f"/api/sources/{sid}/policy_value", json={"policy": "uniform"}
    )
    assert response.status_code == 422
    assert "action_prob" in response.json()["detail"]

    # 範囲の外の引数と知らない方策の形
    sid = register(client, copy_sample(tmp_path, "prob"))
    for body in (
        {"policy": "uniform", "gamma": 1.5},
        {"policy": "epsilon_greedy", "epsilon": -0.1},
        {"policy": "greedy"},
    ):
        response = client.post(f"/api/sources/{sid}/policy_value", json=body)
        assert response.status_code == 422

    # 普通の表のデータ
    plain = tmp_path / "plain.csv"
    plain.write_text("a,b\n1,2\n", "utf-8")
    pid = client.post("/api/sources", json={"path": str(plain)}).json()["id"]
    response = client.post(
        f"/api/sources/{pid}/policy_value", json={"policy": "uniform"}
    )
    assert response.status_code == 422


def test_without_ml_found(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    ML-Found が無い場合は使えないと返し, 見積もりを断ることを確かめる
    関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        ML-Found の有無を差し替える

    Returns
    ----------
    None
    """
    # 入っていない環境として扱う
    for module in (api, policy_value):
        monkeypatch.setattr(
            module, "policy_value_available", lambda: False
        )
    assert client.get("/api/info").json()["policy_value"] is False
    sid = register(client, copy_sample(tmp_path, "prob"))
    response = client.post(
        f"/api/sources/{sid}/policy_value", json={"policy": "uniform"}
    )
    assert response.status_code == 422
    assert "ML-Found" in response.json()["detail"]


def test_csv_table(tmp_path: Path) -> None:
    """
    ML-Found に渡す CSV の表を, 登録した表か説明の file から決め, CSV で
    ない表を断ることを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 表はそのまま, 説明は file の表
    table = copy_sample(tmp_path, "prob")
    assert csv_table(table, {"format": "csv"}) == table
    assert csv_table(tmp_path / "prob.json", {"format": "csv"}) == table

    # Parquet の表と, 別のディレクトリを指す説明
    with pytest.raises(HTTPException, match="CSV"):
        csv_table(tmp_path / "prob.parquet", {"format": "parquet"})
    outside = tmp_path / "outside.json"
    outside.write_text('{"file": "../prob.csv"}', "utf-8")
    with pytest.raises(HTTPException, match="file"):
        csv_table(outside, {"format": "csv"})


def test_fixed_policy() -> None:
    """
    決まった形の方策の確率と, Discrete でない行動の空間を断ることを
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 行動 0 から 2 の 3 つ. 記録では 2 が最も多い
    summary = {
        "action_space": {"type": "discrete", "n": 3, "start": 0},
        "action_columns": ["action"],
        "actions": [{"counts": [
            {"value": 0, "count": 4}, {"value": 2, "count": 6},
            {"value": 1, "count": 6},
        ]}],
    }
    uniform, described = make_policy(summary, "uniform", 0.3)
    assert described == {"name": "uniform", "n": 3, "start": 0}
    assert uniform(None, 1) == pytest.approx(1 / 3)
    assert uniform(None, 3) == 0.0

    # 同じ数なら小さい番号. 残りの確率は一様
    greedy, described = make_policy(summary, "epsilon_greedy", 0.3)
    assert described["action"] == 1
    assert greedy(None, 1) == pytest.approx(0.7 + 0.1)
    assert greedy(None, 0) == pytest.approx(0.1)
    assert sum(greedy(None, a) for a in range(3)) == pytest.approx(1.0)

    # Box の行動, 説明の無い表, 値ごとの数の無い行動
    for space in ({"type": "box", "shape": [1]}, None):
        with pytest.raises(HTTPException, match="Discrete"):
            discrete_space({**summary, "action_space": space})
    with pytest.raises(HTTPException, match="最も多い"):
        most_frequent_action({"actions": [{"counts": None}]})


def test_parquet_refused(client: TestClient, tmp_path: Path) -> None:
    """
    Parquet の軌跡は, CSV だけを読むと理由を付けて断ることを確かめる
    関数

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
    # 確率の列を持つ Parquet の表
    pytest.importorskip("ml_found")
    table = tmp_path / "steps.parquet"
    pd.DataFrame({
        "episode": [0, 0], "step": [0, 1], "obs": [0.5, 0.25],
        "action": [1, 0], "reward": [1.0, 1.0],
        "terminated": [False, True], "truncated": [False, False],
        "action_prob": [0.5, 0.5],
    }).to_parquet(table)
    sid = register(client, table)
    response = client.post(
        f"/api/sources/{sid}/policy_value", json={"policy": "uniform"}
    )
    assert response.status_code == 422
    assert "CSV" in response.json()["detail"]
