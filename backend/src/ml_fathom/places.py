import fcntl
import os
import stat
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

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
        親のディレクトリの記述子 (反応の表と群分けの表の写し (copy_file)
        と, ML-EDA の版 1 とファイルの組の書き出し (引数 parent) はこれに
        対して書くので, 途中が替わっても同じディレクトリに書く)
    place: Path
        書き出し先 (親の実体のパスの下の名前. 様子の確かめと理由の文に
        使い, ML-EDA は最後の部分だけを親の中の名前に使う)
    """

    fd: int
    place: Path


def same_parent(parent: Parent) -> bool:
    """
    書き出し先のパスが, 今も開いた親を通るかを返す関数

    ML-EDA は開いた親に対して書くので, 書いている最中に途中の場所が
    替わっても外には書かない. ただ書いた後にパスで読む (モデルの入力の
    数など) と替わった先を読むので, 読む前にこれで確かめる

    Parameters
    ----------
    parent: Parent
        開いた書き出し先の親

    Returns
    ----------
    same: bool
        パスの親 (リンクをたどった後) と開いた親が同じディレクトリか
    """
    # 装置と i-node の番号の比べ (パスで開けなければ違うとみなす)
    try:
        now = os.stat(parent.place.parent)
    except OSError:
        same = False
        return same
    opened = os.fstat(parent.fd)
    same = (now.st_dev, now.st_ino) == (opened.st_dev, opened.st_ino)

    return same


def opened_state(parent: Parent, single: bool = False) -> str:
    """
    開いた親の中の書き出し先の今の様子を, リンクをたどらずに返す関数

    Parameters
    ----------
    parent: Parent
        開いた書き出し先の親
    single: bool = False
        書き出し先がファイル 1 つ (反応の表と群分けの表の写し) か

    Returns
    ----------
    state: str
        missing (無い), dataset (前に書き出したデータセット. single では
        file (普通のファイル)), occupied (他のもの, シンボリックリンク)
    """
    # 親の中の名前の, リンクをたどらない様子
    name = parent.place.name
    try:
        mode = os.stat(name, dir_fd=parent.fd, follow_symlinks=False).st_mode
    except FileNotFoundError:
        state = "missing"
        return state
    if single:
        state = "file" if stat.S_ISREG(mode) else "occupied"
        return state
    if not stat.S_ISDIR(mode):
        state = "occupied"
        return state

    # 中の説明も, 開いたディレクトリに対してリンクをたどらない確かめ
    try:
        fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent.fd)
    except OSError:
        state = "occupied"
        return state
    try:
        mode = os.stat(
            "dataset.yaml", dir_fd=fd, follow_symlinks=False
        ).st_mode
        state = "dataset" if stat.S_ISREG(mode) else "occupied"
    except FileNotFoundError:
        state = "occupied"
    finally:
        os.close(fd)

    return state


def opened_path(fd: int) -> Optional[Path]:
    """
    開いたディレクトリの今の場所を返す関数

    Parameters
    ----------
    fd: int
        ディレクトリの記述子

    Returns
    ----------
    path: Optional[Path]
        今の場所 (macOS は F_GETPATH, Linux は /proc の記述子のリンク.
        求められなければ None)
    """
    # 記述子からの今の場所 (名前を変えた後も)
    path: Optional[Path] = None
    try:
        if sys.platform == "darwin":
            raw = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024))
            path = Path(os.fsdecode(raw.split(b"\0", 1)[0]))
        elif os.path.isdir("/proc/self/fd"):
            path = Path(os.readlink(f"/proc/self/fd/{fd}"))
    except OSError:
        path = None

    return path


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
        "学習のプロジェクトの外に書かないように, 確かめてからもう一度書き出して"
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
            422, f"書き出し先の途中 {target.parent} が学習のプロジェクト {root} の"
            "外を指すように替わったので書き出しません. 確かめてからもう一度"
            "書き出してください"
        )

    # プロジェクトから一段ずつ, リンクをたどらずに開く (作ったものを覚える)
    fds = [os.open(base, DIRECTORY_FLAGS)]
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
