import io
from typing import Any

import ml_eda
import numpy as np
from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response

# 点群として返す点の数の上限 (多い場合は間引く)
MAX_POINTS = 50_000


def item_response(data: ml_eda.Data, index: int) -> Response:
    """
    1 件の中身を画面で見られる形にして返す関数

    Parameters
    ----------
    data: ml_eda.Data
        読み込んだデータ
    index: int
        行の位置

    Returns
    ----------
    response: Response
        画像は PNG, 点群は点と色の JSON, 文は JSON

    Raises
    ----------
    HTTPException
        中身を持たない種類か, 読めない場合は 422
    """
    # 種類ごとに形を変える
    try:
        item = data.load_item(index)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except OSError as error:
        raise HTTPException(422, f"読めませんでした: {error}") from error
    if data.kind == "image":
        return png_response(item)
    if data.kind == "pointcloud":
        return points_response(item)
    response = JSONResponse({"text": str(item)})

    return response


def png_response(image: np.ndarray) -> Response:
    """
    画像の配列を PNG で返す関数

    Parameters
    ----------
    image: np.ndarray
        (高さ, 幅) か (高さ, 幅, チャンネル) の配列

    Returns
    ----------
    response: Response
        PNG の画像
    """
    # Pillow で PNG にする (8 ビットにそろえる)
    from PIL import Image

    array = np.asarray(image)
    if array.dtype != np.uint8:
        low, high = float(array.min()), float(array.max())
        scale = 255.0 / (high - low) if high > low else 1.0
        array = ((array - low) * scale).clip(0, 255).astype(np.uint8)
    if array.ndim == 3 and array.shape[2] == 1:
        array = array[:, :, 0]
    buffer = io.BytesIO()
    Image.fromarray(array).save(buffer, format="PNG")
    response = Response(buffer.getvalue(), media_type="image/png")

    return response


def points_response(item: Any) -> Response:
    """
    点群を, 画面で描く点と色の JSON で返す関数

    Parameters
    ----------
    item: Any
        points ((N, 3) の配列) と colors ((N, 3) の 0 から 255, 任意) の辞書

    Returns
    ----------
    response: Response
        points (平らな座標の並び), colors, 元の点の数
    """
    # 多い場合は等間隔に間引く
    points = np.asarray(item["points"], dtype=np.float32)[:, :3]
    step = max(1, len(points) // MAX_POINTS)
    colors = item.get("colors")
    body: dict[str, Any] = {
        "count": int(len(points)),
        "points": points[::step].round(5).ravel().tolist(),
        "colors": (
            np.asarray(colors)[::step].astype(int).ravel().tolist()
            if colors is not None else None
        ),
    }
    response = JSONResponse(body)

    return response
