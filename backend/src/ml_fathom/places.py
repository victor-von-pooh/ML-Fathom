import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException

# ディレクトリを開くときの印 (リンクはたどらない)
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


@dataclass(frozen=True)
class Parent:
    """
    一段ずつ開いて確かめた, 書き出し先の親

    Attributes
    ----------
    fd: int
        親のディレクトリの記述子 (書き込みはこれに対して行うと, 途中が
        替わっても同じディレクトリに書く)
    place: Path
        書き出し先 (親の実体のパスの下の名前. ML-EDA にはこれを渡す)
    """

    fd: int
    place: Path


def changed_reason(part: Path, fd: int, name: str) -> str:
    """
    途中の場所を開けなかった理由の文を返す関数

    Parameters
    ----------
    part: Path
        開けなかった途中の場所
    fd: int
        その場所の親のディレクトリの記述子
    name: str
        その場所の名前

    Returns
    ----------
    reason: str
        リンクか, ディレクトリでないかの理由
    """
    # リンクかどうかで文を分ける (どちらも書かずに断る)
    try:
        mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
        linked = stat.S_ISLNK(mode)
    except OSError:
        linked = False
    what = "シンボリックリンク" if linked else "ディレクトリでないもの"
    reason = (
        f"書き出し先の途中 {part} が{what}になっているので書き出しません. "
        "プロジェクトの外に書かないように, 確かめてからもう一度書き出して"
        "ください"
    )

    return reason


def close_all(fds: list[int]) -> None:
    """
    開いた記述子を全て閉じる関数

    Parameters
    ----------
    fds: list[int]
        記述子

    Returns
    ----------
    None
    """
    # 閉じられないものは飛ばす
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


@contextmanager
def pinned_parent(root: Path, target: Path) -> Iterator[Parent]:
    """
    書き出し先の親を, プロジェクトから一段ずつ作って開き, 確かめる関数

    export_place で確かめた後に別のプロセスが途中の場所をシンボリック
    リンクに替えても, プロジェクトの外に書かないように, 書く直前に親の
    実体のパスを比べ直し, 途中を 1 つずつリンクをたどらずに開く (無ければ
    作る). 中で誤りが起きたら, ここで作ったディレクトリを (空のものだけ)
    消す

    Parameters
    ----------
    root: Path
        プロジェクトのディレクトリ
    target: Path
        export_place で確かめた書き出し先

    Yields
    ----------
    parent: Parent
        親の記述子と, 書き出し先 (親の実体のパスの下)

    Raises
    ----------
    HTTPException
        親の実体がプロジェクトの外か, 途中にリンクかディレクトリでない
        ものがある場合は 422
    OSError
        途中のディレクトリを作れないか開けない場合
    """
    # 書く直前の親の実体も, プロジェクトの中であること
    base = root.resolve()
    real = target.parent.resolve()
    if not real.is_relative_to(base):
        raise HTTPException(
            422, f"書き出し先の途中 {target.parent} がプロジェクト {root} の"
            "外を指すように替わったので書き出しません. 確かめてからもう一度"
            "書き出してください"
        )

    # プロジェクトから一段ずつ, リンクをたどらずに開く (作ったものを覚える)
    fds = [os.open(base, os.O_RDONLY | os.O_DIRECTORY)]
    made: list[tuple[int, str]] = []
    part = base
    try:
        for name in real.relative_to(base).parts:
            part = part / name
            try:
                os.mkdir(name, dir_fd=fds[-1])
                made.append((fds[-1], name))
            except FileExistsError:
                pass
            try:
                fds.append(os.open(name, DIRECTORY_FLAGS, dir_fd=fds[-1]))
            except OSError as error:
                raise HTTPException(
                    422, changed_reason(part, fds[-1], name)
                ) from error
        yield Parent(fd=fds[-1], place=real / target.name)
    except BaseException:
        # 作ったディレクトリは, 空なら奥から消す (書きかけを残さない)
        for fd, name in reversed(made):
            try:
                os.rmdir(name, dir_fd=fd)
            except OSError:
                pass
        raise
    finally:
        close_all(fds)
