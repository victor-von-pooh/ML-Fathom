import copy
import hashlib
from collections.abc import Callable
from pathlib import Path
from typing import Any

import ml_eda
import ml_quest
import pytest
import yaml
from fastapi.testclient import TestClient
from ml_eda.synthetic import write_image_masks, write_shape_captures
from ml_quest import example_problem

from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"

# 正解の種類ごとの, 受け持ちの答え
KIND_ANSWERS = {
    "mask": [("unit", "pair"), ("output", "region"),
             ("target.source", "process"),
             ("target.process.name", "今の塗り分け"),
             ("method", "scratch"), ("target.kind", "mask"),
             ("evaluation.metric", "iou")],
    "point_cloud": [("unit", "bundle"), ("output", "shape"),
                    ("target.source", "files"), ("method", "scratch"),
                    ("target.kind", "point_cloud"),
                    ("evaluation.metric", "chamfer")],
}

# 正解の種類ごとの, 画面の欄と ML-EDA の書き出し
FORMS = {"mask": ("image_masks", "export_image_masks"),
         "point_cloud": ("capture_clouds", "export_capture_clouds")}

# 正解の種類ごとの, 書き出しにかける中身の手順
KIND_STEPS = {
    "mask": {"image": [{"op": "resize", "width": 8, "height": 8}]},
    "point_cloud": {
        "capture": [{"op": "resize", "width": 8, "height": 8}],
        "cloud": [{"op": "sample_points", "points": 32}],
    },
}


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """
    一時ディレクトリを置き場にしたアプリのクライアントを作る関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        ML-Pathfinder の置き場の環境変数の差し替え

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


def write_kind_problem(
    tmp_path: Path, kind: str, project: bool = True
) -> Path:
    """
    合成の見本のファイルの組を入れた, 予測するのファイルの組の問題の設定を
    ML-Pathfinder の置き場に保存する関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    kind: str
        正解の種類 (mask か point_cloud)
    project: bool = True
        プロジェクトの記録を付けるか

    Returns
    ----------
    path: Path
        problem.yaml を持つディレクトリ
    """
    # 合成の見本 (画像と領域か, 撮影と点群) を書く
    raw = tmp_path / "raw"
    if kind == "mask":
        write_image_masks(raw, count=8, size=(16, 16))
    else:
        write_shape_captures(raw, count=6, views=3, size=(16, 16),
                             points=64)

    # 見本の課題の受け持ちを作り直し, 見本のディレクトリを入れる
    problem = example_problem("総菜の作る量")
    problem["ml"]["parts"] = [{}]
    for key in ("decision", "basis", "current"):
        problem["action"].pop(key, None)
    problem = ml_quest.answer(problem, "ml.parts.0.role", "predict")
    for key, value in [("what", "画素ごとの領域"), ("item", "1 枚"),
                       ("baseline", "今のやり方"),
                       ("evaluation.link", "良くなると損が減る"),
                       *KIND_ANSWERS[kind]]:
        problem = ml_quest.answer(problem, f"ml.parts.0.{key}", value)
    problem = ml_quest.attach_data(problem, raw)
    problem["name"] = f"{kind} の問題"
    if project:
        place = tmp_path / "project"
        place.mkdir()
        problem["project"] = {
            "path": str(place),
            "dataset": str(place / "outputs" / "dataset"),
        }
    path = tmp_path / "pathfinder" / "problems" / kind
    ml_quest.save_problem(problem, path)

    return path


def current(path: Path) -> str:
    """
    問題の設定のファイルの今の中身の印を返す関数

    Parameters
    ----------
    path: Path
        problem.yaml を持つディレクトリ

    Returns
    ----------
    version: str
        中身の sha256
    """
    # 書き出すときに送り返す印と同じ
    version = hashlib.sha256(
        (path / "problem.yaml").read_bytes()
    ).hexdigest()

    return version


def export_body(path: Path, draft: dict[str, Any]) -> dict[str, Any]:
    """
    下書きのまま書き出す要求を作る関数

    Parameters
    ----------
    path: Path
        problem.yaml を持つディレクトリ
    draft: dict[str, Any]
        GET /api/problems/pairs の結果

    Returns
    ----------
    body: dict[str, Any]
        書き出しの要求
    """
    # 検証用とテスト用を必ず作る割合
    export = copy.deepcopy(draft["export"])
    export["split"].update(valid=0.25, test=0.25)
    body = {"path": str(path), "version": draft["version"],
            "export": export}

    return body


@pytest.mark.parametrize("kind", ["mask", "point_cloud"])
def test_start_and_export(
    client: TestClient, tmp_path: Path, kind: str
) -> None:
    """
    ファイルの組の受け持ちの問題の設定から始め, プロジェクトへ書き出して
    書き戻すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    kind: str
        正解の種類

    Returns
    ----------
    None
    """
    # 一覧で始められ, 始めるとデータを登録せずに書き出しの画面の欄を返す
    path = write_kind_problem(tmp_path, kind)
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [True]
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    form, function = FORMS[kind]
    assert started.json()["source"] is None
    assert started.json()["form"] == form
    assert client.get("/api/sources").json() == []

    # 下書き: 入れた見本のディレクトリと, 書き出し先の様子
    draft = client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json()
    assert draft["form"] == form and draft["notes"] == []
    raw = tmp_path / "raw"
    inputs, targets = {"mask": ("images", "masks"),
                       "point_cloud": ("captures", "clouds")}[kind]
    assert draft["export"]["function"] == function
    assert draft["export"]["inputs"] == str(raw / inputs)
    assert draft["export"]["targets"] == str(raw / targets)
    assert draft["project"]["ready"] is True
    assert draft["project"]["state"] == "missing"

    # 書き出すと, プロジェクトの書き出し先に版 2 のデータセットができ,
    # 問題の設定に設定が書き戻る
    body = export_body(path, draft)
    response = client.post("/api/problems/pairs/export", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    target = tmp_path / "project" / "outputs" / "dataset"
    assert result["path"] == str(target)
    assert result["changes"] and result["conflicts"] == []
    assert result["version"] == current(path)
    assert ml_eda.load_items(target).info["target"]["kind"] == kind
    # モデルに要るものも, 開いた親を通して読んだ ML-EDA の model_inputs
    assert result["model"] == ml_eda.model_inputs(target)
    assert result["model"]["target_kind"] == kind
    assert result["model_error"] is None
    saved = ml_quest.load_problem(path)
    assert saved["data"]["export"]["split"]["valid"] == 0.25
    assert ml_quest.handoff(saved)["data"]["split"] == "random"

    # 書き戻した問題の設定から ML-Quest が書き出す骨組みは, このデータ
    # セットを読む
    project = tmp_path / "project"
    ml_quest.make_project(saved, project, overwrite=True)
    config = yaml.safe_load(
        (project / "configs/default/train.yaml").read_text(encoding="utf-8")
    )
    assert (project / config["data"]["dataset"]).resolve() == (
        target.resolve()
    )

    # 開き直すと書き戻した設定で, データセットの一覧にプロジェクトとして
    # 並ぶ
    again = client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json()
    assert again["export"] == saved["data"]["export"]
    assert again["project"]["state"] == "dataset"
    datasets = client.get("/api/datasets").json()
    assert [(item["path"], item.get("project"), item.get("project_from"))
            for item in datasets] == [
        (str(target), f"{kind} の問題", "problem")
    ]

    # 2 回目は置き換えの印が要る
    body = export_body(path, again)
    assert client.post(
        "/api/problems/pairs/export", json=body
    ).status_code == 409
    body["overwrite"] = True
    assert client.post(
        "/api/problems/pairs/export", json=body
    ).status_code == 200

    # 中身の手順は書き出しの設定の他の引数に入れ, 書き出しにかけ (版 3),
    # 問題の設定にも書き戻す
    body["version"] = current(path)
    body["export"]["options"]["item_steps"] = KIND_STEPS[kind]
    response = client.post("/api/problems/pairs/export", json=body)
    assert response.status_code == 200, response.text
    info = response.json()["info"]
    assert info["format_version"] == 3
    for name, steps in KIND_STEPS[kind].items():
        assert info["entries"][name]["steps"] == steps
    # 中身の手順の後の形 (画像は 8 × 8, 点群は 32 点)
    model = response.json()["model"]
    if kind == "mask":
        assert model["inputs"][0]["shape"][-2:] == [8, 8]
    else:
        assert model["outputs"] == 32
    saved = ml_quest.load_problem(path)
    options = saved["data"]["export"]["options"]
    assert options["item_steps"] == KIND_STEPS[kind]

    # 開き直すと下書きに書き戻した手順が入り, そのまま書き出し直せる
    again = client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json()
    assert again["export"]["options"]["item_steps"] == KIND_STEPS[kind]
    body = export_body(path, again)
    body["overwrite"] = True
    response = client.post("/api/problems/pairs/export", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["info"]["format_version"] == 3

    # 手順を外すと版 2 に戻り, 問題の設定からも消える
    body = export_body(path, client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json())
    body["overwrite"] = True
    del body["export"]["options"]["item_steps"]
    response = client.post("/api/problems/pairs/export", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["info"]["format_version"] == 2
    saved = ml_quest.load_problem(path)
    assert "item_steps" not in saved["data"]["export"]["options"]


def test_export_follow_links(client: TestClient, tmp_path: Path) -> None:
    """
    プロジェクトへの書き出しで, 外を指すリンクの先を既定では写さず,
    follow_links が真ならプロジェクトの書き出し先に写し, 問題の設定には
    書き戻さないことを確かめる関数

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
    # 画像を 1 枚外に動かし, 元の場所に外を指すリンクを置く
    path = write_kind_problem(tmp_path, "mask")
    outside = tmp_path / "shared"
    outside.mkdir()
    image = tmp_path / "raw" / "images" / "sample_000.png"
    image.rename(outside / image.name)
    image.symlink_to(outside / image.name)
    draft = client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json()
    url = "/api/problems/pairs/export"
    target = tmp_path / "project" / "outputs" / "dataset"

    # 既定は除いて, 数と例を注意に出す
    response = client.post(url, json=export_body(path, draft))
    assert response.status_code == 200, response.text
    result = response.json()
    assert any("外を指すリンク" in note for note in result["notes"])
    assert sum(split["items"] for split in result["info"]["splits"].values()
               ) == 7

    # 選べば写す. 書き出し先はプロジェクトの中のまま, 印は書き戻さない
    body = export_body(path, draft)
    body.update(version=current(path), overwrite=True, follow_links=True)
    response = client.post(url, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["path"] == str(target)
    assert not any("外を指すリンク" in note for note in result["notes"])
    assert sum(split["items"] for split in result["info"]["splits"].values()
               ) == 8
    assert not any(item.is_symlink() for item in target.rglob("*"))
    saved = ml_quest.load_problem(path)["data"]["export"]
    assert "follow_links" not in saved
    assert "follow_links" not in saved["options"]

    # 書き出しの設定の他の引数には持てない (ML-Quest が断る)
    body = export_body(path, draft)
    body.update(version=current(path), overwrite=True)
    body["export"]["options"]["follow_links"] = True
    response = client.post(url, json=body)
    assert response.status_code == 422
    assert "follow_links" in response.json()["detail"]

def test_export_refusals(client: TestClient, tmp_path: Path) -> None:
    """
    書き出せない場合に, 書き出さず書き戻さないことを確かめる関数

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
    # 正解の種類に合わない書き出しと, グループの無いグループごとの分割
    path = write_kind_problem(tmp_path, "mask")
    draft = client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json()
    before = current(path)
    url = "/api/problems/pairs/export"
    body = export_body(path, draft)
    body["export"]["function"] = "export_capture_clouds"
    response = client.post(url, json=body)
    assert response.status_code == 409
    assert "で書き出します" in response.json()["detail"]
    body = export_body(path, draft)
    body["export"]["split"]["method"] = "group"
    assert client.post(url, json=body).status_code == 409

    # 形の誤り, 正解のディレクトリが無い, 読めないディレクトリは 422
    body = export_body(path, draft)
    body["export"]["name"] = "x"
    assert client.post(url, json=body).status_code == 422
    body = export_body(path, draft)
    body["export"]["targets"] = None
    response = client.post(url, json=body)
    assert response.status_code == 422
    assert "ディレクトリ" in response.json()["detail"]
    body = export_body(path, draft)
    body["export"]["targets"] = str(tmp_path / "nowhere")
    assert client.post(url, json=body).status_code == 422

    # 上限を超えた手順の引数は, 書き戻しも書き出しもせずに 422
    body = export_body(path, draft)
    body["export"]["options"]["item_steps"] = {
        "image": [{"op": "resize", "width": 4097, "height": 8}],
    }
    response = client.post(url, json=body)
    assert response.status_code == 422
    assert "4096 以下" in response.json()["detail"]
    assert current(path) == before

    # 確かめた後に変わった問題の設定は 409
    body = export_body(path, draft)
    body["version"] = "0" * 64
    response = client.post(url, json=body)
    assert response.status_code == 409
    assert current(path) == before
    assert not (tmp_path / "project" / "outputs").exists()

    # 書き出し先がデータセットでなければ置き換えない
    (tmp_path / "project" / "outputs" / "dataset").mkdir(parents=True)
    body = export_body(path, draft)
    body["overwrite"] = True
    response = client.post(url, json=body)
    assert response.status_code == 409
    assert "データセットではない" in response.json()["detail"]
    assert current(path) == before


@pytest.mark.parametrize("when, word", [
    ("check", "外を指すように替わった"), ("walk", "シンボリックリンク"),
], ids=["check", "walk"])
def test_export_swapped(
    client: TestClient, tmp_path: Path,
    swap_after_check: Callable[[Path, Path, str], None]
, when: str, word: str
) -> None:
    """
    確かめの後に書き出し先の途中が外を指すリンクに替わっても, 理由付きの
    422 で断り, 外にも書きかけにも何も残さず, 書き戻さないことを確かめる
    関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    swap_after_check: Callable[[Path, Path, str], None]
        確かめの後に途中の場所をリンクに替える差し替え
    when: str
        替える時 (check は確かめの後, walk は途中を一段ずつ開く間)
    word: str
        断りの文に入る言葉

    Returns
    ----------
    None
    """
    # 書き出し先 outputs/dataset の outputs を, 確かめの後に替える
    path = write_kind_problem(tmp_path, "mask")
    draft = client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json()
    before = current(path)
    outside = tmp_path / "outside"
    outside.mkdir()
    swap_after_check(tmp_path / "project" / "outputs", outside, when)

    # 理由付きで断り, 外に書かず, 問題の設定も変えない
    body = export_body(path, draft)
    body["overwrite"] = True
    refused = client.post("/api/problems/pairs/export", json=body)
    assert refused.status_code == 422
    assert word in refused.json()["detail"]
    assert list(outside.iterdir()) == []
    assert current(path) == before


@pytest.mark.parametrize("when", ["frame", "finish"])
@pytest.mark.parametrize("kind", ["mask", "point_cloud"])
def test_export_while_writing(
    client: TestClient, tmp_path: Path,
    swap_while_writing: Callable[[Path, Path, str], None], kind: str,
    when: str
) -> None:
    """
    ML-EDA がファイルの組を書き出している最中か入れ替えの直前に書き出し
    先の途中が外を指すリンクに替わっても, プロジェクトの外に書かず, 開いた
    親に書くことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    swap_while_writing: Callable[[Path, Path, str], None]
        途中の場所をリンクに替える差し替え
    kind: str
        正解の種類
    when: str
        替える時 (表を書く時か, 入れ替えの直前)

    Returns
    ----------
    None
    """
    # 書き出し先 outputs/dataset の outputs の, 書いている最中の差し替え
    path = write_kind_problem(tmp_path, kind)
    draft = client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json()
    outputs = tmp_path / "project" / "outputs"
    outputs.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    swap_while_writing(outputs, outside, when)

    # 外の空と, 開いた親 (退けた元の outputs) への書き込みの確かめ
    response = client.post(
        "/api/problems/pairs/export", json=export_body(path, draft)
    )
    assert response.status_code == 200, response.text
    assert outputs.is_symlink()
    assert list(outside.iterdir()) == []
    moved = outputs.with_name("outputs.moved")
    assert "dataset" in [item.name for item in moved.iterdir()]
    assert ml_eda.load_items(moved / "dataset").info["target"]["kind"] == (
        kind
    )


def test_without_project_and_column(
    client: TestClient, tmp_path: Path
) -> None:
    """
    プロジェクトの記録が無い問題の設定と列の予測の問題の設定を確かめる
    関数

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
    # 記録が無ければ下書きは出し, 書き出せない理由を返す
    path = write_kind_problem(tmp_path, "mask", project=False)
    draft = client.get(
        "/api/problems/pairs", params={"path": str(path)}
    ).json()
    assert draft["project"]["ready"] is False
    assert "ML-Pathfinder" in draft["project"]["reason"]
    response = client.post("/api/problems/pairs/export",
                           json=export_body(path, draft))
    assert response.status_code == 422
    assert ml_quest.load_problem(path).get("data", {}).get("export") is None

    # 列の予測はデータの画面から始める
    column = tmp_path / "column"
    ml_quest.save_problem(example_problem("総菜の作る量"), column)
    response = client.get("/api/problems/pairs",
                          params={"path": str(column)})
    assert response.status_code == 422
    assert "列の予測" in response.json()["detail"]
