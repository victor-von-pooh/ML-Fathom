import base64
import io
import json
import math
from typing import Any, Optional

import ml_eda
import numpy as np
from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response

# 点群として返す点の数の上限 (多い場合は間引く)
MAX_POINTS = 50_000


def item_response(
    data: ml_eda.Data, index: int, size: Optional[int] = None
) -> Response:
    """
    1 件の中身を画面で見られる形にして返す関数

    Parameters
    ----------
    data: ml_eda.Data
        読み込んだデータ
    index: int
        行の位置
    size: Optional[int] = None
        画像を縮める長い辺の画素数 (None なら元の大きさ)

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
    except Exception as error:
        # 壊れたファイルや大きすぎる画像など, 読めない理由は様々
        raise HTTPException(422, f"読めませんでした: {error}") from error
    if data.kind == "image":
        response = png_response(item, size)
    elif data.kind == "pointcloud":
        response = points_response(item)
    else:
        response = JSONResponse({"text": str(item)})
    # 同じ画面で何度も開くので, 少しの間はブラウザに覚えさせる
    response.headers["Cache-Control"] = "private, max-age=60"

    return response


def png_bytes(image: np.ndarray, size: Optional[int] = None) -> bytes:
    """
    画像の配列を PNG のバイト列にする関数 (8 ビットでなければ最小と
    最大で 0 から 255 に)

    Parameters
    ----------
    image: np.ndarray
        (高さ, 幅) か (高さ, 幅, チャンネル) の配列
    size: Optional[int] = None
        長い辺がこれより大きければ縮める画素数

    Returns
    ----------
    data: bytes
        PNG
    """
    # Pillow で PNG にする (8 ビットにそろえる)
    from PIL import Image

    array = np.asarray(image)
    if array.dtype != np.uint8:
        array = np.nan_to_num(array.astype(np.float64))
        low, high = float(array.min()), float(array.max())
        scale = 255.0 / (high - low) if high > low else 1.0
        array = ((array - low) * scale).clip(0, 255).astype(np.uint8)
    if array.ndim == 3 and array.shape[2] == 1:
        array = array[:, :, 0]
    picture = Image.fromarray(array)
    if size is not None:
        picture.thumbnail((size, size))
    buffer = io.BytesIO()
    picture.save(buffer, format="PNG")
    data = buffer.getvalue()

    return data


def png_response(image: np.ndarray, size: Optional[int] = None) -> Response:
    """
    画像の配列を PNG で返す関数

    Parameters
    ----------
    image: np.ndarray
        (高さ, 幅) か (高さ, 幅, チャンネル) の配列
    size: Optional[int] = None
        長い辺がこれより大きければ縮める画素数

    Returns
    ----------
    response: Response
        PNG の画像
    """
    # 8 ビットの PNG
    response = Response(png_bytes(image, size), media_type="image/png")

    return response


def points_body(item: Any) -> dict[str, Any]:
    """
    点群を, 画面で描く点と色の辞書にする関数

    Parameters
    ----------
    item: Any
        points ((N, 3) の配列) と colors ((N, 3) の 0 から 255, 任意) の
        辞書, または (N, 3) の配列

    Returns
    ----------
    body: dict[str, Any]
        points (平らな座標の並び), colors, 元の点の数 (有限でない点も
        数える)
    """
    # 配列だけの場合は色なし
    if not isinstance(item, dict):
        item = {"points": item, "colors": None}
    response = points_response(item)
    body: dict[str, Any] = json.loads(bytes(response.body))

    return body


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
        points (平らな座標の並び), colors, 元の点の数 (有限でない点も
        数える)
    """
    # 有限でない点 (距離のセンサーの欠け) は JSON にできないので除き,
    # 多い場合は等間隔に間引く
    points = np.asarray(item["points"], dtype=np.float32)[:, :3]
    finite = np.isfinite(points).all(axis=1)
    count = int(len(points))
    points = points[finite]
    step = max(1, math.ceil(len(points) / MAX_POINTS))
    colors = item.get("colors")
    shown = None
    if colors is not None:
        values = np.nan_to_num(np.asarray(colors, dtype=np.float64)[finite])
        # 0 から 1 の色は 0 から 255 に
        if len(values) and values.max() <= 1.0:
            values = values * 255
        shown = values[::step].clip(0, 255).astype(int).ravel().tolist()
    body: dict[str, Any] = {
        "count": count,
        "points": points[::step].round(5).ravel().tolist(),
        "colors": shown,
    }
    response = JSONResponse(body)

    return response


def item_view(
    item: Any, kind: str, state: Optional[dict[str, Any]] = None
) -> Any:
    """
    手順の前か後の 1 件を, 画面で見せる形にする関数

    Parameters
    ----------
    item: Any
        画像の配列 ((高さ, 幅, チャンネル) か, 手順の後の (チャンネル,
        高さ, 幅)), 文, 番号の並び, 点群
    kind: str
        種類
    state: Optional[dict[str, Any]] = None
        語彙の手順の当てはめた値 (番号を語に戻す)

    Returns
    ----------
    view: Any
        画像は PNG の data URL, 文は文字, 番号の並びは [番号, 語] の並び,
        点群は点と色の辞書
    """
    # 種類ごとに形を変える
    if kind == "image":
        array = np.asarray(item)
        if array.ndim == 3 and array.shape[0] in (1, 3) and (
            array.shape[2] not in (1, 3)
            or array.dtype != np.uint8
        ):
            array = np.moveaxis(array, 0, -1)
        encoded = base64.b64encode(png_bytes(array, 256)).decode("ascii")
        return f"data:image/png;base64,{encoded}"
    if kind == "pointcloud":
        return points_body(item)
    if isinstance(item, np.ndarray):
        words = (state or {}).get("vocabulary", [])
        return [
            [int(k), words[int(k)] if 0 <= int(k) < len(words) else "?"]
            for k in item.ravel().tolist()
        ]
    view = str(item)[:2000]

    return view
