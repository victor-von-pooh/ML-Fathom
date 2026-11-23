import importlib.util
import json
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from ml_fathom.jsonable import to_json

# 説明の JSON を, 表の名前を知るために読む大きさの上限
MAX_INFO_BYTES = 1 << 20


def policy_value_available() -> bool:
    """
    方策の見積もり (ML-Found の estimate_policy_value) を使えるかを返す
    関数

    任意の依存 [policy] の ML-Found と PyTorch が入っているかを, 読み込ま
    ずに確かめる (PyTorch の読み込みで画面の最初の応答を遅らせないように)

    Parameters
    ----------
    None

    Returns
    ----------
    available: bool
        ml_found と torch が入っているか
    """
    available = all(
        importlib.util.find_spec(name) is not None
        for name in ("ml_found", "torch")
    )

    return available


def csv_table(path: Path, summary: dict[str, Any]) -> Path:
    """
    登録した軌跡の場所から, ML-Found が読む CSV の表の場所を返す関数

    Parameters
    ----------
    path: Path
        登録した場所 (表か説明)
    summary: dict[str, Any]
        ML-EDA の describe_trajectory の結果

    Returns
    ----------
    table: Path
        CSV の表 (隣の同じ名前の説明も ML-Found が読む)

    Raises
    ----------
    HTTPException
        表が CSV でないか, 説明の表の名前を読めない場合は 422
    """
    # ML-Found の見積もりは save_trajectory が書く CSV だけを読む
    if summary.get("format") != "csv":
        raise HTTPException(
            422, "方策の見積もりは CSV の軌跡の表だけを読みます (この表は "
            f"{summary.get('format')})"
        )
    if path.suffix.lower() != ".json":
        return path

    # 説明を登録した場合は, その file (ML-EDA が同じディレクトリの名前で
    # あることを確かめて読んだもの)
    try:
        with path.open("rb") as handle:
            info = json.loads(handle.read(MAX_INFO_BYTES).decode("utf-8"))
        name = info["file"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise HTTPException(
            422, f"説明から軌跡の表の名前を読めません: {error}"
        ) from error
    if not isinstance(name, str) or Path(name).name != name:
        raise HTTPException(
            422, f"説明の file が同じディレクトリの表の名前ではありません: "
            f"{name!r}"
        )
    table = path.parent / name

    return table


def discrete_space(summary: dict[str, Any]) -> tuple[int, int]:
    """
    説明の行動の空間から, Discrete の行動の数と最初の番号を返す関数

    Parameters
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_trajectory の結果

    Returns
    ----------
    space: tuple[int, int]
        行動の数 n と最初の番号 start

    Raises
    ----------
    HTTPException
        説明に Discrete の行動の空間が無い場合は 422
    """
    # 行動の数が分からないと一様の確率を決められないので, 説明の空間を使う
    space = summary.get("action_space")
    columns = summary.get("action_columns")
    n = space.get("n") if isinstance(space, dict) else None
    start = space.get("start", 0) if isinstance(space, dict) else None
    if (
        not isinstance(space, dict) or space.get("type") != "discrete"
        or not isinstance(n, int) or isinstance(n, bool) or n < 1
        or not isinstance(start, int) or isinstance(start, bool)
        or columns != ["action"]
    ):
        raise HTTPException(
            422, "見積もる方策は Discrete の行動の軌跡だけで作れます. 説明 "
            "(JSON) に Discrete の行動の空間 (action_space) と, 表に 1 つの "
            "action の列が要ります"
        )
    result = (n, start)

    return result


def most_frequent_action(summary: dict[str, Any]) -> int:
    """
    記録で最も多くとった行動を返す関数

    Parameters
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_trajectory の結果

    Returns
    ----------
    action: int
        最も多い行動 (同じ数なら小さい番号)

    Raises
    ----------
    HTTPException
        値ごとの数が無い場合は 422
    """
    # ML-EDA の値ごとの数 (異なる値が 50 以下の整数の列だけにある)
    actions = summary.get("actions") or []
    counts = actions[0].get("counts") if actions else None
    if not counts:
        raise HTTPException(
            422, "行動の値ごとの数が無いので, 最も多い行動を決められません"
        )
    best = min(counts, key=lambda entry: (-entry["count"], entry["value"]))
    action = int(best["value"])

    return action


class FixedPolicy:
    def __init__(
        self, n: int, start: int, epsilon: float, best: Optional[int]
    ):
        # 行動の数と最初の番号, 一様に選ぶ確率, 残りで選ぶ行動を保存
        self.n = n
        self.start = start
        self.epsilon = epsilon
        self.best = best

    def __call__(self, observation: Any, action: Any) -> float:
        """
        見積もる方策がその観測でその行動を選ぶ確率を返す関数

        Parameters
        ----------
        observation: Any
            観測 (この方策は使わない)
        action: Any
            行動の番号

        Returns
        ----------
        prob: float
            確率 epsilon で一様, 残りの 1 - epsilon で best を選ぶ確率.
            空間の外の行動は 0
        """
        # 空間の外の行動は, 見積もる方策が選ばない
        value = int(action)
        if not self.start <= value < self.start + self.n:
            return 0.0
        prob = self.epsilon / self.n + (1.0 - self.epsilon) * (
            value == self.best
        )

        return prob


def make_policy(
    summary: dict[str, Any], policy: str, epsilon: float
) -> tuple[FixedPolicy, dict[str, Any]]:
    """
    見積もる方策の確率の関数と, その説明を作る関数

    Parameters
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_trajectory の結果
    policy: str
        uniform (全ての行動を同じ確率で選ぶ) か epsilon_greedy (確率
        1 - epsilon で記録の最も多い行動, 残りは一様)
    epsilon: float
        epsilon_greedy で一様に選ぶ確率 (0 以上 1 以下)

    Returns
    ----------
    result: tuple[FixedPolicy, dict[str, Any]]
        target_prob(観測, 行動) と, 方策の説明 (name, n, start.
        epsilon_greedy は最も多い行動 action と epsilon も)
    """
    # 一様に選ぶ方策は, 全てを一様に選ぶ ε-greedy と同じ
    n, start = discrete_space(summary)
    described: dict[str, Any] = {"name": policy, "n": n, "start": start}
    best: Optional[int] = None
    if policy == "epsilon_greedy":
        best = most_frequent_action(summary)
        described.update(action=best, epsilon=epsilon)
    else:
        epsilon = 1.0
    result = (FixedPolicy(n, start, epsilon, best), described)

    return result


def estimate(
    path: Path, summary: dict[str, Any], policy: str, epsilon: float,
    gamma: float
) -> dict[str, Any]:
    """
    記録した軌跡から, 決まった形の方策の良さを ML-Found で見積もる関数

    Parameters
    ----------
    path: Path
        登録した場所 (表か説明)
    summary: dict[str, Any]
        ML-EDA の describe_trajectory の結果
    policy: str
        見積もる方策の形 (uniform か epsilon_greedy)
    epsilon: float
        epsilon_greedy で一様に選ぶ確率
    gamma: float
        割引率

    Returns
    ----------
    result: dict[str, Any]
        policy (方策の説明), gamma, estimate (ML-Found の
        estimate_policy_value の結果)

    Raises
    ----------
    HTTPException
        ML-Found が無い場合と, 見積もれない場合は 422
    """
    # 確率の列の無い表は, 記録した方策の確率が無く重みが決まらない
    if not policy_value_available():
        raise HTTPException(
            422, "方策の見積もりには ML-Found が要ります (任意の依存 "
            "policy)"
        )
    if not summary.get("with_action_prob"):
        raise HTTPException(
            422, "軌跡の表に記録した方策が行動を選んだ確率の列 action_prob "
            "が無いので, 方策の良さを見積もれません"
        )
    table = csv_table(path, summary)
    target_prob, described = make_policy(summary, policy, epsilon)

    # PyTorch を読むので, 見積もるときにだけ読み込む
    from ml_found.rl import estimate_policy_value

    try:
        value = estimate_policy_value(table, target_prob, gamma)
    except ValueError as error:
        raise HTTPException(422, f"見積もれませんでした: {error}") from error
    result = {
        "policy": described, "gamma": gamma, "estimate": to_json(value)
    }

    return result
