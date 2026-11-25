from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional

import pytest

from ml_fathom import problems


@pytest.fixture
def swap_after_check(
    monkeypatch: pytest.MonkeyPatch
) -> Callable[[Path, Path], None]:
    """
    書き出し先の確かめ (export_place) の後に, 途中の場所を外を指す
    シンボリックリンクに替える差し替えを返す関数

    Parameters
    ----------
    monkeypatch: pytest.MonkeyPatch
        export_place の差し替え

    Returns
    ----------
    swap: Callable[[Path, Path], None]
        途中の場所と, リンクの指す外のディレクトリを受け取り, 差し替えを
        仕掛ける関数
    """
    checked = problems.export_place

    def swap(part: Path, outside: Path) -> None:
        # 確かめが済んでから, 途中の場所を退けてリンクを置く (別のプロセス
        # が確かめと書き込みの間に替えた場面)
        def swapped(record: Optional[dict[str, str]]) -> Any:
            target = checked(record)
            if part.exists():
                part.rename(part.with_name(f"{part.name}.moved"))
            part.symlink_to(outside, target_is_directory=True)
            return target

        monkeypatch.setattr(problems, "export_place", swapped)

    return swap
