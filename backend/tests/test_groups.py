from pathlib import Path

import ml_eda
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"

# 合成の群分けの表の行の数
ROWS = 90


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


def write_customers(path: Path) -> Path:
    """
    3 つのはっきりした群を持つ顧客の表を csv で保存する関数

    Parameters
    ----------
    path: Path
        ディレクトリ

    Returns
    ----------
    file: Path
        保存した csv (会員の番号, 使った額, 回数, 地域, 欠けを含む年齢)
    """
    # 群ごとに額と回数と地域を分け, 年齢に欠けを入れる
    rng = np.random.default_rng(0)
    size = ROWS // 3
    frame = pd.DataFrame({
        "member": [f"m{index:03d}" for index in range(ROWS)],
        "spend": np.concatenate([
            rng.normal(center, 1.0, size) for center in (0.0, 20.0, 40.0)
        ]),
        "visits": np.concatenate([
            rng.normal(center, 0.5, size) for center in (1.0, 10.0, 20.0)
        ]),
        "region": ["east"] * size + ["west"] * size + ["north"] * size,
        "age": rng.integers(20, 70, ROWS).astype(float),
    })
    frame.loc[:4, "age"] = np.nan
    file = path / "customers.csv"
    frame.to_csv(file, index=False)

    return file


def register(client: TestClient, file: Path) -> str:
    """
    表を登録してデータの ID を返す関数

    Parameters
    ----------
    client: TestClient
        クライアント
    file: Path
        表のファイル

    Returns
    ----------
    sid: str
        データの ID
    """
    created = client.post("/api/sources", json={"path": str(file)})
    assert created.status_code == 201
    sid: str = created.json()["id"]

    return sid


def test_describe_groups(client: TestClient, tmp_path: Path) -> None:
    """
    選んだ列と群の数で, ML-EDA の describe_groups と同じ群の要約を返す
    ことを確かめる関数

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
    file = write_customers(tmp_path)
    sid = register(client, file)
    columns = ["spend", "visits", "region"]
    response = client.post(
        f"/api/sources/{sid}/groups", json={"columns": columns, "k": 3}
    )
    assert response.status_code == 200
    summary = response.json()

    # ML-EDA を直に呼んだ結果と同じ (群の行, 安定性, まとまり)
    expected = ml_eda.describe_groups(str(file), columns=columns, k=3)
    assert summary["groups"] == expected["groups"]
    assert summary["stability"] == expected["stability"]
    assert summary["silhouette"] == pytest.approx(expected["silhouette"])
    assert summary["method"] == "kmeans" and summary["k"] == 3
    assert summary["columns"] == {
        "numeric": ["spend", "visits"], "categorical": ["region"],
    }

    # 群ごとの行と最後の全体の行. はっきりした群なので安定
    rows = summary["groups"]
    assert [row["rows"] for row in rows[:-1]] == [30, 30, 30]
    assert rows[-1]["group"] == "全体" and rows[-1]["rows"] == ROWS
    assert summary["stability"]["ari"] == pytest.approx(1.0)
    assert summary["silhouette"] > 0.5

    # 乱数の種を変えても同じ形で返す
    other = client.post(
        f"/api/sources/{sid}/groups",
        json={"columns": columns, "k": 3, "seed": 4},
    ).json()
    assert other["seed"] == 4

    # 欠けのある列は気付きに数える
    noted = client.post(
        f"/api/sources/{sid}/groups", json={"columns": ["age"], "k": 2}
    ).json()
    assert any("欠け" in note for note in noted["notes"])


def test_describe_groups_errors(client: TestClient, tmp_path: Path) -> None:
    """
    列と群の数の誤りを, 理由付きの 422 で返すことを確かめる関数

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
    sid = register(client, write_customers(tmp_path))
    url = f"/api/sources/{sid}/groups"

    # 無い列, 同じ列を 2 回, 群の要約の鍵と同じ名前は ML-EDA の理由
    missing = client.post(url, json={"columns": ["nope"], "k": 2})
    assert missing.status_code == 422
    assert "群を作れません" in missing.json()["detail"]
    twice = client.post(url, json={"columns": ["spend", "spend"], "k": 2})
    assert twice.status_code == 422

    # 群の数は 2 から上限まで, 列は 1 つ以上, 知らない欄は断る
    for body in (
        {"columns": ["spend"], "k": 1},
        {"columns": ["spend"], "k": 51},
        {"columns": [], "k": 2},
        {"columns": ["spend"], "k": 2, "labels": "region"},
    ):
        assert client.post(url, json=body).status_code == 422

    # 無いデータは 404
    assert client.post(
        "/api/sources/nope/groups", json={"columns": ["spend"], "k": 2}
    ).status_code == 404


def test_export_groups(client: TestClient, tmp_path: Path) -> None:
    """
    群分けの表を版 2 で書き出し, 一覧に並び, load_items と describe_groups
    で読めることを確かめる関数

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
    sid = register(client, write_customers(tmp_path))
    url = f"/api/sources/{sid}/export_groups"
    body = {
        "columns": ["spend", "visits", "region", "age"], "id": "member",
        "name": "customers_groups",
    }
    response = client.post(url, json=body)
    assert response.status_code == 200
    result = response.json()
    info = result["info"]
    assert info["format_version"] == 2 and info["role"] == "group"
    assert info["target"] == {"kind": "none", "entries": []}
    assert info["entries"]["region"]["kind"] == "class"
    assert info["entries"]["spend"]["kind"] == "value"
    assert info["source"]["id"] == "member"
    assert any("欠け" in note for note in result["notes"])

    # 書き出した表を読み, 学習用と検証用に分かれている
    dataset = ml_eda.load_items(result["path"])
    assert len(dataset.items) == ROWS
    assert set(dataset.items["split"]) == {"train", "valid"}
    assert dataset.items["id"].iloc[0] == "m000"
    summary = ml_eda.describe_groups(dataset, k=3)
    assert summary["rows"] == ROWS

    # データセットの一覧に版 2 として並ぶ
    listed = {item["name"]: item for item in client.get("/api/datasets").json()}
    item = listed["customers_groups"]
    assert item["form"] == "items" and item["role"] == "group"
    assert item["items"] == ROWS

    # 同じ名前は置き換えを指定した場合だけ. 分けない場合は全て学習用
    assert client.post(url, json=body).status_code == 409
    replaced = client.post(url, json={
        **body, "overwrite": True, "split": {"method": "none"},
    })
    assert replaced.status_code == 200
    again = ml_eda.load_items(replaced.json()["path"])
    assert set(again.items["split"]) == {"train"}


def test_export_groups_errors(client: TestClient, tmp_path: Path) -> None:
    """
    書き出しの名前, 列, 分割の誤りを断ることを確かめる関数

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
    sid = register(client, write_customers(tmp_path))
    url = f"/api/sources/{sid}/export_groups"
    base = {"columns": ["spend", "region"], "name": "groups"}

    # 名前に使えない文字, 群を作る列を行を見分ける列にする, 同じ値のある
    # 行を見分ける列は理由付きの 422
    bad_name = client.post(url, json={**base, "name": "../x"})
    assert bad_name.status_code == 422
    assert client.post(
        url, json={**base, "id": "spend"}
    ).status_code == 422
    repeated = client.post(
        url, json={**base, "columns": ["spend"], "id": "region"}
    )
    assert repeated.status_code == 422
    assert "同じ値" in repeated.json()["detail"]

    # グループごとの分割は受け付けない
    assert client.post(
        url, json={**base, "split": {"method": "group"}}
    ).status_code == 422
    assert not (tmp_path / "home" / "datasets" / "groups").exists()
