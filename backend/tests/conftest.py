import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional

import pytest

from ml_fathom import places, problems


def move_and_link(part: Path, outside: Path) -> None:
    """
    途中の場所を退けて, 外を指すリンクを置く関数

    Parameters
    ----------
    part: Path
        途中の場所
    outside: Path
        リンクの指す外のディレクトリ

    Returns
    ----------
    None
    """
    # 前からあるディレクトリは .moved に退ける
    if part.exists():
        part.rename(part.with_name(f"{part.name}.moved"))
    part.symlink_to(outside, target_is_directory=True)


@pytest.fixture
def swap_after_check(
    monkeypatch: pytest.MonkeyPatch
) -> Callable[[Path, Path, str], None]:
    """
    書き出し先の確かめの後に, 途中の場所を外を指すシンボリックリンクに
    替える差し替えを返す関数

    Parameters
    ----------
    monkeypatch: pytest.MonkeyPatch
        export_place か, 途中を作る関数の差し替え

    Returns
    ----------
    swap: Callable[[Path, Path, str], None]
        途中の場所と, リンクの指す外のディレクトリと, 替える時 (check
        か walk) を受け取り, 差し替えを仕掛ける関数
    """
    checked = problems.export_place
    made = os.mkdir

    def swap(part: Path, outside: Path, when: str) -> None:
        # check: 確かめが済んでから替える (親の実体の比べ直しで断る場面)
        def after_check(record: Optional[dict[str, str]]) -> Any:
            target = checked(record)
            move_and_link(part, outside)
            return target

        # walk: 比べ直しの後, その段を作って開く直前に替える (リンクを
        # たどらずに開くことで断る場面). 1 度だけ替える
        done: list[bool] = []

        def in_walk(name: Any, *args: Any, **kwargs: Any) -> None:
            if not done and kwargs.get("dir_fd") is not None and (
                name == part.name
            ):
                done.append(True)
                move_and_link(part, outside)
            made(name, *args, **kwargs)

        if when == "check":
            monkeypatch.setattr(problems, "export_place", after_check)
        else:
            monkeypatch.setattr(places.os, "mkdir", in_walk)

    return swap
