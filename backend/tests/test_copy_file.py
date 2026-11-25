import os
import shutil
import stat
from pathlib import Path

import pytest

from ml_fathom.places import pinned_parent
from ml_fathom.reactions import copy_file


def copy_into(project: Path, source: Path, target: Path) -> bool:
    """
    書き出し先の親を開いて, 表を写す関数

    Parameters
    ----------
    project: Path
        プロジェクトのディレクトリ
    source: Path
        写す表
    target: Path
        書き出し先

    Returns
    ----------
    copied: bool
        copy_file の結果
    """
    # 呼び出し側 (copy_to_project) と同じく, 開いた親に写す
    with pinned_parent(project, target) as parent:
        copied = copy_file(source, parent)

    return copied


def names(place: Path) -> list[str]:
    """
    ディレクトリの中の名前を並べて返す関数

    Parameters
    ----------
    place: Path
        ディレクトリ

    Returns
    ----------
    listed: list[str]
        名前の並び
    """
    listed = sorted(item.name for item in place.iterdir())

    return listed


def test_copy_and_overwrite(tmp_path: Path) -> None:
    """
    まだ無い親の下に写し, 前のファイルを置き換え, 元の権限にそろえ,
    一時ファイルを残さないことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 持ち主と群だけが読める表を写す
    project = tmp_path / "proj"
    project.mkdir()
    source = tmp_path / "rows.csv"
    source.write_text("a\n1\n", encoding="utf-8")
    source.chmod(0o640)
    target = project / "data" / "rows.csv"
    assert copy_into(project, source, target) is True
    assert target.read_text("utf-8") == "a\n1\n"
    assert stat.S_IMODE(target.stat().st_mode) == 0o640
    assert names(target.parent) == ["rows.csv"]

    # 前に置いたファイルは中身ごと置き換える
    source.write_text("a\n2\n", encoding="utf-8")
    source.chmod(0o644)
    assert copy_into(project, source, target) is True
    assert target.read_text("utf-8") == "a\n2\n"
    assert stat.S_IMODE(target.stat().st_mode) == 0o644
    assert names(target.parent) == ["rows.csv"]


def test_copy_same_file(tmp_path: Path) -> None:
    """
    書き出し先が写す表そのもの (同じ場所か, ハードリンク) なら写さない
    ことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 同じ場所
    project = tmp_path / "proj"
    (project / "data").mkdir(parents=True)
    target = project / "data" / "rows.csv"
    target.write_text("a\n1\n", encoding="utf-8")
    assert copy_into(project, target, target) is False

    # 別の名前のハードリンク
    other = tmp_path / "rows.csv"
    os.link(target, other)
    assert copy_into(project, other, target) is False
    assert target.read_text("utf-8") == "a\n1\n"
    assert names(target.parent) == ["rows.csv"]


def test_copy_failure_cleans(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    写す途中で止まっても, 前のファイルを壊さず, 一時ファイルを残さない
    ことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        写す関数の差し替え

    Returns
    ----------
    None
    """
    # 前のファイルを置き, 写す途中で誤りにする
    project = tmp_path / "proj"
    (project / "data").mkdir(parents=True)
    target = project / "data" / "rows.csv"
    target.write_text("old\n", encoding="utf-8")
    source = tmp_path / "rows.csv"
    source.write_text("new\n", encoding="utf-8")

    def broken(*args: object, **kwargs: object) -> None:
        raise OSError("書けません")

    monkeypatch.setattr(shutil, "copyfileobj", broken)
    with pytest.raises(OSError):
        copy_into(project, source, target)
    assert target.read_text("utf-8") == "old\n"
    assert names(target.parent) == ["rows.csv"]


@pytest.mark.parametrize("points", ["outside", "source"])
def test_copy_replaces_link(tmp_path: Path, points: str) -> None:
    """
    書き出し先がシンボリックリンクなら, リンクの先をたどらず, リンクの
    項目を写したファイルで置き換えることを確かめる関数

    呼び出し側は様子の確かめでリンクを断るので, これは確かめの後にリンクに
    替わった場合の守り. リンクが写す表そのものを指していても写す

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    points: str
        リンクの先 (outside は外のファイル, source は写す表)

    Returns
    ----------
    None
    """
    # 外のファイルか写す表を指すリンクを, 書き出し先に置く
    project = tmp_path / "proj"
    (project / "data").mkdir(parents=True)
    source = tmp_path / "rows.csv"
    source.write_text("new\n", encoding="utf-8")
    outside = tmp_path / "outside.csv"
    outside.write_text("keep\n", encoding="utf-8")
    target = project / "data" / "rows.csv"
    target.symlink_to(outside if points == "outside" else source)

    # リンクは普通のファイルになり, 先のファイルは変わらない
    assert copy_into(project, source, target) is True
    assert not target.is_symlink() and target.is_file()
    assert target.read_text("utf-8") == "new\n"
    assert outside.read_text("utf-8") == "keep\n"
    assert source.read_text("utf-8") == "new\n"
    assert names(target.parent) == ["rows.csv"]
