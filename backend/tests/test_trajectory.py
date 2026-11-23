import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"

# 守りの付いた軌跡 (2 つのエピソード. どちらも守りで止めて終わる)
GUARDED_CSV = """episode,step,obs_0,action,reward,terminated,truncated,seed,guard,guard_reasons
0,0,0.0,1,1.0,false,false,7,ok,
0,1,1.0,1,1.0,false,false,7,ok,
0,2,2.0,,,false,false,7,stop,観測の要素 0 が範囲の外 (2)
1,0,0.0,0,0.5,false,false,8,ok,
1,1,nan,1,1.0,true,false,8,ok,
"""


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


def write_guarded(path: Path, described: bool = True) -> Path:
    """
    守りの付いた軌跡の表 (と説明) を書く関数

    Parameters
    ----------
    path: Path
        ディレクトリ
    described: bool = True
        説明の <名前>.json も書くか

    Returns
    ----------
    file: Path
        書いた表
    """
    file = path / "guarded.csv"
    file.write_text(GUARDED_CSV, encoding="utf-8")
    if described:
        info = {
            "format_version": 1, "name": "guarded", "file": "guarded.csv",
            "source": "evaluate_policy", "epoch": 3,
            "action_space": {"type": "discrete", "n": 2, "start": 0},
            "guarded": True, "episodes": 2, "rows": 5, "complete": True,
            "dropped_episodes": 0,
        }
        (path / "guarded.json").write_text(json.dumps(info), "utf-8")

    return file


def test_detect_trajectory_first(client: TestClient, tmp_path: Path) -> None:
    """
    軌跡の表と説明の候補の先頭が軌跡で, 普通の表には軌跡の候補が無い
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
    # 表と説明のどちらを選んでも軌跡が先頭. 表としても読める
    file = write_guarded(tmp_path)
    for path in (file, tmp_path / "guarded.json"):
        candidates = client.post(
            "/api/detect", json={"path": str(path)}
        ).json()
        assert candidates[0]["loader"] == "trajectory"
        assert candidates[0]["kind"] == "trajectory"
        assert len(candidates) > 1

    # 列の決まりに合わない表と, 見出しの合わない表は軌跡の候補を出さない
    broken = tmp_path / "broken.csv"
    broken.write_text("episode,step,reward\n0,0,1.0\n", "utf-8")
    plain = tmp_path / "plain.csv"
    plain.write_text("a,b\n1,2\n", "utf-8")
    for path in (broken, plain):
        candidates = client.post(
            "/api/detect", json={"path": str(path)}
        ).json()
        assert all(c["loader"] != "trajectory" for c in candidates)


def test_trajectory_summary(client: TestClient, tmp_path: Path) -> None:
    """
    軌跡を登録すると, ML-EDA の要約を返し, 表の分析の API は断ることを
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
    # 読み込みを渡さなくても軌跡として登録する
    file = write_guarded(tmp_path)
    created = client.post("/api/sources", json={"path": str(file)})
    assert created.status_code == 201
    source = created.json()
    assert source["loader"] == "trajectory"
    assert source["kind"] == "trajectory"
    assert source["options"] == {} and source["target"] is None

    # 要約は describe_trajectory のまま. nan は欠けに数えない
    sid = source["id"]
    summary = client.get(f"/api/sources/{sid}/trajectory").json()
    assert summary["described"] and summary["epoch"] == 3
    assert summary["episodes"] == 2 and summary["steps"] == 4
    assert summary["ends"]["stop"] == 1
    assert summary["ends"]["terminated"] == 1
    assert summary["guard"]["results"] == {"ok": 4, "stop": 1}
    assert summary["guard"]["reasons"][0]["count"] == 1
    obs = summary["observations"][0]
    assert obs["missing"] == 0 and obs["nan"] == 1
    assert summary["actions"][0]["missing"] == 1
    assert summary["per_episode"][0]["end"] == "stop"
    assert summary["per_episode_truncated"] is False

    # 表の分析と目的の列は軌跡では使わない
    assert client.get(f"/api/sources/{sid}/profile").status_code == 422
    assert client.get(f"/api/sources/{sid}/rows").status_code == 422
    assert client.patch(
        f"/api/sources/{sid}", json={"target": "reward"}
    ).status_code == 422


def test_trajectory_reread(client: TestClient, tmp_path: Path) -> None:
    """
    隣の説明が変われば読み直し, 表が消えれば 404 を返すことを確かめる
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
    # 説明の無い表を登録してから説明を足す
    file = write_guarded(tmp_path, described=False)
    sid = client.post(
        "/api/sources", json={"path": str(file), "loader": "trajectory"}
    ).json()["id"]
    first = client.get(f"/api/sources/{sid}/trajectory").json()
    assert first["described"] is False and first["epoch"] is None
    write_guarded(tmp_path)
    second = client.get(f"/api/sources/{sid}/trajectory").json()
    assert second["described"] is True and second["epoch"] == 3

    # 表が消えた場合
    file.unlink()
    (tmp_path / "guarded.json").unlink()
    assert client.get(f"/api/sources/{sid}/trajectory").status_code == 404


def test_trajectory_errors(client: TestClient, tmp_path: Path) -> None:
    """
    軌跡として読めない表の登録と, 軌跡でないデータの要約を断ることを
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
    # 列の決まりに合わない表は, ML-EDA の理由を付けて 422
    broken = tmp_path / "broken.csv"
    broken.write_text("episode,step,reward\n0,0,1.0\n", "utf-8")
    response = client.post(
        "/api/sources", json={"path": str(broken), "loader": "trajectory"}
    )
    assert response.status_code == 422
    assert "軌跡を読み込めませんでした" in response.json()["detail"]

    # 普通の表のデータの軌跡の要約は 422
    plain = tmp_path / "plain.csv"
    plain.write_text("a,b\n1,2\n3,4\n", "utf-8")
    sid = client.post("/api/sources", json={"path": str(plain)}).json()["id"]
    assert client.get(f"/api/sources/{sid}/trajectory").status_code == 422
