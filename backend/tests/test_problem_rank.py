import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import ml_eda
import ml_quest
import numpy as np
import pandas as pd
import pytest
import yaml
from fastapi.testclient import TestClient
from ml_quest import example_problem

from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"

# 受け持ちの場所
PART = ml_quest.PART

# 合成の反応の表の列
COLUMNS = ["member", "item_id", "ts", "qty"]

# 合成の反応の表の行の数
ROWS = 400


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """
    一時ディレクトリを置き場 (ML-Pathfinder の置き場も) にしたアプリの
    クライアントを作る関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数の差し替え

    Returns
    ----------
    client: TestClient
        トークンを送るクライアント
    """
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))
    app = create_app(
        data_dir=tmp_path / "home", token=TOKEN, allowed_hosts=["testserver"]
    )
    client = TestClient(app, headers={"x-fathom-token": TOKEN})

    return client


def rank_problem() -> dict[str, Any]:
    """
    見本の課題から, 並べるで学習する受け持ちの問題の設定を作る関数

    Parameters
    ----------
    None

    Returns
    ----------
    problem: dict[str, Any]
        並べるで出力の形が順位, 指標が NDCG で, 反応の表の列と件数に答えた
        問題の設定 (データは入れていない)
    """
    # 1 から 4 と 9, 10 は見本のまま, 受け持ちは作り直し
    problem = example_problem("総菜の作る量")
    problem["ml"]["parts"] = [{}]
    for key in ("decision", "basis", "current"):
        problem["action"].pop(key, None)
    problem = ml_quest.answer(problem, "information.columns", COLUMNS)
    for key, value in [("role", "rank"), ("unit", "query"),
                       ("output", "ranking"),
                       ("target.source", "feedback"), ("method", "scratch"),
                       ("what", "会員ごとに勧める品"),
                       ("item", "会員ごとの品の並び"),
                       ("baseline", "人気順"),
                       ("evaluation.metric", "ndcg"),
                       ("evaluation.link", "上位に買う品が来るほど売上が"
                        "増える"),
                       ("rank.user", "member"), ("rank.item", "item_id"),
                       ("rank.time", "ts"), ("rank.reaction", "qty"),
                       ("rank.k", 5)]:
        problem = ml_quest.answer(problem, f"{PART}.{key}", value)

    return problem


def write_reactions(root: Path) -> Path:
    """
    反応の強さ 0 の行と, 利用者の欠けた行を含む反応の表の CSV を作る関数

    Parameters
    ----------
    root: Path
        書き出す場所

    Returns
    ----------
    path: Path
        CSV のファイル (member, item_id, ts, qty)
    """
    # 決まった乱数. 品物は番号の小さいものほど多く選ぶ
    rng = np.random.default_rng(0)
    items = np.minimum(rng.geometric(0.2, ROWS), 30)
    frame = pd.DataFrame({
        "member": [f"m{value}" for value in rng.integers(0, 40, ROWS)],
        "item_id": [f"i{value}" for value in items],
        "ts": np.arange(ROWS),
        "qty": rng.integers(0, 3, ROWS),
    })
    frame.loc[:2, "member"] = None
    root.mkdir(parents=True, exist_ok=True)
    path = root / "reactions.csv"
    frame.to_csv(path, index=False)

    return path


def problem_place(tmp_path: Path) -> Path:
    """
    ML-Pathfinder の置き場の, 問題の設定のディレクトリを返す関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    path: Path
        problems/rank (一覧に並ぶ場所)
    """
    path = tmp_path / "pathfinder" / "problems" / "rank"

    return path


def saved_problem(
    tmp_path: Path, problem: dict[str, Any]
) -> tuple[Path, Path]:
    """
    反応の表を入れた並べるの問題の設定から ML-Quest でプロジェクトを作り,
    記録とともに保存する関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    problem: dict[str, Any]
        並べるの問題の設定 (データは入れていない)

    Returns
    ----------
    paths: tuple[Path, Path]
        problem.yaml を持つディレクトリと, プロジェクトのディレクトリ
    """
    # 写しを置き, 骨組みの書き出しと, その記録 (project.dataset は config
    # の data.dataset)
    source = write_reactions(tmp_path / "raw")
    problem = ml_quest.attach_data(
        problem, str(source), copy_to=str(tmp_path / "copies")
    )
    project = tmp_path / "project"
    ml_quest.make_project(problem, project)
    problem = ml_quest.record_project(problem, project)
    path = problem_place(tmp_path)
    ml_quest.save_problem(problem, path)
    paths = (path, project)

    return paths


def skeleton_reader(project: Path) -> Any:
    """
    書き出した骨組みの学習のスクリプトから, 反応の表を読む関数を取り出す
    関数

    学習のスクリプトは torch と ML-Found を読み込むので, 読み方の定数と
    read_reactions の定義だけを動かす

    Parameters
    ----------
    project: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    read: Any
        骨組みの read_reactions (path と config を受け取る)
    """
    # 読み方の定数 (LOADER, OPTIONS) と関数の定義だけ
    tree = ast.parse((project / "train.py").read_text("utf-8"))
    nodes = [
        node for node in tree.body
        if (isinstance(node, ast.Assign) and any(
            isinstance(name, ast.Name) and name.id in ("LOADER", "OPTIONS")
            for name in node.targets
        )) or (
            isinstance(node, ast.FunctionDef)
            and node.name == "read_reactions"
        )
    ]
    assert len(nodes) == 3
    scope: dict[str, Any] = {
        "pd": pd, "load_data": ml_eda.load_data, "Path": Path, "Any": Any,
    }
    exec(compile(ast.Module(nodes, []), "train.py", "exec"), scope)
    read = scope["read_reactions"]

    return read


def skeleton_config(project: Path) -> Any:
    """
    骨組みの既定の config を, 属性で読める形で返す関数

    Parameters
    ----------
    project: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    cfg: Any
        data と rank を属性で読める config
    """
    # 骨組みの read_reactions が読む項目だけ
    config = yaml.safe_load(
        (project / "configs" / "default" / "train.yaml").read_text("utf-8")
    )
    cfg = SimpleNamespace(
        data=SimpleNamespace(**config["data"]),
        rank=SimpleNamespace(**config["rank"]),
    )

    return cfg


def test_rank_start_and_export(client: TestClient, tmp_path: Path) -> None:
    """
    並べるの問題の設定から反応の表を登録して要約を見せ, 骨組みが読む場所に
    ファイル 1 つのまま写すことを確かめる関数

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
    # 始められるものとして並び, レシピの無い反応の表として登録する
    path, project = saved_problem(tmp_path, rank_problem())
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [True]
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    body = started.json()
    source = body["source"]
    assert body["form"] is None and body["notes"] == []
    assert source["kind"] == "reactions" and source["loader"] == "csv"
    assert source["target"] is None
    url = f"/api/sources/{source['id']}"

    # 問題の設定の列で要約し, 除いた行と気付きを返す
    result = client.get(f"{url}/reactions")
    assert result.status_code == 200
    reactions = result.json()
    assert reactions["k"] == 5 and reactions["path"] == str(
        path / "problem.yaml"
    )
    summary = reactions["summary"]
    expected = ml_eda.describe_reactions(ml_eda.load_reactions(
        Path(source["path"]), "member", "item_id", "ts", "qty"
    ))
    assert summary["columns"] == expected["columns"]
    assert summary["reactions"] == expected["reactions"]
    assert summary["dropped"] == expected["dropped"]
    assert summary["dropped"]["missing"] == 3
    assert summary["dropped"]["not_positive"] > 0
    assert summary["popularity"]["gini"] > 0
    assert summary["time"]["kind"] == "number"
    assert len(summary["notes"]) == 2

    # 骨組みは入れたデータを data に写しているので, 置き換えの確かめが要る
    place = client.get(f"{url}/project").json()
    target = project / skeleton_config(project).data.dataset
    assert place["dataset"] == str(target) and place["state"] == "file"
    assert place["ready"] is True
    refused = client.post(f"{url}/export_reactions", json={})
    assert refused.status_code == 409

    # 置き換えると元の表をそのまま写し, 骨組みの読み方で同じ数を読める
    target.write_text("member,item_id,ts\n", "utf-8")
    exported = client.post(
        f"{url}/export_reactions", json={"overwrite": True}
    )
    assert exported.status_code == 200
    result = exported.json()
    assert result["path"] == str(target) and result["copied"] is True
    assert result["reactions"] == summary["reactions"]
    assert result["dropped"] == summary["dropped"]["total"]
    assert target.read_bytes() == Path(source["path"]).read_bytes()
    read = skeleton_reader(project)
    frame, notes = read(target, skeleton_config(project))
    assert len(frame) == summary["reactions"] and len(notes) == 2
    assert list(frame.columns) == ["user", "item", "time"]

    # 書き出し先が無ければ, 確かめずに置く
    target.unlink()
    assert client.get(f"{url}/project").json()["state"] == "missing"
    assert client.post(
        f"{url}/export_reactions", json={}
    ).status_code == 200
    assert target.is_file()


def test_rank_refusals(client: TestClient, tmp_path: Path) -> None:
    """
    並べるの問題の設定はレシピの確かめと書き出しを断り, 書き出し先が
    ファイルでないか拡張子が違えば写さないことを確かめる関数

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
    # レシピを持たないので, 確かめ, 書き戻し, レシピの書き出しは 422
    path, project = saved_problem(tmp_path, rank_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    recipe = {"format_version": 1, "task": "none", "steps": []}
    checked = client.post(f"{url}/problem/check", json={"recipe": recipe})
    assert checked.status_code == 422
    assert "レシピを持ちません" in checked.json()["detail"]
    assert client.post(
        f"{url}/export_project", json={"recipe": recipe}
    ).status_code == 422
    pairs = client.get("/api/problems/pairs", params={"path": str(path)})
    assert pairs.status_code == 422 and "並べる" in pairs.json()["detail"]

    # 書き出し先がディレクトリなら置き換えない
    target = project / skeleton_config(project).data.dataset
    target.unlink()
    target.mkdir()
    place = client.get(f"{url}/project").json()
    assert place["state"] == "occupied" and place["ready"] is False
    assert client.post(
        f"{url}/export_reactions", json={"overwrite": True}
    ).status_code == 409
    target.rmdir()

    # 記録の書き出し先の拡張子が違えば写さない
    problem = ml_quest.load_problem(path / "problem.yaml")
    problem["project"]["dataset"] = str(target.with_suffix(".parquet"))
    ml_quest.save_problem(problem, path)
    response = client.post(f"{url}/export_reactions", json={})
    assert response.status_code == 422
    assert "拡張子" in response.json()["detail"]
    assert not target.with_suffix(".parquet").exists()

    # 答え直した列が表に無ければ, 要約も書き出しも 422
    problem["ml"]["parts"][0]["rank"]["time"] = "when"
    ml_quest.save_problem(problem, path)
    for response in (
        client.get(f"{url}/reactions"),
        client.post(f"{url}/export_reactions", json={"overwrite": True}),
    ):
        assert response.status_code == 422
        assert "when" in response.json()["detail"]


def test_rank_not_startable(client: TestClient, tmp_path: Path) -> None:
    """
    データを入れていない並べるの問題の設定は, 理由を付けて始めないことを
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
    # 一覧と始めることの両方で同じ理由
    path = problem_place(tmp_path)
    ml_quest.save_problem(rank_problem(), path)
    listed = client.get("/api/problems").json()["problems"]
    assert listed[0]["startable"] is False
    assert "データが入っていません" in listed[0]["reason"]
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    assert response.json()["detail"] == listed[0]["reason"]
    assert client.get("/api/sources").json() == []

    # 時刻の列が日時として読めなければ, 登録しない
    raw = write_reactions(tmp_path / "raw")
    frame = pd.read_csv(raw)
    frame["ts"] = "unknown"
    frame.to_csv(raw, index=False)
    problem = ml_quest.attach_data(rank_problem(), str(raw))
    ml_quest.save_problem(problem, path)
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    assert "反応の表として読めません" in response.json()["detail"]
    assert client.get("/api/sources").json() == []
