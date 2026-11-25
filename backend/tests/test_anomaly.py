from pathlib import Path
from typing import Any, Optional

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

# 合成の表の正常の行と異常の行の数
NORMAL = 90
ANOMALIES = 10

# ML-Quest が異常の検知の問題の設定を扱えるか (扱えなければ, ML-Quest の
# 本物の問題の設定で通す確かめを飛ばす)
QUEST_ANOMALY = any(
    item["value"] == "anomaly" for item in ml_quest.TARGET_KINDS
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


def write_readings(root: Path, labeled: bool = True) -> Path:
    """
    正常の行と少しの異常の行の, 合成のセンサの表の CSV を作る関数

    Parameters
    ----------
    root: Path
        書き出す場所
    labeled: bool = True
        異常の行にだけ印 (is_anomaly が 1. 正常の行は空) を付けるか (付け
        なければ is_anomaly の列を作らない)

    Returns
    ----------
    path: Path
        CSV のファイル (reading_id, temp, vibration, is_anomaly)
    """
    # 決まった乱数. 異常の行は振動が大きい
    rng = np.random.default_rng(0)
    rows = NORMAL + ANOMALIES
    broken = np.arange(rows) >= NORMAL
    frame = pd.DataFrame({
        "reading_id": [f"r{index:03d}" for index in range(rows)],
        "temp": rng.normal(50, 5, rows).round(2),
        "vibration": (rng.normal(2, 0.2, rows) + 5 * broken).round(3),
    })
    if labeled:
        frame["is_anomaly"] = np.where(broken, 1.0, np.nan)
    root.mkdir(parents=True, exist_ok=True)
    path = root / "readings.csv"
    frame.to_csv(path, index=False)

    return path


def anomaly_recipe(
    target: Optional[str] = "is_anomaly", unlabeled: Optional[str] = "normal"
) -> dict[str, Any]:
    """
    ML-EDA の異常の検知の表のレシピを作る関数

    Parameters
    ----------
    target: Optional[str] = "is_anomaly"
        異常の正解の列 (None なら書かない)
    unlabeled: Optional[str] = "normal"
        正解の欠けた行の扱い (None なら書かない)

    Returns
    ----------
    recipe: dict[str, Any]
        行の id の列, 標準化と無作為の分割のレシピ
    """
    # ML-Quest の recipe_from の雛形と同じ形
    split: dict[str, Any] = {"method": "random", "valid": 0.2, "test": 0.1,
                             "seed": 0}
    if unlabeled:
        split["unlabeled"] = unlabeled
    recipe: dict[str, Any] = {"format_version": 1, "task": "anomaly",
                              "target": target, "id": "reading_id",
                              "steps": [{"op": "standardize",
                                         "columns": "auto"}],
                              "split": split}

    return recipe


def anomaly_part(problem: dict[str, Any]) -> dict[str, Any]:
    """
    問題の設定の受け持ちを異常の検知にする関数

    ML-Quest の答えの確かめを通さずに受け持ちの答えを書く (異常の検知を
    知らない ML-Quest でも, この画面の見分けを確かめるため)

    Parameters
    ----------
    problem: dict[str, Any]
        問題の設定 (版 2)

    Returns
    ----------
    problem: dict[str, Any]
        受け持ちが予測するで, 正解の種類が異常の問題の設定
    """
    # 版 2 の受け持ちの答え
    problem["ml"]["parts"] = [{
        "role": "predict", "unit": "row", "output": "value",
        "method": "scratch",
        "target": {"source": "few", "kind": "anomaly"},
    }]

    return problem


def test_preview_and_export(client: TestClient, tmp_path: Path) -> None:
    """
    異常の検知のレシピの前処理の様子と書き出しの結果, データセットの一覧
    が, 正解の有る無しと分割ごとの行の数を返すことを確かめる関数

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
    # 異常の行にだけ印を付けた表 (正常は正常と見なした行)
    file = write_readings(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    url = f"/api/sources/{sid}"
    recipe = anomaly_recipe()
    previewed = client.post(f"{url}/preview", json={"recipe": recipe,
                                                    "upto": 1})
    assert previewed.status_code == 200
    body = previewed.json()
    anomaly = body["anomaly"]
    assert anomaly["id"] == "reading_id" and anomaly["labeled"] is True
    assert anomaly["unlabeled"] == "normal"
    rows = anomaly["rows"]
    assert sum(split["anomaly"] for split in rows.values()) == ANOMALIES
    assert sum(split["presumed"] for split in rows.values()) == NORMAL
    assert rows["train"]["anomaly"] == 0
    assert "reading_id" not in body["features"]

    # 書き出しの説明にも同じ数があり, 一覧も説明の anomaly を返す
    exported = client.post(f"{url}/export", json={
        "recipe": recipe, "name": "readings"
    })
    assert exported.status_code == 200
    assert exported.json()["info"]["anomaly"] == anomaly
    assert exported.json()["hints"]["outputs"] == 2
    listed = client.get("/api/datasets").json()
    assert [item["anomaly"] for item in listed] == [anomaly]
    assert listed[0]["task"] == "anomaly"


def test_preview_other_task(client: TestClient, tmp_path: Path) -> None:
    """
    異常の検知でないレシピと, 異常の検知の決まりに合わないレシピの前処理
    の様子を確かめる関数

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
    # 分類では anomaly が None で, 一覧も None
    file = write_readings(tmp_path / "raw")
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    url = f"/api/sources/{sid}"
    recipe = {"format_version": 1, "task": "classification",
              "target": "is_anomaly", "steps": [],
              "split": {"method": "random", "valid": 0.2, "test": 0.1}}
    body = client.post(f"{url}/preview", json={"recipe": recipe,
                                               "upto": 0}).json()
    assert body["anomaly"] is None
    client.post(f"{url}/export", json={"recipe": recipe, "name": "plain"})
    assert [item["anomaly"] for item in client.get("/api/datasets").json()
            ] == [None]

    # 異常の検知の無作為でない分割と, 他のタスクの normal は ML-EDA の誤り
    wrong = anomaly_recipe()
    wrong["split"]["method"] = "stratified"
    assert client.post(f"{url}/preview", json={
        "recipe": wrong, "upto": 1
    }).status_code == 422
    normal = {**recipe, "split": {**recipe["split"], "unlabeled": "normal"}}
    assert client.post(f"{url}/preview", json={
        "recipe": normal, "upto": 0
    }).status_code == 422


def test_is_anomaly() -> None:
    """
    異常の検知の受け持ちの見分けを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 既製のモデルをそのまま使うものと, 他の正解の種類は異常の検知でない
    problem = anomaly_part(ml_quest.example_problem("解約の引き止め"))
    assert problems.is_anomaly(problem)
    problem["ml"]["parts"][0]["method"] = "pretrained"
    assert not problems.is_anomaly(problem)
    problem["ml"]["parts"][0].update(
        method="scratch", target={"source": "few", "kind": "column"}
    )
    assert not problems.is_anomaly(problem)


def start_with(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    data: Path, recipe: dict[str, Any]
) -> Any:
    """
    ML-Quest の受け渡しの異常の検知のレシピの雛形で, 問題の設定から始める
    関数

    ML-Quest が異常の検知を扱わない場合も, 受け渡しの形 (recipe_from の
    レシピと load) で始める流れを確かめるため, 問題の設定の読み込みと
    recipe_from を差し替える

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        差し替え
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
    problem = anomaly_part(ml_quest.example_problem("解約の引き止め"))
    problem.update(name="センサの異常", created_at="2000-01-01T00:00:00")
    path = tmp_path / "problem" / "problem.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump(problem, allow_unicode=True), "utf-8")
    monkeypatch.setattr(problems, "read_problem", lambda _: problem)
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
    異常の検知の受け渡しのレシピで始めると, 正解の列を目的の列にして
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
    # 正解の列が目的の列, レシピは受け渡しのまま
    recipe = anomaly_recipe()
    started = start_with(client, tmp_path, monkeypatch,
                         write_readings(tmp_path / "raw"), recipe)
    assert started.status_code == 201
    body = started.json()
    assert body["form"] is None and body["tab"] is None
    assert body["source"]["target"] == "is_anomaly"
    assert body["source"]["kind"] == "table"
    saved = client.get(f"/api/sources/{body['source']['id']}/recipe").json()
    assert saved["task"] == "anomaly" and saved["id"] == "reading_id"
    assert saved["split"]["unlabeled"] == "normal"


def test_start_unlabeled(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    正解の列の無い異常の検知の問題の設定は, 目的の列を持たずに始めること
    を確かめる関数

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
    # 正解の無い表は全ての行を正常と見なす
    recipe = anomaly_recipe(target=None, unlabeled=None)
    del recipe["target"]
    started = start_with(client, tmp_path, monkeypatch,
                         write_readings(tmp_path / "raw", labeled=False),
                         recipe)
    assert started.status_code == 201
    source = started.json()["source"]
    assert source["target"] is None
    anomaly = client.post(f"/api/sources/{source['id']}/preview", json={
        "recipe": recipe, "upto": 1
    }).json()["anomaly"]
    assert anomaly["labeled"] is False
    assert sum(split["presumed"] for split in anomaly["rows"].values()) == (
        NORMAL + ANOMALIES
    )


@pytest.mark.parametrize("key", ["target", "id"])
def test_start_missing_column(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    key: str
) -> None:
    """
    答えた正解の列か行の id の列が表に無ければ, 登録せずに理由を返す
    ことを確かめる関数

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
    recipe = {**anomaly_recipe(), key: "missing_column"}
    started = start_with(client, tmp_path, monkeypatch,
                         write_readings(tmp_path / "raw"), recipe)
    assert started.status_code == 422
    assert "missing_column" in started.json()["detail"]
    assert client.get("/api/sources").json() == []


def test_start_not_table(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    表でないデータを入れた異常の検知の問題の設定は, 登録せずに理由を返す
    ことを確かめる関数

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
    recipe = {**anomaly_recipe(target=None, unlabeled=None), "target": None}
    del recipe["id"]
    started = start_with(client, tmp_path, monkeypatch, root, recipe)
    assert started.status_code == 422
    assert "表ではありません" in started.json()["detail"]
    assert client.get("/api/sources").json() == []


def quest_problem(tmp_path: Path, data: Path) -> tuple[Path, Path]:
    """
    ML-Quest で異常の検知の問題の設定を作り, データを入れてプロジェクトを
    作って, ML-Pathfinder の置き場に保存する関数

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
        ["reading_id", "temp", "vibration", "is_anomaly"]
    )
    for key, value in [
        ("role", "predict"), ("unit", "row"), ("output", "value"),
        ("target.source", "few"), ("method", "scratch"),
        ("target.kind", "anomaly"), ("what", "機械の異常の度合い"),
        ("item", "1 回の計測"), ("baseline", "決まった値を超えたら"),
        ("anomaly.id", "reading_id"),
        ("anomaly.columns", ["temp", "vibration"]),
        ("anomaly.label", "is_anomaly"), ("anomaly.score", "autoencoder"),
        ("anomaly.capacity", 5), ("evaluation.metric", "average_precision"),
        ("evaluation.link", "上位に異常が多いほど見逃しが減る"),
    ]:
        problem = ml_quest.answer(problem, f"{PART}.{key}", value)
    problem = ml_quest.attach_data(problem, str(data))
    project = tmp_path / "project"
    ml_quest.make_project(problem, project)
    problem = ml_quest.record_project(problem, project)
    path = tmp_path / "pathfinder" / "problems" / "sensor"
    ml_quest.save_problem(problem, path)
    paths = (path, project)

    return paths


@pytest.mark.skipif(not QUEST_ANOMALY,
                    reason="ML-Quest が異常の検知の問題の設定を扱わない")
def test_quest_anomaly(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    ML-Quest の異常の検知の問題の設定から始め, 書き戻して, 約束のとおりの
    データセットをプロジェクトへ書き出すことを確かめる関数

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
    # 一覧で始められ, 正解の列を目的の列にして始まる
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))
    path, project = quest_problem(tmp_path, write_readings(tmp_path / "raw"))
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [True]
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    source = started.json()["source"]
    assert source["target"] == "is_anomaly"
    url = f"/api/sources/{source['id']}"
    recipe = client.get(f"{url}/recipe").json()
    assert recipe["task"] == "anomaly" and recipe["id"] == "reading_id"
    assert recipe["split"]["unlabeled"] == "normal"

    # 食い違いの誤りが無く書き戻せ, 分割を変えると誤り
    result = client.post(f"{url}/problem/check", json={
        "recipe": recipe
    }).json()
    assert [item for item in result["conflicts"]
            if item["level"] == "error"] == []
    assert client.post(f"{url}/problem/write", json={
        "recipe": recipe, "version": result["version"]
    }).status_code == 200
    problem = ml_quest.load_problem(path / "problem.yaml")
    assert ml_quest.get_value(problem, "data.recipe")["task"] == "anomaly"

    # プロジェクトへ書き出すと異常の検知の表で, 学習用は正常の行だけ
    exported = client.post(f"{url}/export_project", json={"recipe": recipe})
    assert exported.status_code == 200
    dataset = ml_eda.load_dataset(Path(exported.json()["path"]))
    assert dataset.info["task"] == "anomaly"
    rows = dataset.info["anomaly"]["rows"]
    assert rows["train"]["anomaly"] == 0
    assert sum(split["anomaly"] for split in rows.values()) == ANOMALIES
    assert Path(exported.json()["path"]).is_relative_to(project)
