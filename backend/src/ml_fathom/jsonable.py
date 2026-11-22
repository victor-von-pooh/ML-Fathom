import math
from typing import Any

import numpy as np


def to_json(value: Any) -> Any:
    """
    numpy の値と NaN を, API の応答の JSON にできる値に変換する関数

    Parameters
    ----------
    value: Any
        変換する値 (辞書とリストとタプルは中も変換)

    Returns
    ----------
    converted: Any
        JSON にできる値 (NaN と無限大は None)
    """
    # 入れ物は中を順に変換
    if isinstance(value, dict):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json(v) for v in value]
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (float, np.floating)):
        number = float(value)
        return None if math.isnan(number) or math.isinf(number) else number
    if isinstance(value, np.bool_):
        return bool(value)
    converted = value

    return converted
