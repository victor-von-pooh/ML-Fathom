import ast
from collections.abc import Callable
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

# 見せただけの印と提示の列を持つ, 合成の反応の表の列
SHOWN_COLUMNS = [*COLUMNS, "shown_only", "impression_id"]

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
    tmp_path: Path, problem: dict[str, Any],
    write: Callable[[Path], Path] = write_reactions
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
    write: Callable[[Path], Path] = write_reactions
        反応の表を書き出す関数 (書き出す場所を受け取り, ファイルを返す)

    Returns
    ----------
    paths: tuple[Path, Path]
        problem.yaml を持つディレクトリと, プロジェクトのディレクトリ
    """
    # 写しを置き, 骨組みの書き出しと, その記録 (project.dataset は config
    # の data.dataset)
    source = write(tmp_path / "raw")
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
def test_rank_export_outside(
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
    path, project = saved_problem(tmp_path, rank_problem())
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
    refused = client.post(f"{url}/export_reactions", json={"overwrite": True})
    assert refused.status_code == 422
    assert refused.json()["detail"] == shown["reason"]
    assert outside.read_text("utf-8") == "keep\n"


@pytest.mark.parametrize("when, word", [
    ("check", "外を指すように替わった"), ("walk", "シンボリックリンク"),
], ids=["check", "walk"])
def test_rank_export_swapped(
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
    path, project = saved_problem(tmp_path, rank_problem())
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
    refused = client.post(f"{url}/export_reactions", json={"overwrite": True})
    assert refused.status_code == 422
    assert word in refused.json()["detail"]
    assert (outside / target.name).read_text("utf-8") == "keep\n"
    assert [item.name for item in outside.iterdir()] == [target.name]


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


def write_shown(root: Path) -> Path:
    """
    見せただけの印と提示の列を持つ反応の表の CSV を作る関数

    1 回の提示ごとに選んだ品物 1 行と見せただけの品物 3 行を置き, 印を
    読めない行, 提示の欠けた行, 選んだ行と重なる見せただけの行, 同じ
    見せただけの行を 1 つずつ含める

    Parameters
    ----------
    root: Path
        書き出す場所

    Returns
    ----------
    path: Path
        CSV のファイル (member, item_id, ts, qty, shown_only,
        impression_id)
    """
    # 提示ごとに, 選んだ品物と見せただけの品物 (印の欠けは選んだ行)
    rng = np.random.default_rng(1)
    rows = []
    for number in range(80):
        member, ts = f"m{number % 20}", number
        items = rng.choice(30, size=4, replace=False)
        rows.append([member, f"i{items[0]}", ts, 1, None, f"p{number}"])
        rows.extend([member, f"i{item}", ts, None, "true", f"p{number}"]
                    for item in items[1:])
    rows.append(["m0", "i1", 0, None, "maybe", "p0"])
    rows.append(["m0", "i2", 0, None, "true", None])
    rows.append([rows[0][0], rows[0][1], 0, None, "1", "p0"])
    rows.append(list(rows[1]))
    frame = pd.DataFrame(rows, columns=SHOWN_COLUMNS)
    root.mkdir(parents=True, exist_ok=True)
    path = root / "reactions.csv"
    frame.to_csv(path, index=False)

    return path


def shown_reader(project: Path) -> Any:
    """
    書き出した骨組みの学習のスクリプトから, 見せただけの印のある反応の表を
    読む関数を取り出す関数

    Parameters
    ----------
    project: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    read: Any
        骨組みの read_shown (path と config を受け取る)
    """
    # 読み方の定数 (LOADER, OPTIONS) と関数の定義だけ
    tree = ast.parse((project / "train.py").read_text("utf-8"))
    nodes = [
        node for node in tree.body
        if (isinstance(node, ast.Assign) and any(
            isinstance(name, ast.Name) and name.id in ("LOADER", "OPTIONS")
            for name in node.targets
        )) or (
            isinstance(node, ast.FunctionDef) and node.name == "read_shown"
        )
    ]
    assert len(nodes) == 3
    scope: dict[str, Any] = {
        "pd": pd, "load_reactions": ml_eda.load_reactions, "Path": Path,
        "Any": Any,
    }
    exec(compile(ast.Module(nodes, []), "train.py", "exec"), scope)
    read = scope["read_shown"]

    return read


class RankConfig(dict):  # type: ignore[type-arg]
    """
    骨組みの config の rank を, 属性と get で読める形にする辞書
    """

    def __getattr__(self, name: str) -> Any:
        """
        項目を属性で返す関数

        Parameters
        ----------
        name: str
            項目の名前

        Returns
        ----------
        value: Any
            項目の値
        """
        value = self[name]

        return value


def test_rank_shown(client: TestClient, tmp_path: Path) -> None:
    """
    見せただけの印と提示の列を答えた並べるの問題の設定では, 骨組みと同じ
    決まりで除く行を数え, 見せただけの記録の要約を返すことを確かめる関数

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
    # 印と提示の列を答えた問題から始める
    problem = ml_quest.answer(
        rank_problem(), "information.columns", SHOWN_COLUMNS
    )
    for key, value in [("rank.shown", "shown_only"),
                       ("rank.presentation", "impression_id")]:
        problem = ml_quest.answer(problem, f"{PART}.{key}", value)
    path, project = saved_problem(tmp_path, problem, write_shown)
    started = client.post("/api/problems/start", json={"path": str(path)})
    assert started.status_code == 201
    source = started.json()["source"]
    url = f"/api/sources/{source['id']}"

    # ML-EDA に印と提示の列を渡した要約と同じ
    summary = client.get(f"{url}/reactions").json()["summary"]
    expected = ml_eda.describe_reactions(ml_eda.load_reactions(
        Path(source["path"]), "member", "item_id", "ts", "qty",
        shown="shown_only", presentation="impression_id"
    ))
    assert summary == expected
    assert summary["columns"]["shown"] == "shown_only"
    assert summary["columns"]["presentation"] == "impression_id"
    dropped = summary["dropped"]
    assert dropped["missing"] == 1 and dropped["unreadable_shown"] == 1
    assert dropped["conflict"] == 1 and dropped["duplicate_shown"] == 1
    shown = summary["shown"]
    assert shown["by"] == "presentation" and shown["negatives"] == 240
    assert shown["presentations"] == 80
    assert shown["chosen_presentations"] == 80

    # 骨組みの学習のスクリプトと同じ数の反応, 見せただけの記録と知らせ
    target = project / skeleton_config(project).data.dataset
    exported = client.post(
        f"{url}/export_reactions", json={"overwrite": True}
    )
    assert exported.status_code == 200
    result = exported.json()
    assert result["reactions"] == summary["reactions"] == 80
    assert result["dropped"] == dropped["total"] == 4
    config = yaml.safe_load(
        (project / "configs" / "default" / "train.yaml").read_text("utf-8")
    )
    assert config["rank"]["shown"] == "shown_only"
    cfg = SimpleNamespace(rank=RankConfig(config["rank"]))
    frame, negatives, notes = shown_reader(project)(target, cfg)
    assert len(frame) == summary["reactions"]
    assert len(negatives) == shown["negatives"]
    assert notes == summary["notes"][:len(notes)]

    # 印の列を答え直して外すと, 見せただけの記録の要約は無い
    problem = ml_quest.answer(
        ml_quest.load_problem(path), f"{PART}.rank.shown", None
    )
    ml_quest.save_problem(problem, path)
    summary = client.get(f"{url}/reactions").json()["summary"]
    assert summary["shown"] is None
    assert summary["columns"]["presentation"] is None
