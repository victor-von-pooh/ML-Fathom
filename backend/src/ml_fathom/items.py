import base64
import io
import math
import wave
from pathlib import Path
from typing import Any, Optional

import ml_eda
import numpy as np
from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response

# 点群として返す点の数の上限 (多い場合は間引く)
MAX_POINTS = 50_000

# 前と後を見比べる点群の点の数の上限 (何件も返すので少なく)
PREVIEW_POINTS = 5_000

# 再生と波形に使う音声の長さ (秒. 先頭から. 長い録音で大きな音を送らない
# ように)
AUDIO_SECONDS = 30.0

# 波形の区間の数 (区間ごとに振幅の最小と最大を返す)
WAVEFORM_BINS = 1000

# 中身の手順の前と後で描いて鳴らす音声の長さ (秒. 先頭から. 何件も返す
# ので短く)
PREVIEW_SECONDS = 5.0

# 再生用の WAVE のチャンネルの上限 (多いものは平均して 1 つに)
PLAY_CHANNELS = 2


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
        画像は PNG, 点群は点と色の JSON, 文は JSON, 音声は波形の JSON

    Raises
    ----------
    HTTPException
        中身を持たない種類か, 読めない場合と, ファイルが読み込んだ
        ディレクトリの外の場合は 422
    """
    # 音声は先頭の決まった長さだけを読む (load_item は全てを読むため)
    response: Response
    if data.kind == "audio":
        response = JSONResponse(
            audio_body(data, index, audio_clip(data, index))
        )
        response.headers["Cache-Control"] = "private, max-age=60"
        return response

    # ファイルを 1 件ずつ読む種類は, 読み込んだディレクトリの中に限る
    if data.kind in ("image", "pointcloud"):
        item_place(data, index)

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
    elif data.kind == "capture":
        try:
            response = JSONResponse(capture_body(data, index, item))
        except Exception as error:
            raise HTTPException(
                422, f"撮影を描けませんでした: {error}"
            ) from error
    else:
        response = JSONResponse({"text": str(item)})
    # 同じ画面で何度も開くので, 少しの間はブラウザに覚えさせる
    response.headers["Cache-Control"] = "private, max-age=60"

    return response


def item_place(data: ml_eda.Data, index: int) -> Path:
    """
    1 件のファイルの場所を, 読み込んだディレクトリの中に限って返す関数

    Parameters
    ----------
    data: ml_eda.Data
        画像, 点群, 音声のデータ (読み込みが source に root を書いたもの)
    index: int
        行の位置

    Returns
    ----------
    place: Path
        シンボリックリンクと .. をたどった後の場所

    Raises
    ----------
    HTTPException
        読み込んだ場所か path の列が無い場合と, 場所が読み込んだ
        ディレクトリの外 (.. や絶対パス, 外を指すシンボリックリンク) の
        場合は 422
    """
    # 根と行の場所をたどった後で比べる (絶対パスは根を無視して外に出る)
    root = data.source.get("root")
    if not root or "path" not in data.frame.columns:
        raise HTTPException(422, "1 件のファイルの場所がありません")
    base = Path(str(root)).resolve()
    place = (base / str(data.frame["path"].iloc[index])).resolve()
    if not place.is_relative_to(base):
        raise HTTPException(
            422, "読み込んだディレクトリの外のファイルは読みません"
        )

    return place


def audio_clip(data: ml_eda.Data, index: int) -> dict[str, Any]:
    """
    音声の 1 件の先頭の AUDIO_SECONDS 秒を読む関数

    Parameters
    ----------
    data: ml_eda.Data
        音声のデータ
    index: int
        行の位置

    Returns
    ----------
    audio: dict[str, Any]
        samples ((標本の数, チャンネル) の float32) と sample_rate
        (ML-EDA の read_audio)

    Raises
    ----------
    HTTPException
        場所が無いか読み込んだディレクトリの外の場合と, 読めない場合は 422
    """
    # 場所は読み込んだディレクトリの中に限る
    place = item_place(data, index)
    try:
        audio: dict[str, Any] = ml_eda.read_audio(place, AUDIO_SECONDS)
    except Exception as error:
        # 壊れたファイルや soundfile の無い形式など, 読めない理由は様々
        raise HTTPException(422, f"読めませんでした: {error}") from error

    return audio


def audio_body(
    data: ml_eda.Data, index: int, audio: dict[str, Any]
) -> dict[str, Any]:
    """
    音声の 1 件を, 画面で描く波形の辞書にする関数

    Parameters
    ----------
    data: ml_eda.Data
        音声のデータ
    index: int
        行の位置
    audio: dict[str, Any]
        audio_clip で読んだ先頭の音

    Returns
    ----------
    body: dict[str, Any]
        sample_rate, channels, duration (全体の秒. 分からなければ None),
        seconds (読んだ秒), truncated (先頭だけを読んだか), waveform
        (チャンネルを平均した振幅の, 区間ごとの min と max)
    """
    # 波形は読んだ先頭の音から
    shape = waveform_body(audio["samples"], int(audio["sample_rate"]))
    count = int(np.shape(audio["samples"])[0])

    # 全体の長さは読み込みの表から (欠けは NaN なので自分と等しくない)
    row = data.frame.iloc[index]
    duration = row.get("duration")
    frames = row.get("frames")
    known = duration is not None and duration == duration
    counted = frames is not None and frames == frames
    body = {
        **shape,
        "duration": float(duration) if known else None,
        "truncated": bool(counted and count < int(frames)),
    }

    return body


def waveform_body(samples: Any, rate: int) -> dict[str, Any]:
    """
    音の標本を, 画面で描く波形の辞書にする関数

    Parameters
    ----------
    samples: Any
        (標本の数, チャンネル) か (標本の数,) の値
    rate: int
        標本化の周波数

    Returns
    ----------
    body: dict[str, Any]
        sample_rate, channels, seconds (標本の秒), waveform (チャンネルを
        平均した振幅の, 区間ごとの min と max)
    """
    # チャンネルを平均した振幅 (数でない値は 0)
    values = np.nan_to_num(np.asarray(samples, dtype=np.float32))
    if values.ndim == 1:
        values = values[:, None]
    mono = values.mean(axis=1) if values.size else np.zeros(0, np.float32)
    count = int(len(mono))

    # 区間ごとの最小と最大 (標本が区間より少なければ 1 標本ずつ)
    bins = min(WAVEFORM_BINS, count)
    low: list[float] = []
    high: list[float] = []
    if bins:
        edges = np.linspace(0, count, bins + 1).astype(int)[:-1]
        low = np.minimum.reduceat(mono, edges).round(4).tolist()
        high = np.maximum.reduceat(mono, edges).round(4).tolist()
    body = {
        "sample_rate": rate,
        "channels": int(values.shape[1]),
        "seconds": count / rate if rate else 0.0,
        "waveform": {"min": low, "max": high},
    }

    return body


def audio_view(samples: Any, rate: int) -> dict[str, Any]:
    """
    手順の前か後の音声の 1 件を, 先頭の PREVIEW_SECONDS 秒の波形と
    再生用の WAVE にする関数

    Parameters
    ----------
    samples: Any
        (標本の数, チャンネル) の値
    rate: int
        標本化の周波数

    Returns
    ----------
    view: dict[str, Any]
        sample_rate, channels, duration (全体の秒), seconds (波形と再生の
        秒), truncated, waveform と, src (WAVE の data URL)
    """
    # 何件も返すので, 先頭の短い秒だけを描いて鳴らす
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim == 1:
        values = values[:, None]
    count = int(values.shape[0])
    head = values[: max(int(PREVIEW_SECONDS * rate), 0)]
    encoded = base64.b64encode(
        wav_bytes({"samples": head, "sample_rate": rate})
    ).decode("ascii")
    view = {
        **waveform_body(head, rate),
        "duration": count / rate if rate else 0.0,
        "truncated": len(head) < count,
        "src": f"data:audio/wav;base64,{encoded}",
    }

    return view


def wav_bytes(audio: dict[str, Any]) -> bytes:
    """
    音を, ブラウザで鳴らせる 16 bit の PCM の WAVE のバイト列にする関数

    Parameters
    ----------
    audio: dict[str, Any]
        samples ((標本の数, チャンネル) の float32) と sample_rate

    Returns
    ----------
    data: bytes
        WAVE (PLAY_CHANNELS より多いチャンネルは平均して 1 つに. -1 から
        1 の外は端にそろえる)
    """
    # チャンネルをそろえ, 16 bit の整数にする
    samples = np.nan_to_num(np.asarray(audio["samples"], dtype=np.float32))
    if samples.ndim == 1:
        samples = samples[:, None]
    if samples.shape[1] > PLAY_CHANNELS:
        samples = samples.mean(axis=1, keepdims=True)
    values = (samples.clip(-1.0, 1.0) * 32767).round().astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as stream:
        stream.setnchannels(max(int(samples.shape[1]), 1))
        stream.setsampwidth(2)
        stream.setframerate(int(audio["sample_rate"]))
        stream.writeframes(values.tobytes())
    data = buffer.getvalue()

    return data


def audio_response(data: ml_eda.Data, index: int) -> Response:
    """
    音声の 1 件の先頭の AUDIO_SECONDS 秒を, 再生用の WAVE で返す関数

    Parameters
    ----------
    data: ml_eda.Data
        音声のデータ
    index: int
        行の位置

    Returns
    ----------
    response: Response
        16 bit の PCM の WAVE

    Raises
    ----------
    HTTPException
        音声のデータでない場合と, 読めない場合は 422
    """
    # 先頭だけを読んで WAVE にする
    if data.kind != "audio":
        raise HTTPException(422, "音声のデータではありません")
    response = Response(
        wav_bytes(audio_clip(data, index)), media_type="audio/wav"
    )
    response.headers["Cache-Control"] = "private, max-age=60"

    return response


def capture_body(
    data: ml_eda.Data, index: int, item: dict[str, Any]
) -> dict[str, Any]:
    """
    多視点の撮影の 1 件を, 画面で描く形にする関数

    Parameters
    ----------
    data: ml_eda.Data
        多視点の撮影のデータ
    index: int
        行の位置
    item: dict[str, Any]
        load_item で読んだ撮影の中身

    Returns
    ----------
    body: dict[str, Any]
        frames (番号, 追跡, 画像と深度と信頼度の有無), layout (上から見た
        カメラの配置), intrinsics, point_cloud (点群の有無)
    """
    # 場所はファイルの有無だけを返す (画面は番号で 1 枚ずつ取る)
    distance = data.frame["distance_median"].iloc[index]
    layout = ml_eda.capture_layout(
        item, None if distance != distance else float(distance)
    )
    body = {
        "frames": [
            {"index": number, "tracking": frame.get("tracking"),
             "image": frame.get("image") is not None,
             "depth": (frame.get("raw_depth") or frame.get("depth"))
             is not None,
             "confidence": frame.get("confidence") is not None}
            for number, frame in enumerate(item["frames"])
        ],
        "layout": layout,
        # JSON にできない値 (NaN など) は None
        "intrinsics": {
            key: value if isinstance(value, (int, float))
            and math.isfinite(value) else None
            for key, value in item["intrinsics"].items()
        },
        "point_cloud": item.get("point_cloud") is not None,
    }

    return body


def capture_layer(
    item: dict[str, Any], frame: int, layer: str
) -> np.ndarray:
    """
    多視点の撮影の 1 枚の, 画像か深度か信頼度を配列で読む関数

    Parameters
    ----------
    item: dict[str, Any]
        load_item で読んだ撮影の中身 (場所は撮影のディレクトリの中に限る)
    frame: int
        枚の番号
    layer: str
        image, depth (生の深度. 無ければ穴を埋めた深度), confidence

    Returns
    ----------
    array: np.ndarray
        8 ビット (深度は欠けを除いた 2 % 点から 98 % 点で 0 から 255 に.
        欠けは 0. 信頼度は値のまま)

    Raises
    ----------
    HTTPException
        無い枚か, その枚に無い層は 404
    """
    # 層ごとの場所
    from PIL import Image

    if not 0 <= frame < len(item["frames"]):
        raise HTTPException(404, f"{frame} 枚目はありません")
    entry = item["frames"][frame]
    place = {
        "image": entry.get("image"),
        "depth": entry.get("raw_depth") or entry.get("depth"),
        "confidence": entry.get("confidence"),
    }.get(layer)
    if not place:
        raise HTTPException(404, f"{frame} 枚目に {layer} がありません")
    if layer == "image":
        array: np.ndarray = ml_eda.media.read_image(Path(place))
        return array
    with Image.open(place) as image:
        values = np.asarray(image, dtype=np.float64)
    if values.ndim == 3:
        # 色の付いた形で保存した深度や信頼度は先頭のチャンネル
        values = values[:, :, 0]

    # 深度は欠け (0) を除いた 2 % 点から 98 % 点で明るさに (遠い数画素で
    # 全体が暗くならないように). 信頼度は 0 から 255 のまま
    if layer == "confidence":
        array = values.clip(0, 255).astype(np.uint8)
        return array
    valid = values[values > 0]
    low, high = (
        np.percentile(valid, [2, 98]) if valid.size else (0.0, 1.0)
    )
    scaled = (values - low) / max(float(high - low), 1e-9) * 255
    array = np.where(values > 0, scaled.clip(0, 255), 0).astype(np.uint8)

    return array


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


def points_body(item: Any, limit: int = MAX_POINTS) -> dict[str, Any]:
    """
    点群を, 画面で描く点と色の辞書にする関数

    Parameters
    ----------
    item: Any
        points ((N, 3) の配列) と colors ((N, 3) の 0 から 255, 任意) の
        辞書, または (N, 3) の配列
    limit: int = MAX_POINTS
        返す点の数の上限 (多い場合は等間隔に間引く)

    Returns
    ----------
    body: dict[str, Any]
        points (平らな座標の並び), colors, 元の点の数 (有限でない点も
        数える)
    """
    # 有限でない点 (距離のセンサーの欠け) は JSON にできないので除き,
    # 多い場合は等間隔に間引く
    if not isinstance(item, dict):
        item = {"points": item, "colors": None}
    points = np.asarray(item["points"], dtype=np.float32)[:, :3]
    finite = np.isfinite(points).all(axis=1)
    count = int(len(points))
    points = points[finite]
    step = max(1, math.ceil(len(points) / limit))
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
        points_body の JSON
    """
    # 上限まで間引いた点
    response = JSONResponse(points_body(item))

    return response


def item_view(
    item: Any, kind: str, after: bool = False,
    state: Optional[dict[str, Any]] = None, rate: Optional[int] = None
) -> Any:
    """
    手順の前か後の 1 件を, 画面で見せる形にする関数

    Parameters
    ----------
    item: Any
        画像 (前は (高さ, 幅) か (高さ, 幅, チャンネル) の uint8, 後は
        (チャンネル, 高さ, 幅) の float), 文, 番号の並び, 点群, 音声 (前は
        samples と sample_rate の辞書, 後は (チャンネル, 標本の数) の配列)
    kind: str
        種類
    after: bool = False
        手順の後か
    state: Optional[dict[str, Any]] = None
        語彙の手順の当てはめた値 (番号を語に戻す)
    rate: Optional[int] = None
        音声の後の標本化の周波数 (後の配列は周波数を持たないため)

    Returns
    ----------
    view: Any
        画像は PNG の data URL, 文は文字, 番号の並びは [番号, 語] の並び,
        点群は点と色の辞書 (見比べ用に 5000 点まで), 音声は先頭の波形と
        再生用の WAVE の data URL
    """
    # 画像の後は (チャンネル, 高さ, 幅) なので並びを戻す. 0 から 1 の値は
    # そのまま 255 倍にし (明るさを変えない), 正規化した値だけ伸ばす
    if kind == "image":
        array = np.asarray(item)
        if after:
            array = np.moveaxis(array, 0, -1).astype(np.float64)
            if array.size and 0.0 <= array.min() and array.max() <= 1.0:
                array = (array * 255).round().astype(np.uint8)
        encoded = base64.b64encode(png_bytes(array, 256)).decode("ascii")
        return f"data:image/png;base64,{encoded}"
    if kind == "pointcloud":
        return points_body(item, PREVIEW_POINTS)
    # 音声の後は (チャンネル, 標本の数) なので並びを戻す
    if kind == "audio":
        if after:
            return audio_view(np.asarray(item).T, int(rate or 0))
        return audio_view(item["samples"], int(item["sample_rate"]))
    if after:
        words = (state or {}).get("vocabulary", [])
        return [
            [int(k), words[int(k)] if 0 <= int(k) < len(words) else "?"]
            for k in np.asarray(item).ravel().tolist()
        ]
    view = str(item)[:2000]

    return view


def audio_rate(steps: list[dict[str, Any]], rate: int) -> int:
    """
    音声の中身の手順をかけた後の標本化の周波数を求める関数

    Parameters
    ----------
    steps: list[dict[str, Any]]
        中身の手順
    rate: int
        手順の前の標本化の周波数

    Returns
    ----------
    after: int
        最後の resample の rate (無ければ前の周波数)
    """
    # 周波数を変える手順は resample だけ
    after = next(
        (
            int(spec["rate"]) for spec in reversed(steps)
            if spec.get("op") == "resample"
        ),
        rate,
    )

    return after
