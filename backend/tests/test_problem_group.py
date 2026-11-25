import ast
import hashlib
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import ml_eda
import ml_quest
import numpy as np
import pandas as pd
import pytest
import yaml
from fastapi import HTTPException
from fastapi.testclient import TestClient
from ml_quest import example_problem

from ml_fathom import problems
from ml_fathom.api import STAMPS
from ml_fathom.app import create_app
from ml_fathom.groups import check_group_columns, group_answers

# テストで使うトークン
TOKEN = "test-token"

# 受け持ちの場所
PART = ml_quest.PART

# 合成の表の列
COLUMNS = ["customer", "spend", "visits", "region"]

# 合成の表の, 群の数と群ごとの行の数
GROUPS = 3
ROWS = 40


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


def group_problem() -> dict[str, Any]:
    """
    見本の課題から, まとめるで学習する受け持ちの問題の設定を作る関数

    Parameters
    ----------
    None

    Returns
    ----------
    problem: dict[str, Any]
        まとめるで出力の形が群, 指標がシルエット係数で, 群を作る列, 行を
        見分ける列, 群の数, 安定性の数え方に答えた問題の設定 (データは
        入れていない)
    """
    # 1 から 4 と 9, 10 は見本のまま, 受け持ちは作り直し
    problem = example_problem("解約の引き止め")
    problem["ml"]["parts"] = [{}]
    for key in ("decision", "basis", "current"):
        problem["action"].pop(key, None)
    problem = ml_quest.answer(problem, "information.columns", COLUMNS)
    for key, value in [("role", "group"), ("unit", "row"),
                       ("output", "cluster"), ("target.source", "none"),
                       ("method", "scratch"),
                       ("what", "顧客の群"), ("item", "顧客 1 人"),
                       ("baseline", "今の区分 (地域)"),
                       ("evaluation.metric", "silhouette"),
                       ("evaluation.link", "群ごとに連絡の仕方を変える"),
                       ("group.columns", ["spend", "visits", "region"]),
                       ("group.id", "customer"), ("group.k", GROUPS),
                       ("group.stability", "sample")]:
        problem = ml_quest.answer(problem, f"{PART}.{key}", value)

    return problem


def write_rows(root: Path) -> Path:
    """
    3 つのはっきりした群のある, 合成の顧客の表の CSV を作る関数

    Parameters
    ----------
    root: Path
        書き出す場所

    Returns
    ----------
    path: Path
        CSV のファイル (customer, spend, visits, region)
    """
    # 群ごとに使う額, 来た回数, 地域が違う
    rng = np.random.default_rng(0)
    rows = [
        {"customer": f"c{group}_{number}",
         "spend": float(rng.normal(1000 * (group + 1), 50)),
         "visits": int(rng.poisson(2 + 6 * group)),
         "region": ("north", "south", "east")[group]}
        for group in range(GROUPS) for number in range(ROWS)
    ]
    root.mkdir(parents=True, exist_ok=True)
    path = root / "customers.csv"
    pd.DataFrame(rows).to_csv(path, index=False)

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
        problems/group (一覧に並ぶ場所)
    """
    path = tmp_path / "pathfinder" / "problems" / "group"

    return path


def saved_problem(
    tmp_path: Path, problem: dict[str, Any]
) -> tuple[Path, Path]:
    """
    表を入れたまとめるの問題の設定から ML-Quest でプロジェクトを作り,
    記録とともに保存する関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    problem: dict[str, Any]
        まとめるの問題の設定 (データは入れていない)

    Returns
    ----------
    paths: tuple[Path, Path]
        problem.yaml を持つディレクトリと, プロジェクトのディレクトリ
    """
    # 写しを置き, 骨組みの書き出しと, その記録 (project.dataset は config
    # の data.dataset)
    source = write_rows(tmp_path / "raw")
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
    書き出した骨組みの学習のスクリプトから, 群を作る表を読む関数を取り出す
    関数

    学習のスクリプトは torch と ML-Found を読み込むので, 読み方の定数と
    read_rows の定義だけを動かす

    Parameters
    ----------
    project: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    read: Any
        骨組みの read_rows (path と config を受け取る)
    """
    # 読み方の定数 (LOADER, OPTIONS), 使えない列の名前と関数の定義だけ
    names = ("LOADER", "OPTIONS", "TAKEN_COLUMNS", "ASSIGNED_COLUMNS")
    tree = ast.parse((project / "train.py").read_text("utf-8"))
    nodes = [
        node for node in tree.body
        if (isinstance(node, ast.Assign) and any(
            isinstance(name, ast.Name) and name.id in names
            for name in node.targets
        )) or (
            isinstance(node, ast.FunctionDef) and node.name == "read_rows"
        )
    ]
    assert len(nodes) == 5
    scope: dict[str, Any] = {
        "pd": pd, "load_data": ml_eda.load_data, "Path": Path, "Any": Any,
        "Optional": Optional,
    }
    exec(compile(ast.Module(nodes, []), "train.py", "exec"), scope)
    read = scope["read_rows"]

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
        data と group を属性で読める config
    """
    # 骨組みの read_rows が読む項目だけ
    config = yaml.safe_load(
        (project / "configs" / "default" / "train.yaml").read_text("utf-8")
    )
    cfg = SimpleNamespace(
        data=SimpleNamespace(**config["data"]),
        group=SimpleNamespace(**config["group"]),
    )

    return cfg


def test_group_start_and_export(client: TestClient, tmp_path: Path) -> None:
    """
    まとめるの問題の設定から表を登録して群分けのタブの答えを返し, 骨組みが
    読む場所にファイル 1 つのまま写すことを確かめる関数

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
    # 始められるものとして並び, レシピの無い表として登録して群分けを開く
    path, project = saved_problem(tmp_path, group_problem())
    listed = client.get("/api/problems").json()["problems"]
    assert [item["startable"] for item in listed] == [True]
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    body = started.json()
    source = body["source"]
    assert body["form"] is None and body["notes"] == []
    assert body["tab"] == "groups"
    assert source["kind"] == "table" and source["loader"] == "csv"
    assert source["target"] is None
    url = f"/api/sources/{source['id']}"
    assert client.get(f"{url}/recipe").json()["steps"] == []

    # 問題の設定の答えと, 書き出し先 (骨組みは入れた表を data に写すので,
    # 前に置いたファイルがある)
    found = client.get(f"{url}/group_problem")
    assert found.status_code == 200
    result = found.json()
    assert result["path"] == str(path / "problem.yaml")
    assert result["group"] == {
        "columns": ["spend", "visits", "region"], "id": "customer",
        "k": GROUPS, "stability": "sample",
        "stability_label": "標本を変えて作り直す",
    }
    target = project / skeleton_config(project).data.dataset
    place = result["project"]
    assert place["dataset"] == str(target) and place["state"] == "file"
    assert place["ready"] is True
    assert client.get(f"{url}/project").json() == place

    # 答えの列で群の要約を作れる (表の分析のタブもそのまま使える)
    summary = client.post(f"{url}/groups", json={
        "columns": result["group"]["columns"], "k": GROUPS,
    })
    assert summary.status_code == 200 and summary.json()["k"] == GROUPS
    assert client.get(f"{url}/profile").status_code == 200

    # 置き換えの確かめが要り, 置き換えると元の表をそのまま写す
    refused = client.post(f"{url}/export_group_project", json={})
    assert refused.status_code == 409
    target.write_text("customer,spend\n", "utf-8")
    exported = client.post(
        f"{url}/export_group_project", json={"overwrite": True}
    )
    assert exported.status_code == 200
    done = exported.json()
    assert done == {
        "path": str(target), "copied": True, "rows": GROUPS * ROWS,
        "columns": ["spend", "visits", "region"], "id": "customer",
    }
    assert target.read_bytes() == Path(source["path"]).read_bytes()

    # 骨組みの読み方で, 答えの列と行を見分ける列を読める
    read = skeleton_reader(project)
    frame, ids = read(target, skeleton_config(project))
    assert list(frame.columns) == ["spend", "visits", "region"]
    assert len(frame) == GROUPS * ROWS and ids is not None
    assert ids.iloc[0] == "c0_0"

    # 書き出し先が無ければ, 確かめずに置く
    target.unlink()
    assert client.get(f"{url}/project").json()["state"] == "missing"
    assert client.post(
        f"{url}/export_group_project", json={}
    ).status_code == 200
    assert target.is_file()


def test_group_refusals(client: TestClient, tmp_path: Path) -> None:
    """
    まとめるの問題の設定はレシピの確かめと書き出しを断り, 答えの列が表に
    無いか受け持ちが変われば写さないことを確かめる関数

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
    path, project = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    recipe = {"format_version": 1, "task": "none", "steps": []}
    checked = client.post(f"{url}/problem/check", json={"recipe": recipe})
    assert checked.status_code == 422
    assert "レシピを持ちません" in checked.json()["detail"]
    # 前処理のタブは, 確かめを呼ぶ前に群分けの答えの有無で案内に切り替える
    # (確かめの 422 は, レシピを送る呼び手への守りとして残す)
    assert client.get(f"{url}/group_problem").json()["group"] is not None
    assert client.post(
        f"{url}/export_project", json={"recipe": recipe}
    ).status_code == 422
    pairs = client.get("/api/problems/pairs", params={"path": str(path)})
    assert pairs.status_code == 422 and "まとめる" in pairs.json()["detail"]

    # 書き出し先がディレクトリなら置き換えない
    target = project / skeleton_config(project).data.dataset
    target.unlink()
    target.mkdir()
    assert client.get(f"{url}/project").json()["ready"] is False
    assert client.post(
        f"{url}/export_group_project", json={"overwrite": True}
    ).status_code == 409
    target.rmdir()

    # 記録の書き出し先の拡張子が違えば写さない
    problem = ml_quest.load_problem(path / "problem.yaml")
    problem["project"]["dataset"] = str(target.with_suffix(".parquet"))
    ml_quest.save_problem(problem, path)
    response = client.post(f"{url}/export_group_project", json={})
    assert response.status_code == 422
    assert "拡張子" in response.json()["detail"]
    assert not target.with_suffix(".parquet").exists()

    # 答え直した列が表に無ければ写さない
    problem["project"]["dataset"] = str(target)
    problem["ml"]["parts"][0]["group"]["columns"] = ["spend", "income"]
    ml_quest.save_problem(problem, path)
    response = client.post(f"{url}/export_group_project", json={})
    assert response.status_code == 422
    assert "income" in response.json()["detail"]
    assert not target.exists()

    # 群を作るのに使えない名前 (GROUP_TAKEN) は, 骨組みが止めるので写さない
    problem["ml"]["parts"][0]["group"]["columns"] = ["spend", "rows"]
    ml_quest.save_problem(problem, path)
    frame = pd.read_csv(source["path"])
    frame["rows"] = 1
    frame.to_csv(source["path"], index=False)
    # 数秒の間は前に調べた更新時刻を使うので, 覚えた時刻を忘れさせる
    STAMPS.clear()
    response = client.post(f"{url}/export_group_project", json={})
    assert response.status_code == 422
    assert "群の要約の列" in response.json()["detail"]

    # 群の割り当ての表の列と同じ名前の行を見分ける列も写さない
    problem["ml"]["parts"][0]["group"]["columns"] = ["spend", "visits"]
    problem["ml"]["parts"][0]["group"]["id"] = "split"
    ml_quest.save_problem(problem, path)
    frame["split"] = [f"r{number}" for number in range(len(frame))]
    frame.to_csv(source["path"], index=False)
    STAMPS.clear()
    response = client.post(f"{url}/export_group_project", json={})
    assert response.status_code == 422
    assert "行を見分ける列 split" in response.json()["detail"]
    assert not target.exists()
    problem["ml"]["parts"][0]["group"]["id"] = "customer"

    # 受け持ちが変われば答えを返さず, 書き出しも断る
    problem["ml"]["parts"][0]["role"] = "predict"
    ml_quest.save_problem(problem, path)
    result = client.get(f"{url}/group_problem").json()
    assert result["group"] is None and result["project"] is None
    response = client.post(f"{url}/export_group_project", json={})
    assert response.status_code == 422
    assert "まとめる" in response.json()["detail"]


def outside_place(kind: str, project: Path, outside: Path) -> Path:
    """
    プロジェクトの外を指す書き出し先を作る関数

    Parameters
    ----------
    kind: str
        absolute (外の絶対パス), parent (.. で外), link (外を指す途中の
        リンクの下), target (外を指すリンクそのもの)
    project: Path
        プロジェクトのディレクトリ
    outside: Path
        プロジェクトの外の, 置き換えられてはいけないファイル

    Returns
    ----------
    place: Path
        記録に書く書き出し先 (絶対パス)
    """
    # 途中のリンクと, 書き出し先そのもののリンクは, プロジェクトの中に置く
    if kind == "absolute":
        place = outside
    elif kind == "parent":
        place = project / ".." / outside.parent.name / outside.name
    elif kind == "link":
        (project / "shared").symlink_to(
            outside.parent, target_is_directory=True
        )
        place = project / "shared" / outside.name
    else:
        (project / outside.name).symlink_to(outside)
        place = project / outside.name

    return place


@pytest.mark.parametrize("kind", ["absolute", "parent", "link", "target"])
def test_group_export_outside(
    client: TestClient, tmp_path: Path, kind: str
) -> None:
    """
    書き出し先がプロジェクトの外 (絶対パス, .., リンク) なら, 置き換えの
    印を付けても理由付きの 422 で断り, 外のファイルを置き換えないことを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    kind: str
        外を指す書き出し先の種類 (outside_place)

    Returns
    ----------
    None
    """
    # 外に, 拡張子の同じファイルを置き, 記録をそこへ向ける
    path, project = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    target = project / skeleton_config(project).data.dataset
    outside = tmp_path / "outside" / target.name
    outside.parent.mkdir()
    outside.write_text("keep\n", encoding="utf-8")
    problem = ml_quest.load_problem(path / "problem.yaml")
    problem["project"]["dataset"] = str(
        outside_place(kind, project, outside)
    )
    ml_quest.save_problem(problem, path)

    # 様子にも書き出しにも同じ理由を出し, 外のファイルは残す
    shown = client.get(f"{url}/project").json()
    assert shown["ready"] is False and shown["state"] is None
    assert "の中にありません" in shown["reason"]
    refused = client.post(f"{url}/export_group_project", json={"overwrite": True})
    assert refused.status_code == 422
    assert refused.json()["detail"] == shown["reason"]
    assert outside.read_text("utf-8") == "keep\n"


@pytest.mark.parametrize("when, word", [
    ("check", "外を指すように替わった"), ("walk", "シンボリックリンク"),
], ids=["check", "walk"])
def test_group_export_swapped(
    client: TestClient, tmp_path: Path,
    swap_after_check: Callable[[Path, Path, str], None]
, when: str, word: str
) -> None:
    """
    確かめの後に書き出し先の途中が外を指すリンクに替わっても, 理由付きの
    422 で断り, 外のファイルを置き換えないことを確かめる関数

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
    # 外に同じ名前のファイルを置き, 確かめの後に書き出し先の親を替える
    path, project = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    target = project / skeleton_config(project).data.dataset
    assert target.parent != project
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / target.name).write_text("keep\n", encoding="utf-8")
    swap_after_check(target.parent, outside, when)

    # 理由付きで断り, 外のファイルは残し, 一時ファイルも残さない
    refused = client.post(
        f"{url}/export_group_project", json={"overwrite": True}
    )
    assert refused.status_code == 422
    assert word in refused.json()["detail"]
    assert (outside / target.name).read_text("utf-8") == "keep\n"
    assert [item.name for item in outside.iterdir()] == [target.name]


def test_group_not_startable(client: TestClient, tmp_path: Path) -> None:
    """
    データを入れていないか, 答えの列が表に無いまとめるの問題の設定は,
    理由を付けて始めないことを確かめる関数

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
    ml_quest.save_problem(group_problem(), path)
    listed = client.get("/api/problems").json()["problems"]
    assert listed[0]["startable"] is False
    assert "データが入っていません" in listed[0]["reason"]
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    assert response.json()["detail"] == listed[0]["reason"]

    # 答えた行を見分ける列が表に無ければ, 登録しない
    raw = write_rows(tmp_path / "raw")
    frame = pd.read_csv(raw).drop(columns=["customer"])
    frame.to_csv(raw, index=False)
    problem = ml_quest.attach_data(group_problem(), str(raw))
    ml_quest.save_problem(problem, path)
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    assert "customer" in response.json()["detail"]
    assert client.get("/api/sources").json() == []


def test_group_start_refusals(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    入れた表が無いか, ファイルでないか, 表として読めない場合は, 理由を
    付けて登録しないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        読み込みの差し替え

    Returns
    ----------
    None
    """
    # 入れた表 (写しも元も) が消えていれば 404
    path = problem_place(tmp_path)
    raw = write_rows(tmp_path / "raw")
    problem = ml_quest.attach_data(group_problem(), str(raw))
    ml_quest.save_problem(problem, path)
    raw.unlink()
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 404
    assert "customers.csv" in response.json()["detail"]

    # 入れた場所がディレクトリなら 422
    raw.mkdir()
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    assert "ファイルではありません" in response.json()["detail"]
    raw.rmdir()

    # 表か時系列として読めなければ 422 (読み込みの種類を出す)
    write_rows(tmp_path / "raw")
    loaded = problems.load_source

    def as_image(source: dict[str, Any]) -> Any:
        data = loaded(source)
        return SimpleNamespace(kind="image", frame=data.frame)

    monkeypatch.setattr(problems, "load_source", as_image)
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    assert "image" in response.json()["detail"]
    assert client.get("/api/sources").json() == []


@pytest.mark.parametrize("columns, key, word", [
    (["spend", "id"], None, "群を作る列 id"),
    (["spend", "split"], None, "群を作る列 split"),
    (["spend", "share"], None, "群を作る列 share"),
    (["spend"], "group", "行を見分ける列 group"),
    (["spend"], "split", "行を見分ける列 split"),
])
def test_group_column_names(
    columns: list[str], key: Optional[str], word: str
) -> None:
    """
    骨組みが使えない名前の群を作る列と行を見分ける列を, ML-Quest の
    決まり (GROUP_TAKEN と GROUP_ASSIGNED) で断ることを確かめる関数

    Parameters
    ----------
    columns: list[str]
        群を作る列
    key: Optional[str]
        行を見分ける列
    word: str
        理由に出る言葉

    Returns
    ----------
    None
    """
    # 表には全ての列があり, 名前だけが誤り
    names = set(columns) | ({key} if key else set()) | {"customer"}
    data: Any = SimpleNamespace(
        frame=pd.DataFrame({name: [1, 2] for name in sorted(names)})
    )
    with pytest.raises(HTTPException) as error:
        check_group_columns(data, {"columns": columns, "id": key})
    assert error.value.status_code == 422
    assert word in str(error.value.detail)

    # ML-Quest の決まりの外の名前 (行を見分ける列の id など) は通す
    check_group_columns(data, {"columns": ["spend"], "id": "customer"})
    data.frame["id"] = 0
    check_group_columns(data, {"columns": ["spend"], "id": "id"})


def test_group_start_column_names(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    答えた行を見分ける列が骨組みの使えない名前のまとめるの問題の設定は,
    ML-Quest の確かめと群分けのタブの確かめの両方で始めないことを確かめる
    関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        ML-Quest の確かめの差し替え

    Returns
    ----------
    None
    """
    # 行を見分ける列を group にした表と答え
    path = problem_place(tmp_path)
    raw = write_rows(tmp_path / "raw")
    frame = pd.read_csv(raw).rename(columns={"customer": "group"})
    frame.to_csv(raw, index=False)
    problem = group_problem()
    columns = ["group", "spend", "visits", "region"]
    problem = ml_quest.answer(problem, "information.columns", columns)
    problem = ml_quest.answer(problem, f"{PART}.group.id", "group")
    problem = ml_quest.attach_data(problem, str(raw))
    ml_quest.save_problem(problem, path)

    # ML-Quest の確かめが先に止める
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail.startswith("問題の設定を渡せません")
    assert "行を見分ける列 group" in detail
    assert client.get("/api/sources").json() == []

    # ML-Quest の確かめを通っても (config を手で直した場合など), 群分けの
    # タブの確かめが止める
    monkeypatch.setattr(ml_quest, "project_error", lambda problem: None)
    response = client.post("/api/problems/start", json={"path": str(path)})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "行を見分けるのに使えません" in detail
    assert "ML-Pathfinder" in detail
    assert client.get("/api/sources").json() == []


def test_group_export_reanswered(
    client: TestClient, tmp_path: Path
) -> None:
    """
    始めた後に ML-Quest の確かめで誤りになる答えに直した場合は, 写さずに
    前に写した表を残すことを確かめる関数

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
    # 始めて, 置き換えて写せる
    path, project = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    assert client.post(
        f"{url}/export_group_project", json={"overwrite": True}
    ).status_code == 200
    target = project / skeleton_config(project).data.dataset
    target.write_text("customer,spend\n", "utf-8")

    # 行を見分ける列を群を作る列の 1 つに答え直すと, 置き換えの印でも断る
    problem = ml_quest.load_problem(path / "problem.yaml")
    problem["ml"]["parts"][0]["group"]["id"] = "spend"
    ml_quest.save_problem(problem, path)
    response = client.post(
        f"{url}/export_group_project", json={"overwrite": True}
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail.startswith("問題の設定を渡せません")
    assert "spend" in detail
    assert target.read_text("utf-8") == "customer,spend\n"


def test_group_write_back(client: TestClient, tmp_path: Path) -> None:
    """
    群分けのタブの選び方を試しに書き戻して変わる点を返し, 中身の印ととも
    に ml.parts.<n>.group に書き戻して保存することを確かめる関数

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
    # 試しの書き戻しは保存しない (プロジェクトがあるので書き出し直す案内)
    path, project = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    file = path / "problem.yaml"
    before = file.read_bytes()
    chosen = {"columns": ["spend", "visits"], "id": None, "k": 4}
    checked = client.post(
        f"{url}/group_problem/check", json={"group": chosen}
    )
    assert checked.status_code == 200
    result = checked.json()
    assert result["path"] == str(file)
    changes = result["changes"]
    assert len(changes) == 4
    assert "spend, visits" in changes[0] and "4" in changes[2]
    assert "書き出し直してください" in changes[3]
    assert file.read_bytes() == before

    # 書き戻すと, 答えが選び方と同じになり, 安定性の数え方は残る
    written = client.post(f"{url}/group_problem/write", json={
        "group": chosen, "version": result["version"],
    })
    assert written.status_code == 200
    done = written.json()
    assert done["changes"] == changes
    assert done["group"] == {
        "columns": ["spend", "visits"], "id": None, "k": 4,
        "stability": "sample",
    }
    answers = client.get(f"{url}/group_problem").json()["group"]
    assert {key: answers[key] for key in ("columns", "id", "k")} == {
        "columns": ["spend", "visits"], "id": None, "k": 4,
    }
    problem = ml_quest.load_problem(file)
    assert ml_quest.active_value(problem, f"{PART}.group.k") == 4
    assert done["version"] != result["version"]

    # 同じ選び方は変わる点が無く, 書いた欄だけを書き戻す
    again = client.post(f"{url}/group_problem/check", json={"group": chosen})
    assert again.json()["changes"] == []
    written = client.post(f"{url}/group_problem/write", json={
        "group": {"id": "customer"}, "version": done["version"],
    })
    assert written.status_code == 200
    assert written.json()["group"]["id"] == "customer"
    assert written.json()["group"]["k"] == 4

    # 書き出し直した骨組みの config の group は書き戻した値と同じ
    ml_quest.make_project(
        ml_quest.load_problem(file), project, overwrite=True
    )
    group = skeleton_config(project).group
    assert list(group.columns) == ["spend", "visits"]
    assert group.id == "customer" and group.k == 4


def test_group_write_back_refusals(
    client: TestClient, tmp_path: Path
) -> None:
    """
    骨組みを組めない選び方, 確かめた後の問題の設定の変更, まとめるでなく
    なった問題の設定は, 書き戻さずに断ることを確かめる関数

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
    # 群を作る列と行を見分ける列の重なり, 無い列, 空の列は理由付きの 422
    path, _ = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    file = path / "problem.yaml"
    before = file.read_bytes()
    for chosen, part in [
        ({"columns": ["spend"], "id": "spend"}, "書き戻せません"),
        ({"columns": ["spend", "income"]}, "income"),
        ({"columns": []}, "空にはできません"),
    ]:
        response = client.post(
            f"{url}/group_problem/check", json={"group": chosen}
        )
        assert response.status_code == 422
        assert part in response.json()["detail"]
    version = client.post(
        f"{url}/group_problem/check", json={"group": {"k": 5}}
    ).json()["version"]
    response = client.post(f"{url}/group_problem/write", json={
        "group": {"columns": ["spend"], "id": "spend"}, "version": version,
    })
    assert response.status_code == 422
    assert file.read_bytes() == before

    # 知らない欄は断る (取り違えた欄を黙って捨てないため)
    assert client.post(
        f"{url}/group_problem/check", json={"group": {"seed": 1}}
    ).status_code == 422

    # 確かめた後に他で変わっていれば 409 で, 書き戻さない
    problem = ml_quest.load_problem(file)
    problem = ml_quest.answer(problem, f"{PART}.group.k", 6)
    ml_quest.save_problem(problem, path)
    changed = file.read_bytes()
    response = client.post(f"{url}/group_problem/write", json={
        "group": {"k": 5}, "version": version,
    })
    assert response.status_code == 409
    assert file.read_bytes() == changed

    # まとめるでなくなれば, 確かめも書き戻しも断る
    problem["ml"]["parts"][0]["role"] = "predict"
    ml_quest.save_problem(problem, path)
    response = client.post(
        f"{url}/group_problem/check", json={"group": {"k": 5}}
    )
    assert response.status_code == 422
    assert "まとめる" in response.json()["detail"]


@pytest.mark.parametrize("k", [1, 51, 1000])
def test_group_write_back_k_range(
    client: TestClient, tmp_path: Path, k: int
) -> None:
    """
    範囲の外の群の数 (画面と群の要約と同じ 2 から 50 の外) は, 確かめも
    書き戻しも断って保存しないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    k: int
        群の数

    Returns
    ----------
    None
    """
    # 中身の印は正しくても断る
    path, _ = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    file = path / "problem.yaml"
    before = file.read_bytes()
    version = client.post(
        f"{url}/group_problem/check", json={"group": {"k": 5}}
    ).json()["version"]
    assert client.post(
        f"{url}/group_problem/check", json={"group": {"k": k}}
    ).status_code == 422
    assert client.post(f"{url}/group_problem/write", json={
        "group": {"k": k}, "version": version,
    }).status_code == 422
    assert file.read_bytes() == before


def test_group_write_back_same_read(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    読んだ直後に外で保存されても, 変わる点と中身の印は同じ読みから作り,
    書き戻しは外の変更を上書きせずに 409 で断ることを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        読みの差し替え

    Returns
    ----------
    None
    """
    # 読んだ直後に, 外で群の数を 6 に保存する読み
    path, _ = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    file = path / "problem.yaml"
    before = file.read_bytes()
    original = problems.read_problem_bytes

    def racing(place: Path) -> tuple[dict[str, Any], str]:
        read = original(place)
        changed = ml_quest.answer(
            ml_quest.load_problem(place), f"{PART}.group.k", 6
        )
        ml_quest.save_problem(changed, place.parent)
        return read

    monkeypatch.setattr(problems, "read_problem_bytes", racing)

    # 確かめの印は, 変わる点を作った中身 (外の保存の前) の印
    checked = client.post(
        f"{url}/group_problem/check", json={"group": {"k": 5}}
    ).json()
    assert checked["version"] == hashlib.sha256(before).hexdigest()
    assert checked["changes"][0] == "群の数を 5 に書き戻した"

    # 書き戻しは, 読んだ後の外の保存を上書きしない
    file.write_bytes(before)
    response = client.post(f"{url}/group_problem/write", json={
        "group": {"k": 5}, "version": checked["version"],
    })
    assert response.status_code == 409
    problem = ml_quest.load_problem(file)
    assert ml_quest.active_value(problem, f"{PART}.group.k") == 6


def test_group_write_back_linked_refusals(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    問題の設定から始めていないデータ (404), 作った時刻が変わった問題の設定,
    まとめるでなくなった問題の設定, 保存できない場合 (422) の書き戻しを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        保存の差し替え

    Returns
    ----------
    None
    """
    # 問題の設定から始めていないデータは, 確かめも書き戻しも 404
    plain = client.post("/api/sources", json={
        "path": str(write_rows(tmp_path / "plain"))
    }).json()
    plain_url = f"/api/sources/{plain['id']}"
    assert client.post(
        f"{plain_url}/group_problem/check", json={"group": {"k": 5}}
    ).status_code == 404
    assert client.post(f"{plain_url}/group_problem/write", json={
        "group": {"k": 5}, "version": "v",
    }).status_code == 404

    # 保存できなければ 422 で, ファイルは変えない
    path, _ = saved_problem(tmp_path, group_problem())
    source = client.post(
        "/api/problems/start", json={"path": str(path)}
    ).json()["source"]
    url = f"/api/sources/{source['id']}"
    file = path / "problem.yaml"
    before = file.read_bytes()
    version = hashlib.sha256(before).hexdigest()

    def refuse(problem: dict[str, Any], place: Any) -> dict[str, Any]:
        raise OSError("書けません")

    with monkeypatch.context() as patch:
        patch.setattr(ml_quest, "save_problem", refuse)
        response = client.post(f"{url}/group_problem/write", json={
            "group": {"k": 5}, "version": version,
        })
    assert response.status_code == 422
    assert "保存できません" in response.json()["detail"]
    assert file.read_bytes() == before

    # 作った時刻が変われば (別の問題の設定に置き換わった) 422
    problem = ml_quest.load_problem(file)
    problem["created_at"] = "2000-01-01T00:00:00"
    ml_quest.save_problem(problem, path)
    replaced = file.read_bytes()
    response = client.post(f"{url}/group_problem/write", json={
        "group": {"k": 5}, "version": hashlib.sha256(replaced).hexdigest(),
    })
    assert response.status_code == 422
    assert "別の問題の設定に置き換わっています" in response.json()["detail"]
    file.write_bytes(before)

    # まとめるでなくなれば, 中身の印が正しくても書き戻さない
    problem = ml_quest.load_problem(file)
    problem["ml"]["parts"][0]["role"] = "predict"
    ml_quest.save_problem(problem, path)
    changed = file.read_bytes()
    response = client.post(f"{url}/group_problem/write", json={
        "group": {"k": 5}, "version": hashlib.sha256(changed).hexdigest(),
    })
    assert response.status_code == 422
    assert "まとめる" in response.json()["detail"]
    assert file.read_bytes() == changed


@pytest.mark.parametrize("value, expected", [
    (4, 4), (4.0, 4), (True, None), (2.5, None), ("4", None), (None, None),
])
def test_group_answers_k(value: Any, expected: Optional[int]) -> None:
    """
    群の数の答えは整数の値だけを返し, 他は答えていないものとすることを
    確かめる関数

    Parameters
    ----------
    value: Any
        問題の設定に書いた群の数
    expected: Optional[int]
        返す群の数

    Returns
    ----------
    None
    """
    # 形の崩れた値も, 画面に数でないものを渡さない
    problem = group_problem()
    problem["ml"]["parts"][0]["group"]["k"] = value
    assert group_answers(problem)["k"] == expected
    problem["ml"]["parts"][0]["group"]["stability"] = "other"
    assert group_answers(problem)["stability"] is None
