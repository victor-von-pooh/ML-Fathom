import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from ml_fathom import places
from ml_fathom.places import pinned_parent


def test_pinned_parent_makes_and_opens(tmp_path: Path) -> None:
    """
    書き出し先の親を一段ずつ作って開き, 親の実体の下の書き出し先を返す
    ことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # プロジェクトの中のリンクは, たどった後の実体の場所で開く
    project = tmp_path / "proj"
    (project / "real").mkdir(parents=True)
    (project / "alias").symlink_to(project / "real", target_is_directory=True)
    target = project / "alias" / "a" / "b" / "dataset"
    with pinned_parent(project, target) as parent:
        assert parent.place == (project / "real" / "a" / "b" / "dataset"
                                ).resolve()
        made = os.stat(parent.place.parent)
        assert (made.st_dev, made.st_ino) == (
            os.fstat(parent.fd).st_dev, os.fstat(parent.fd).st_ino
        )
    assert (project / "real" / "a" / "b").is_dir()


def test_pinned_parent_removes_made(tmp_path: Path) -> None:
    """
    中で誤りが起きたら, 作ったディレクトリ (空のもの) だけを消すことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 前からある data は残し, 作った a と b は消す
    project = tmp_path / "proj"
    (project / "data").mkdir(parents=True)
    target = project / "data" / "a" / "b" / "dataset"
    with pytest.raises(RuntimeError):
        with pinned_parent(project, target):
            raise RuntimeError("書き出しの誤り")
    assert [item.name for item in project.iterdir()] == ["data"]
    assert list((project / "data").iterdir()) == []


@pytest.mark.parametrize("kind", ["link", "file"])
def test_pinned_parent_refuses_swap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """
    親の実体を比べた後に途中の場所がリンクかファイルに替わっても, 開かずに
    理由付きの 422 で断り, 外に書かないことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        途中のディレクトリを作る関数の差し替え
    kind: str
        替わった先 (link は外を指すリンク, file はファイル)

    Returns
    ----------
    None
    """
    # a を作った後, b を作る直前に b を替える
    project = tmp_path / "proj"
    project.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    made = os.mkdir

    def swapped(name: str, *args: object, dir_fd: int) -> None:
        if name == "b":
            if kind == "link":
                os.symlink(outside, name, dir_fd=dir_fd)
            else:
                os.close(os.open(name, os.O_CREAT | os.O_WRONLY,
                                 dir_fd=dir_fd))
        made(name, *args, dir_fd=dir_fd)  # type: ignore[arg-type]

    monkeypatch.setattr(places.os, "mkdir", swapped)
    target = project / "a" / "b" / "dataset"
    with pytest.raises(HTTPException) as caught:
        with pinned_parent(project, target):
            raise AssertionError("開けないはず")
    assert caught.value.status_code == 422
    word = "シンボリックリンク" if kind == "link" else "ディレクトリでない"
    assert word in str(caught.value.detail)
    assert list(outside.iterdir()) == []
    # 替えたもの (b) の入った a は空でないので消さず, b にも手を付けない
    assert [item.name for item in (project / "a").iterdir()] == ["b"]
