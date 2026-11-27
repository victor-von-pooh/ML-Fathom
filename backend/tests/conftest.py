import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional

import ml_eda.items
import ml_eda.pipeline
import pandas as pd
import pytest

from ml_fathom import places, problems


@pytest.fixture(autouse=True)
def pathfinder_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """
    ML-Pathfinder の置き場を一時ディレクトリにする関数

    アプリは作ったときに問題の設定の置き場を決めるので, アプリを作る
    fixture より先に環境変数を置く (手元の置き場を読まないためにも)

    Parameters
    ----------
    tmp_path: Path
        一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数の差し替え

    Returns
    ----------
    home: Path
        一時ディレクトリの下の pathfinder (無いこともある)
    """
    home = tmp_path / "pathfinder"
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(home))

    return home


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


@pytest.fixture
def swap_while_writing(
    monkeypatch: pytest.MonkeyPatch
) -> Callable[[Path, Path, str], None]:
    """
    ML-EDA が書き出している最中か, 書いた直後に, 途中の場所を外を指す
    シンボリックリンクに替える差し替えを返す関数

    Parameters
    ----------
    monkeypatch: pytest.MonkeyPatch
        ML-EDA の書き込みか, このアプリの確かめの差し替え

    Returns
    ----------
    swap: Callable[[Path, Path, str], None]
        途中の場所と, リンクの指す外のディレクトリと, 替える時 (frame は
        表を書く時, finish は親の中に入れ替える直前, read は書いた後に
        モデルの入力の数を読む直前) を受け取り, 差し替えを仕掛ける関数
    """
    # 版 1 (pipeline) とファイルの組 (items) の表の書き込みと, 入れ替え
    modules = (ml_eda.pipeline, ml_eda.items)
    frames = {module: module.write_frame for module in modules}
    move = ml_eda.pipeline.move_into
    hints = problems.model_hints

    def swap(part: Path, outside: Path, when: str) -> None:
        # 1 度だけの差し替え
        done: list[bool] = []

        def once() -> None:
            if not done:
                done.append(True)
                move_and_link(part, outside)

        def writing(module: Any) -> Callable[[pd.DataFrame, Path], str]:
            def write(frame: pd.DataFrame, path: Path) -> str:
                once()
                name: str = frames[module](frame, path)
                return name

            return write

        def moving(*args: Any) -> None:
            once()
            move(*args)

        def reading(*args: Any) -> dict[str, Any]:
            once()
            found: dict[str, Any] = hints(*args)
            return found

        if when == "frame":
            for module in modules:
                monkeypatch.setattr(module, "write_frame", writing(module))
        elif when == "finish":
            monkeypatch.setattr(ml_eda.pipeline, "move_into", moving)
        else:
            monkeypatch.setattr(problems, "model_hints", reading)

    return swap
