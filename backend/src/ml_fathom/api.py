import json
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

import ml_eda
import ml_quest
import numpy as np
import yaml
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from ml_eda import ITEM_STEPS, frame_view
from pydantic import BaseModel, Field

from ml_fathom.datasets import dataset_summary, items_model
from ml_fathom.items import (
    audio_rate,
    audio_response,
    capture_layer,
    item_response,
    item_view,
    png_response,
    points_response,
)
from ml_fathom.jsonable import to_json
from ml_fathom.samples import sample_target, write_samples
from ml_fathom.settings import get_problems_dir
from ml_fathom.store import SourceStore
from ml_fathom.trajectories import (
    TRAJECTORY_KIND,
    TRAJECTORY_LOADER,
    TRAJECTORY_SCORE,
    may_be_trajectory,
    read_summary,
    trajectory_files,
)

router = APIRouter(prefix="/api")

# 見本を書いて登録する処理を 1 つずつにする鍵
SAMPLES_LOCK = threading.Lock()

# ファイルの変化を調べた結果を使い回す秒数と, 場所ごとの (時刻, 結果)
STAMP_SECONDS = 3.0
STAMPS: dict[str, tuple[float, list[Any]]] = {}

# 読み込んだデータと分析の結果を覚えておく数
CACHE_SIZE = 8

# 表の中身として一度に返す行の上限
MAX_ROWS = 500

# データセットの書き出しを 1 つずつにする鍵 (同じ名前の一時ディレクトリを
# 2 つの書き出しが同時に使わないように)
EXPORT_LOCK = threading.Lock()

# ファイルの組の書き出しの項目ごとに, 画面で選べる中身の手順 (登録簿の
# 種類と手順の名前). かけた後もその項目のファイルの形に収まるもので,
# ML-EDA の書き出しが受け付けるもの. 領域は画像の resize から ML-EDA が
# 決めるので無し
PAIR_STEPS: dict[str, dict[str, tuple[str, tuple[str, ...]]]] = {
    "image_masks": {"image": ("image", ("resize", "grayscale", "rgb"))},
    "capture_clouds": {
        "capture": ("image", ("resize", "grayscale", "rgb")),
        "cloud": ("pointcloud", ("sample_points",)),
    },
}

# 中身の手順の引数の上限 (手順を中身にかける前に確かめる. 大きすぎる値で
# 手元の計算機の記憶を使い切らないように. 同じ名前の引数はどの手順でも
# 同じ上限. 画像の辺は 4096 画素, 点の数は 100 万点, 音声の標本化の周波数
# は 192000 Hz, 長さは 600 秒, チャンネルは 32, 語彙の大きさと文の長さは
# 65536 まで)
STEP_LIMITS: dict[str, int | float] = {
    "width": 4096, "height": 4096, "points": 1_000_000,
    "rate": 192_000, "seconds": 600, "channels": 32,
    "max_tokens": 65_536, "length": 65_536,
}


class Cache:
    def __init__(self, size: int):
        # 覚えておく数を保存
        self.size = size
        self.items: OrderedDict[str, Any] = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key: str) -> Any:
        """
        覚えた値を返す関数

        Parameters
        ----------
        key: str
            鍵

        Returns
        ----------
        value: Any
            値, 無ければ None
        """
        # 使ったものを新しい側に移す
        with self.lock:
            value = self.items.get(key)
            if value is not None:
                self.items.move_to_end(key)

        return value

    def put(self, key: str, value: Any) -> None:
        """
        値を覚える関数 (多くなったら古いものから忘れる)

        Parameters
        ----------
        key: str
            鍵
        value: Any
            値

        Returns
        ----------
        None
        """
        # 上限を超えたら古いものを捨てる
        with self.lock:
            self.items[key] = value
            self.items.move_to_end(key)
            while len(self.items) > self.size:
                self.items.popitem(last=False)


# 異常の検知を分析し, 問題の設定から始められる表の種類 (ML-EDA の異常の
# 検知が読むもの. 日時の列を見つけた表も中身は表なので timeseries も)
ANOMALY_KINDS = ("table", "timeseries")

# 読み込んだデータと分析の結果
DATA_CACHE = Cache(CACHE_SIZE)
PROFILE_CACHE = Cache(CACHE_SIZE * 4)

# 多視点の撮影の 1 件の中身 (各枚の場所と姿勢. 1 枚ずつの要求で読み直さ
# ないように)
CAPTURE_CACHE = Cache(CACHE_SIZE * 4)

# 記録した軌跡の要約
TRAJECTORY_CACHE = Cache(CACHE_SIZE * 4)


class SourceCreate(BaseModel):
    path: str = Field(description="ファイルかディレクトリ (~ から書ける)")
    name: Optional[str] = Field(None, description="表示の名前")
    loader: Optional[str] = Field(None, description="読み込み (省略で推定)")
    options: dict[str, Any] = Field(default_factory=dict)


class SourceUpdate(BaseModel):
    name: Optional[str] = None
    target: Optional[str] = None
    loader: Optional[str] = None
    options: Optional[dict[str, Any]] = None


class DetectRequest(BaseModel):
    path: str


class RecipeBody(BaseModel):
    recipe: dict[str, Any]


class PreviewRequest(BaseModel):
    recipe: dict[str, Any]
    upto: int = Field(ge=0)


class ItemPreviewRequest(BaseModel):
    recipe: dict[str, Any]
    count: int = Field(8, ge=1, le=24)


class ExportRequest(BaseModel):
    recipe: dict[str, Any]
    name: str
    overwrite: bool = False


class PairSplit(BaseModel):
    # 分割のしかた (省略でグループがあれば group)
    method: Optional[Literal["random", "group", "none"]] = None
    # 正解の無い件を除くか unlabeled の分割に書くか (省略で除く)
    unlabeled: Optional[Literal["drop", "keep"]] = None
    valid: Annotated[float, Field(ge=0, lt=1)] = 0.2
    test: Annotated[float, Field(ge=0, lt=1)] = 0.0
    seed: int = 0


class PairOrigin(BaseModel):
    # 正解の出どころの種類 (確かめは ML-EDA)
    type: str = "unknown"
    name: Optional[str] = None
    settings: dict[str, Any] = Field(default_factory=dict)


class PairExport(BaseModel):
    name: str
    overwrite: bool = False
    split: PairSplit = PairSplit()
    groups: Optional[dict[str, str]] = Field(
        None, description="件の id からグループ"
    )
    origin: PairOrigin = PairOrigin()
    item_steps: Optional[dict[str, list[dict[str, Any]]]] = Field(
        None, description="項目の名前から中身の手順の並び"
    )
    follow_links: bool = Field(
        False, description="入力と正解のディレクトリの外を指すリンクの先も"
        "写すか"
    )


class ImageMaskExport(PairExport):
    images: str = Field(description="画像のディレクトリ")
    masks: str = Field(description="領域のディレクトリ")
    classes: Optional[dict[str, str]] = Field(
        None, description="領域の値から名前"
    )
    mask_suffix: str = ""


class CaptureCloudExport(PairExport):
    captures: str = Field(description="撮影のディレクトリ")
    clouds: str = Field(description="点群のディレクトリ")
    cloud_units: str = "meter"


def get_store(request: Request) -> SourceStore:
    """
    アプリのデータの置き場を返す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    store: SourceStore
        置き場
    """
    store: SourceStore = request.app.state.store

    return store


def find_source(request: Request, source_id: str) -> dict[str, Any]:
    """
    登録したデータを返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    source: dict[str, Any]
        登録したデータ

    Raises
    ----------
    HTTPException
        無い場合は 404
    """
    source = get_store(request).get(source_id)
    if source is None:
        raise HTTPException(404, f"データ {source_id} がありません")

    return source


def source_key(source: dict[str, Any]) -> str:
    """
    読み込んだ結果を覚える鍵を作る関数 (ファイルが変われば別の鍵)

    Parameters
    ----------
    source: dict[str, Any]
        登録したデータ

    Returns
    ----------
    key: str
        場所, 更新時刻, 読み込み, 設定から作った鍵
    """
    # 更新時刻 (ナノ秒), 大きさ, inode が変われば読み直す. ディレクトリは
    # 中のファイル (2 階層まで) の最新の更新時刻と数も見る. 中身を並べる
    # 画面は 1 件ごとに呼ぶので, 数秒の間は前に調べた結果を使う
    path = Path(source["path"])
    now = time.monotonic()
    remembered = STAMPS.get(source["path"])
    if remembered and now - remembered[0] < STAMP_SECONDS:
        stamp = remembered[1]
    else:
        stamp = file_stamp(path)
        STAMPS[source["path"]] = (now, stamp)
    key = json.dumps(
        [source["path"], stamp, source["loader"], source["options"]],
        sort_keys=True, default=str
    )

    return key


def file_stamp(path: Path) -> list[Any]:
    """
    ファイルかディレクトリが変わったかを見分ける値を返す関数

    Parameters
    ----------
    path: Path
        ファイルかディレクトリ

    Returns
    ----------
    stamp: list[Any]
        更新時刻, 大きさ, inode (ディレクトリは中のファイルの数と最新の
        更新時刻も). 読めなければ [0]
    """
    # 中のファイルは 2 階層まで
    try:
        stat = path.stat()
        stamp: list[Any] = [stat.st_mtime_ns, stat.st_size, stat.st_ino]
        if path.is_dir():
            children = [*path.glob("*"), *path.glob("*/*")]
            stamp += [
                len(children),
                max((c.stat().st_mtime_ns for c in children), default=0),
            ]
    except OSError:
        stamp = [0]

    return stamp


def load_source(source: dict[str, Any]) -> ml_eda.Data:
    """
    登録したデータを読み込む関数 (覚えていればそれを使う)

    Parameters
    ----------
    source: dict[str, Any]
        登録したデータ

    Returns
    ----------
    data: ml_eda.Data
        読み込んだデータ

    Raises
    ----------
    HTTPException
        読めない場合は 422
    """
    # 記録した軌跡は表として読まず, 軌跡の要約だけを返す
    if source["loader"] == TRAJECTORY_LOADER:
        raise HTTPException(
            422, "記録した軌跡は表として読みません. 「データを追加」から"
            "読み込み trajectory で登録し, 軌跡の分析で見てください"
        )
    # 覚えていれば使い, 無ければ読み込む
    key = source_key(source)
    data = DATA_CACHE.get(key)
    if data is not None:
        return data
    try:
        data = ml_eda.load_data(
            source["path"], loader=source["loader"], **source["options"]
        )
    except (
        OSError, ValueError, ImportError, TypeError, LookupError
    ) as error:
        raise HTTPException(422, f"読み込めませんでした: {error}") from error
    DATA_CACHE.put(key, data)

    return data


def source_view(source: dict[str, Any]) -> dict[str, Any]:
    """
    一覧に出す形にする関数 (ファイルがあるかを加える)

    Parameters
    ----------
    source: dict[str, Any]
        登録したデータ

    Returns
    ----------
    view: dict[str, Any]
        登録したデータと, ファイルがあるか
    """
    view = {**source, "exists": Path(source["path"]).exists()}

    return view


def item_step_infos() -> list[dict[str, Any]]:
    """
    版 1 のレシピで選べる中身の手順を, 引数の上限を添えて返す関数

    画面が上限を超えた値を送る前に止められるように, 手順の引数のうち
    STEP_LIMITS にあるものの上限を添える

    Parameters
    ----------
    None

    Returns
    ----------
    steps: list[dict[str, Any]]
        手順 (op, kind, params, description, fits, limits) の並び
    """
    # 登録簿の順のまま, 引数の上限を添える
    steps = [
        {
            **item,
            "limits": {
                name: STEP_LIMITS[name] for name in item["params"]
                if name in STEP_LIMITS
            },
        }
        for item in ml_eda.describe_item_steps()
    ]

    return steps


def pair_steps() -> dict[str, dict[str, list[dict[str, Any]]]]:
    """
    ファイルの組の書き出しの項目ごとに, 選べる中身の手順を返す関数

    ML-EDA の手順の登録簿を項目の種類で絞り, 省けない引数を添える

    Parameters
    ----------
    None

    Returns
    ----------
    steps: dict[str, dict[str, list[dict[str, Any]]]]
        書き出し (image_masks, capture_clouds) から, 項目の名前から手順
        (op, kind, params, description, fits, limits, required) の並び
    """
    # 登録簿の順のまま, 項目の種類と名前で絞る
    described = item_step_infos()
    steps: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for form, entries in PAIR_STEPS.items():
        steps[form] = {}
        for entry, (kind, ops) in entries.items():
            steps[form][entry] = [
                {**item, "required": list(ITEM_STEPS[item["op"]].required)}
                for item in described
                if item["kind"] == kind and item["op"] in ops
            ]

    return steps


def check_step_limits(item_steps: Any) -> None:
    """
    中身の手順の引数が上限 (STEP_LIMITS) を超えていないことを確かめる関数

    形の誤り (辞書でない, 整数でないなど) は ML-EDA が書き出すときに
    確かめるので, ここでは数の引数の大きさだけを見る

    Parameters
    ----------
    item_steps: Any
        項目の名前から中身の手順の並び (ファイルの組の書き出し), 手順の
        並び (版 1 のレシピ), 無ければ None

    Returns
    ----------
    None

    Raises
    ----------
    HTTPException
        上限を超えた引数があれば 422
    """
    # 項目ごとの手順の数の引数 (版 1 のレシピの並びは 1 つの項目として)
    if isinstance(item_steps, list):
        item_steps = {"中身の": item_steps}
    if not isinstance(item_steps, dict):
        return
    for entry, steps in item_steps.items():
        if not isinstance(steps, list):
            continue
        label = entry if entry == "中身の" else f"{entry} の"
        for number, spec in enumerate(steps, 1):
            if not isinstance(spec, dict):
                continue
            for name, highest in STEP_LIMITS.items():
                value = spec.get(name)
                if isinstance(value, bool) or not isinstance(
                    value, (int, float)
                ):
                    continue
                if value > highest:
                    raise HTTPException(
                        422, f"{label}手順 {number} の {spec.get('op')} の "
                        f"{name} ({value}) は {highest} 以下にしてください"
                    )


def check_recipe_limits(recipe: Any) -> None:
    """
    版 1 のレシピの中身の手順の引数が上限を超えていないことを確かめる関数

    中身の手順を中身にかける経路 (数件で試す, 書き出し, プロジェクトへの
    書き出し) は全てこれを通す

    Parameters
    ----------
    recipe: Any
        レシピ (辞書でなければ確かめない)

    Returns
    ----------
    None

    Raises
    ----------
    HTTPException
        上限を超えた引数があれば 422
    """
    # レシピの item_steps (並び)
    if isinstance(recipe, dict):
        check_step_limits(recipe.get("item_steps"))


@router.get("/info")
def get_info() -> dict[str, Any]:
    """
    読み込みと前処理の手順の一覧を返す関数

    Parameters
    ----------
    None

    Returns
    ----------
    info: dict[str, Any]
        loaders, steps, item_steps (引数の上限付き), pair_steps (ファイルの
        組の書き出しの項目ごとの中身の手順), kinds, 版
    """
    info = {
        "loaders": ml_eda.describe_loaders(),
        "steps": ml_eda.describe_steps(),
        "item_steps": item_step_infos(),
        "pair_steps": pair_steps(),
        "kinds": list(ml_eda.KINDS),
        "version": ml_eda.__version__,
    }

    return info


@router.get("/browse")
def browse(path: str = "~") -> dict[str, Any]:
    """
    ディレクトリの中身を返す関数 (データのファイルを選ぶため)

    Parameters
    ----------
    path: str = "~"
        ディレクトリ (~ から書ける)

    Returns
    ----------
    listing: dict[str, Any]
        path, parent, entries (名前, 場所, ディレクトリか, 大きさ)

    Raises
    ----------
    HTTPException
        ディレクトリでない場合は 404
    """
    # 隠しファイルを除いて, ディレクトリを先に名前の順で並べる
    target = Path(path).expanduser().resolve()
    if not target.is_dir():
        raise HTTPException(404, f"{target} はディレクトリではありません")
    entries = []
    try:
        children = sorted(
            target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())
        )
    except PermissionError as error:
        raise HTTPException(403, "読む権限がありません") from error
    visible = [c for c in children if not c.name.startswith(".")]
    for child in visible[:1000]:
        try:
            size = child.stat().st_size if child.is_file() else None
        except OSError:
            continue
        entries.append({
            "name": child.name, "path": str(child),
            "is_dir": child.is_dir(), "size": size,
        })
    listing = {
        "path": str(target),
        "parent": str(target.parent) if target.parent != target else None,
        "home": str(Path.home()),
        "entries": entries,
        "truncated": len(visible) > 1000,
    }

    return listing


@router.post("/detect")
def detect(body: DetectRequest) -> list[dict[str, Any]]:
    """
    場所を読めそうな読み込みの候補を返す関数

    Parameters
    ----------
    body: DetectRequest
        場所

    Returns
    ----------
    candidates: list[dict[str, Any]]
        読み込み, 種類, 確からしさ

    Raises
    ----------
    HTTPException
        場所が無い場合は 404
    """
    try:
        candidates = candidates_of(Path(body.path).expanduser())
    except FileNotFoundError as error:
        raise HTTPException(404, str(error)) from error

    return candidates


def candidates_of(path: Path) -> list[dict[str, Any]]:
    """
    ML-EDA の読み込みの候補に, 記録した軌跡の候補を加える関数

    Parameters
    ----------
    path: Path
        場所

    Returns
    ----------
    candidates: list[dict[str, Any]]
        読み込み, 種類, 確からしさ (軌跡として読めれば, その候補が先頭)

    Raises
    ----------
    FileNotFoundError
        場所が無い場合
    """
    # 軌跡の表は普通の表としても読めるので, 軌跡を先に並べる
    candidates: list[dict[str, Any]] = ml_eda.detect(path)
    if may_be_trajectory(path):
        try:
            trajectory_summary(path)
        except HTTPException:
            return candidates
        candidates = [{
            "loader": TRAJECTORY_LOADER, "kind": TRAJECTORY_KIND,
            "score": TRAJECTORY_SCORE,
        }, *candidates]

    return candidates


@router.get("/sources")
def list_sources(request: Request) -> list[dict[str, Any]]:
    """
    登録したデータの一覧を返す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    sources: list[dict[str, Any]]
        登録したデータ (新しい順)
    """
    sources = [source_view(item) for item in get_store(request).read()]

    return sources


@router.post("/sources", status_code=201)
def create_source(request: Request, body: SourceCreate) -> dict[str, Any]:
    """
    データを登録する関数 (読み込めることを確かめる)

    Parameters
    ----------
    request: Request
        リクエスト
    body: SourceCreate
        場所, 名前, 読み込み, 設定

    Returns
    ----------
    source: dict[str, Any]
        登録したデータ

    Raises
    ----------
    HTTPException
        場所が無い場合は 404, 読めない場合は 422
    """
    # 読み込みを決めて, 実際に読めることを確かめる
    path = Path(body.path).expanduser().resolve()
    if not path.exists():
        raise HTTPException(404, f"{path} がありません")
    loader = body.loader
    if loader is None:
        candidates = candidates_of(path)
        if not candidates:
            raise HTTPException(422, f"{path.name} を読める読み込みがありません")
        loader = candidates[0]["loader"]
    store = get_store(request)
    # 記録した軌跡は, 読めることを確かめて設定なしで登録する
    if loader == TRAJECTORY_LOADER:
        trajectory_summary(path)
        source = store.add(
            path, body.name or path.name, loader, TRAJECTORY_KIND, {}
        )
        return source_view(source)
    draft = {"path": str(path), "loader": loader, "options": body.options}
    data = load_source(draft)
    # クラスのフォルダから読んだラベルは, 初めから目的の列にする
    source = store.add(
        path, body.name or path.name, loader, data.kind, body.options
    )
    if data.roles.get("label"):
        source = store.update(
            source["id"], {"target": data.roles["label"]}
        ) or source

    return source_view(source)


@router.post("/samples")
def add_samples(request: Request) -> list[dict[str, Any]]:
    """
    操作を試すための見本のデータを置き場に書いて登録する関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    sources: list[dict[str, Any]]
        登録した見本 (登録済みの場所は登録し直さない. 途中で失敗した
        場合は, もう一度呼ぶと残りを登録する)

    Raises
    ----------
    HTTPException
        見本を書けない場合は 500
    """
    # 2 つの要求が同時に来ても 2 重に登録しないように, 全体を 1 つずつ
    store = get_store(request)
    with SAMPLES_LOCK:
        try:
            paths = write_samples(store.home / "samples")
        except OSError as error:
            raise HTTPException(
                500, f"見本を書けませんでした: {error}"
            ) from error
        registered = {item.get("path") for item in store.read()}
        sources = []
        # 一覧は新しいものが先なので, 表が先頭に来るように後ろから登録
        for name, path in reversed(paths.items()):
            if str(path.resolve()) in registered:
                continue
            source = create_source(
                request, SourceCreate(path=str(path), name=name, loader=None)
            )
            # 表と時系列は予測したい列を目的の列にする
            target = sample_target(name)
            if target:
                source = source_view(
                    store.update(source["id"], {"target": target}) or source
                )
            sources.append(source)

    return sources


@router.patch("/sources/{source_id}")
def update_source(
    request: Request, source_id: str, body: SourceUpdate
) -> dict[str, Any]:
    """
    データの名前, 目的の列, 読み込みの設定を変える関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: SourceUpdate
        変える項目

    Returns
    ----------
    source: dict[str, Any]
        変えた後のデータ

    Raises
    ----------
    HTTPException
        無い場合は 404, 読めない設定や無い列の場合は 422
    """
    # 読み込みの設定を変える場合は, 読めることを確かめて種類を更新. 名前と
    # 読み込みの null は無視し, 目的の列の空の文字は「なし」とする
    source = find_source(request, source_id)
    changes = body.model_dump(exclude_unset=True)
    for key in ("name", "loader", "options"):
        if changes.get(key) is None:
            changes.pop(key, None)
    if "target" in changes and not changes["target"]:
        changes["target"] = None
    merged = {**source, **{k: v for k, v in changes.items()}}
    if "loader" in changes or "options" in changes:
        data = load_source(merged)
        changes["kind"] = data.kind
        # 読み直して目的の列が無くなった場合 (ヘッダーの行を変えたなど) は外す
        if "target" not in changes and source.get("target") not in (
            None, *map(str, data.frame.columns)
        ):
            changes["target"] = None
            merged["target"] = None
    target = changes.get("target")
    if target:
        data = load_source(merged)
        if target not in data.frame.columns:
            raise HTTPException(422, f"列 {target} がありません")
    updated = get_store(request).update(source_id, changes)
    if updated is None:
        raise HTTPException(404, f"データ {source_id} がありません")

    return source_view(updated)


@router.delete("/sources/{source_id}", status_code=204)
def delete_source(request: Request, source_id: str) -> Response:
    """
    データの登録を外す関数 (元のファイルは消さない)

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    response: Response
        空の応答

    Raises
    ----------
    HTTPException
        無い場合は 404
    """
    if not get_store(request).remove(source_id):
        raise HTTPException(404, f"データ {source_id} がありません")
    response = Response(status_code=204)

    return response


@router.get("/sources/{source_id}/profile")
def get_profile(
    request: Request, source_id: str,
    task: Optional[Literal["anomaly"]] = None
) -> dict[str, Any]:
    """
    データの分析の結果を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    task: Optional[Literal["anomaly"]] = None
        anomaly の場合は目的の列を異常の正解として数える (表と時系列だけ.
        他の種類では数えない)

    Returns
    ----------
    result: dict[str, Any]
        概要 (summary) と ml_eda.profile の結果

    Raises
    ----------
    HTTPException
        無い場合は 404, 読めない場合は 422
    """
    # 目的の列とタスクごとに分析を覚える. 異常の検知を読まない種類では
    # 数えない (概要と気付きを誤りにしないため)
    source = find_source(request, source_id)
    if source["kind"] not in ANOMALY_KINDS:
        task = None
    key = json.dumps([source_key(source), source.get("target"), task])
    cached: Optional[dict[str, Any]] = PROFILE_CACHE.get(key)
    if cached is not None:
        return cached
    data = load_source(source)
    target = source.get("target")
    if target and target not in data.frame.columns:
        target = None
    try:
        analysis = ml_eda.profile(data, target=target, task=task)
    except (ValueError, TypeError) as error:
        raise HTTPException(422, f"分析できませんでした: {error}") from error
    result = {"summary": to_json(data.summary()), **analysis}
    PROFILE_CACHE.put(key, result)

    return result


@router.get("/sources/{source_id}/trajectory")
def get_trajectory(request: Request, source_id: str) -> dict[str, Any]:
    """
    記録した軌跡の要約を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_trajectory の結果

    Raises
    ----------
    HTTPException
        無い場合は 404, 軌跡でないか読めない場合は 422
    """
    # 表と隣の説明のどちらが変わっても読み直す
    source = find_source(request, source_id)
    if source["loader"] != TRAJECTORY_LOADER:
        raise HTTPException(
            422, f"{source['name']} は記録した軌跡ではありません"
        )
    summary = trajectory_summary(Path(source["path"]))

    return summary


def trajectory_summary(path: Path) -> dict[str, Any]:
    """
    記録した軌跡の要約を返す関数 (覚えていればそれを使う)

    候補を出すときに読んだ結果を, 登録と画面でも使い回す

    Parameters
    ----------
    path: Path
        表か説明

    Returns
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_trajectory の結果

    Raises
    ----------
    HTTPException
        無い場合は 404, 読めない場合は 422
    """
    # 表と隣の説明のどちらが変わっても読み直す
    place = Path(os.path.abspath(path.expanduser()))
    key = json.dumps(
        [str(place), [file_stamp(p) for p in trajectory_files(place)]]
    )
    cached: Optional[dict[str, Any]] = TRAJECTORY_CACHE.get(key)
    if cached is not None:
        return cached
    summary = read_summary(place)
    TRAJECTORY_CACHE.put(key, summary)

    return summary


@router.get("/sources/{source_id}/rows")
def get_rows(
    request: Request, source_id: str,
    offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=MAX_ROWS),
    sort: Optional[str] = None, descending: bool = False,
    query: Optional[str] = None
) -> dict[str, Any]:
    """
    表の中身を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    offset: int = 0
        先頭から飛ばす行の数
    limit: int = 100
        返す行の数 (500 まで)
    sort: Optional[str] = None
        並べ替える列
    descending: bool = False
        大きい順か
    query: Optional[str] = None
        どれかの列に含む文字で絞り込む

    Returns
    ----------
    rows: dict[str, Any]
        全体の行数, 列, 行 (と元の行の位置)
    """
    # 絞り込みと並べ替えをしてから切り出す
    data = load_source(find_source(request, source_id))
    frame = data.frame
    if query:
        text = frame.astype(str)
        mask = text.apply(
            lambda column: column.str.contains(query, case=False, regex=False)
        ).any(axis=1)
        frame = frame[mask]
    if sort and sort in frame.columns:
        frame = frame.sort_values(
            sort, ascending=not descending, kind="stable",
            na_position="last"
        )
    page = frame.iloc[max(offset, 0):max(offset, 0) + min(limit, MAX_ROWS)]
    view = frame_view(page, len(page))
    rows = {
        "total": int(len(frame)),
        "offset": max(offset, 0),
        "columns": view["columns"],
        "rows": view["head"],
        "index": [int(i) for i in page.index],
    }

    return rows


@router.get("/sources/{source_id}/items/{index}")
def get_item(
    request: Request, source_id: str, index: int,
    size: Optional[int] = Query(None, ge=16, le=2048)
) -> Response:
    """
    画像や点群など, 1 件の中身を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    index: int
        行の位置
    size: Optional[int] = Query(None, ge=16, le=2048)
        画像を縮める長い辺の画素数 (一覧の小さな表示用)

    Returns
    ----------
    response: Response
        画像は PNG, 点群と文と音声の波形は JSON
    """
    data = load_source(find_source(request, source_id))
    if not 0 <= index < len(data.frame):
        raise HTTPException(404, f"{index} 番目はありません")
    response = item_response(data, index, size)

    return response


@router.get("/sources/{source_id}/items/{index}/audio")
def get_item_audio(
    request: Request, source_id: str, index: int
) -> Response:
    """
    音声の 1 件の先頭を, 再生用の WAVE で返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    index: int
        行の位置

    Returns
    ----------
    response: Response
        先頭の AUDIO_SECONDS 秒までの 16 bit の PCM の WAVE
    """
    data = load_source(find_source(request, source_id))
    if not 0 <= index < len(data.frame):
        raise HTTPException(404, f"{index} 番目はありません")
    response = audio_response(data, index)

    return response


@router.get("/sources/{source_id}/items/{index}/frames/{frame}")
def get_capture_frame(
    request: Request, source_id: str, index: int, frame: int,
    layer: Literal["image", "depth", "confidence"] = "image",
    size: Optional[int] = Query(None, ge=16, le=2048)
) -> Response:
    """
    多視点の撮影の 1 枚の画像, 深度, 信頼度を PNG で返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    index: int
        撮影の行の位置
    frame: int
        枚の番号
    layer: Literal["image", "depth", "confidence"] = "image"
        返す層
    size: Optional[int] = Query(None, ge=16, le=2048)
        縮める長い辺の画素数

    Returns
    ----------
    response: Response
        PNG (深度は欠けを除いた 2 % 点から 98 % 点で 0 から 255 に,
        信頼度は値のまま)
    """
    # 撮影の中身から, 撮影のディレクトリの中に限った場所だけを読む
    item = capture_of(request, source_id, index)
    try:
        array = capture_layer(item, frame, layer)
        response = png_response(array, size)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(422, f"読めませんでした: {error}") from error
    response.headers["Cache-Control"] = "private, max-age=60"

    return response


@router.get("/sources/{source_id}/items/{index}/cloud")
def get_capture_cloud(
    request: Request, source_id: str, index: int
) -> Response:
    """
    多視点の撮影の点群を, 画面で描く点と色の JSON で返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    index: int
        撮影の行の位置

    Returns
    ----------
    response: Response
        点と色の JSON (5 万点まで間引く)
    """
    # 撮影のディレクトリの中の点群だけ
    item = capture_of(request, source_id, index)
    if not item.get("point_cloud"):
        raise HTTPException(404, "この撮影には点群がありません")
    try:
        cloud = ml_eda.read_cloud(Path(item["point_cloud"]))
    except Exception as error:
        raise HTTPException(422, f"読めませんでした: {error}") from error
    response = points_response(cloud)

    return response


def capture_of(
    request: Request, source_id: str, index: int
) -> dict[str, Any]:
    """
    多視点の撮影の 1 件の中身を返す関数 (読み込みが同じ間は覚える)

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    index: int
        撮影の行の位置

    Returns
    ----------
    item: dict[str, Any]
        load_item で読んだ撮影の中身

    Raises
    ----------
    HTTPException
        多視点の撮影でない場合は 422, 無い行は 404, 読めない撮影は 422
    """
    # 種類と行の確かめ. 中身は読み込みの鍵と行の位置で覚える
    source = find_source(request, source_id)
    data = load_source(source)
    if data.kind != "capture":
        raise HTTPException(422, "多視点の撮影のデータではありません")
    if not 0 <= index < len(data.frame):
        raise HTTPException(404, f"{index} 番目はありません")
    key = f"{source_key(source)}:{index}"
    item: Optional[dict[str, Any]] = CAPTURE_CACHE.get(key)
    if item is not None:
        return item
    try:
        item = data.load_item(index)
    except Exception as error:
        raise HTTPException(422, f"読めませんでした: {error}") from error
    CAPTURE_CACHE.put(key, item)

    return item


@router.get("/sources/{source_id}/recipe")
def get_recipe(request: Request, source_id: str) -> dict[str, Any]:
    """
    データごとに保存したレシピを返す関数 (無ければ空のレシピ)

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    recipe: dict[str, Any]
        レシピ
    """
    # 保存したものが無ければ, 目的の列だけを入れた空のレシピ
    source = find_source(request, source_id)
    recipe = get_store(request).read_recipe(source_id) or {
        "format_version": 1, "target": source.get("target"),
        "task": "none", "steps": [],
        "split": {"method": "random", "valid": 0.2, "test": 0.0, "seed": 0},
    }

    return recipe


@router.put("/sources/{source_id}/recipe")
def put_recipe(
    request: Request, source_id: str, body: RecipeBody
) -> dict[str, Any]:
    """
    レシピを確かめて保存する関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: RecipeBody
        レシピ

    Returns
    ----------
    recipe: dict[str, Any]
        保存したレシピ

    Raises
    ----------
    HTTPException
        形の誤りは 422
    """
    find_source(request, source_id)
    try:
        recipe: dict[str, Any] = ml_eda.load_recipe(body.recipe)
    except (ValueError, TypeError, AttributeError) as error:
        raise HTTPException(422, str(error)) from error
    get_store(request).write_recipe(source_id, recipe)

    return recipe


@router.post("/sources/{source_id}/preview")
def preview(
    request: Request, source_id: str, body: PreviewRequest
) -> dict[str, Any]:
    """
    レシピの手順をかけた前と後の表を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: PreviewRequest
        レシピと, いくつ目の手順までかけるか

    Returns
    ----------
    result: dict[str, Any]
        前と後の行数, 列, 先頭の行, 足した列と消えた列,
        upto が全ての手順なら学習に使う列, 注意, 分割の後の気付き,
        異常の検知の行の数 (anomaly), 効果を見積もるの群の数 (uplift),
        値段を変える判断の値段の範囲 (price), 需要の予測の発注を決める日の
        範囲と期間の合計 (demand)
    """
    data = load_source(find_source(request, source_id))
    try:
        result = ml_eda.preview(data, body.recipe, body.upto)
        if body.upto >= len(body.recipe.get("steps", [])):
            # 画像などは中身を読まずに, 手順の確認と注意だけをする
            prepared = ml_eda.prepare(data, body.recipe, read_items=False)
            result["features"] = prepared.features
            result["notes"] = prepared.notes
            # 分割の後に分かる気付き (分割をまたぐグループや画像の重なり)
            result["findings"] = prepared.findings
            result["splits"] = {
                name: int(len(frame))
                for name, frame in prepared.frames.items()
            }
            result["classes"] = prepared.classes
            # 異常の検知の正解の有る無しと分割ごとの行の数 (書き出しの説明の
            # anomaly と同じ形. 他のタスクでは None)
            result["anomaly"] = prepared.anomaly
            # 効果を見積もるの分割ごとの群の行の数と結果の平均 (書き出しの
            # 説明の uplift と同じ形. 他のタスクでは None)
            result["uplift"] = prepared.uplift
            # 値段を変える判断の分割ごとの値段の範囲と売れた数の平均 (書き
            # 出しの説明の price と同じ形. 他のタスクでは None)
            result["price"] = prepared.price
            # 需要の予測の分割ごとの発注を決める日の範囲と期間の合計の平均
            # (書き出しの説明の demand と同じ形. 他のタスクでは None)
            result["demand"] = prepared.demand
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise HTTPException(422, str(error)) from error

    converted: dict[str, Any] = to_json(result)

    return converted


@router.post("/sources/{source_id}/item_preview")
def item_preview(
    request: Request, source_id: str, body: ItemPreviewRequest
) -> dict[str, Any]:
    """
    画像, 文, 点群, 音声の中身の手順を, 数件にかけた前と後を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: ItemPreviewRequest
        レシピと件数

    Returns
    ----------
    result: dict[str, Any]
        items (index, label, before, after, shape) と, 当てはめに使った
        件数

    Raises
    ----------
    HTTPException
        中身を持たない種類か, 手順が誤っているか, 引数が上限を超えた場合は
        422
    """
    # 手順の引数の上限を確かめ, 少ない見本で当てはめて, 画面で見せる形に
    # する (画像の形の誤りも 422)
    check_recipe_limits(body.recipe)
    data = load_source(find_source(request, source_id))
    try:
        result = ml_eda.preview_items(data, body.recipe, body.count)
        # 当てはめた最後の vocabulary (書き出しと model_inputs と同じ)
        vocabulary = next(
            (
                spec.get("state") for spec in reversed(result["steps"])
                if spec.get("op") == "vocabulary"
            ),
            None,
        )
        items = [
            {
                "index": item["index"],
                "label": item["label"],
                "shape": list(np.shape(item["after"])),
                "before": item_view(item["before"], data.kind),
                "after": item_view(
                    item["after"], data.kind, True, vocabulary,
                    audio_rate(
                        result["steps"], int(item["before"]["sample_rate"])
                    ) if data.kind == "audio" else None,
                ),
            }
            for item in result["items"]
        ]
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise HTTPException(422, str(error)) from error
    converted = {"items": items, "fit_rows": result["fit_rows"]}

    return converted


@router.post("/sources/{source_id}/export")
def export(
    request: Request, source_id: str, body: ExportRequest
) -> dict[str, Any]:
    """
    レシピで前処理して, 学習用のデータセットを書き出す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: ExportRequest
        レシピ, 名前, 置き換えるか

    Returns
    ----------
    result: dict[str, Any]
        書き出した場所と dataset.yaml の中身と, モデルを組むときの数

    Raises
    ----------
    HTTPException
        名前の誤り, 前処理の失敗, 上限を超えた手順の引数は 422, 既にある
        場合は 409
    """
    # 手順の引数の上限を確かめ, 置き場の datasets の下に書き出し, レシピも
    # 保存
    check_recipe_limits(body.recipe)
    store = get_store(request)
    data = load_source(find_source(request, source_id))
    try:
        target = store.dataset_dir(body.name)
        with EXPORT_LOCK:
            info = ml_eda.export_dataset(
                data, body.recipe, target, name=body.name,
                overwrite=body.overwrite
            )
    except FileExistsError as error:
        raise HTTPException(409, f"{body.name} は既にあります") from error
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise HTTPException(422, str(error)) from error
    store.write_recipe(source_id, ml_eda.load_recipe(body.recipe))
    result = {
        "path": str(target), "info": to_json(info),
        "hints": model_hints(target, info),
    }

    return result


def model_hints(
    path: Path, info: dict[str, Any], parent: Optional[int] = None
) -> dict[str, Any]:
    """
    書き出したデータセットに合わせてモデルを組むときの数を求める関数

    Parameters
    ----------
    path: Path
        書き出したデータセットの場所
    info: dict[str, Any]
        dataset.yaml の中身
    parent: Optional[int] = None
        開いた書き出し先の親の記述子 (渡すと ML-EDA が親に対してリンクを
        たどらずに読み, path の途中は使わない)

    Returns
    ----------
    hints: dict[str, Any]
        input_shape (1 件の入力の形), input_dtype, vocabulary (文の語彙の
        大きさ. 文だけ), outputs (出力の幅. 分類はクラスの数, 目的が無ければ
        None, それ以外は 1)
    """
    # 入力の形と型と出力の幅は ML-EDA の model_inputs (バッチの次元を除く)
    model = ml_eda.model_inputs(path, parent=parent)
    single = model["inputs"][0]
    hints: dict[str, Any] = {
        "input_shape": [int(size) for size in single["shape"][1:]],
        "input_dtype": single["dtype"],
        "outputs": model["outputs"],
    }
    # 文の語彙の大きさも ML-EDA の model_inputs から (書き出したレシピの最後
    # の vocabulary. 文でなければ無い)
    if single.get("vocabulary") is not None:
        hints["vocabulary"] = single["vocabulary"]

    return hints


def problem_datasets() -> list[tuple[Path, str]]:
    """
    ML-Pathfinder の置き場の問題の設定から, プロジェクトの記録の書き出し先
    を集める関数

    Parameters
    ----------
    None

    Returns
    ----------
    places: list[tuple[Path, str]]
        書き出し先 (project.dataset) と問題の設定の名前 (読めない問題の
        設定と, 記録の無いものは飛ばす)
    """
    # problems/<識別子>/problem.yaml (置き場が無いか読めなければ空)
    places: list[tuple[Path, str]] = []
    root = get_problems_dir()
    try:
        files = sorted(root.glob("*/problem.yaml")) if root.is_dir() else []
    except OSError:
        files = []
    for file in files:
        try:
            problem = ml_quest.load_problem(file)
        except (OSError, ValueError, TypeError, yaml.YAMLError):
            continue
        project = problem.get("project")
        written = project.get("dataset") if isinstance(project, dict) else None
        if isinstance(written, str) and Path(written).is_absolute():
            places.append((Path(written), str(problem.get("name") or "")))

    return places


@router.get("/datasets")
def list_datasets(request: Request) -> list[dict[str, Any]]:
    """
    書き出したデータセットの一覧を返す関数

    版 1 は load_dataset, 版 2 は load_items で読み分け, 読めないもの
    (知らない版など) も理由を付けて並べる

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    datasets: list[dict[str, Any]]
        名前, 場所, 版, 形 (table, items, unreadable), 作った時刻と,
        形ごとの中身 (新しい順. 時刻の無いものは後ろ). プロジェクトの
        ものは project (データか問題の設定の名前) と project_from (source
        か problem)
    """
    # datasets の下と, プロジェクトへ書き出した場所 (登録したデータと,
    # ML-Pathfinder の置き場の問題の設定の記録) の dataset.yaml を版で読み
    # 分ける (同じ場所は 1 つ)
    store = get_store(request)
    root = store.home / "datasets"
    # (場所, プロジェクトの元の名前, 元の種類 (source か problem))
    places: list[tuple[Path, Optional[str], Optional[str]]] = []
    if root.is_dir():
        places = [(child, None, None) for child in sorted(root.iterdir())]
    for source in store.read():
        written = source.get("project_dataset")
        if isinstance(written, str):
            places.append(
                (Path(written), str(source.get("name") or ""), "source")
            )
    places += [(place, name, "problem")
               for place, name in problem_datasets()]
    datasets = []
    seen: set[str] = set()
    for place, project, origin in places:
        key = str(place.resolve())
        summary = dataset_summary(place) if place.is_dir() else None
        if summary is None or key in seen:
            continue
        seen.add(key)
        if project is not None:
            summary.update(project=project, project_from=origin)
        datasets.append(summary)
    datasets.sort(key=created_of, reverse=True)

    return datasets


def created_of(summary: dict[str, Any]) -> str:
    """
    一覧の 1 件の作った時刻を, 並べ替えの鍵にする関数

    Parameters
    ----------
    summary: dict[str, Any]
        一覧の 1 件

    Returns
    ----------
    key: str
        作った時刻の文字 (無ければ空)
    """
    # 時刻の無いもの (読めないもの) は後ろ
    key = str(summary.get("created_at") or "")

    return key


def pair_options(body: PairExport) -> dict[str, Any]:
    """
    ファイルの組の書き出しに共通の引数を作る関数

    Parameters
    ----------
    body: PairExport
        書き出しの要求

    Returns
    ----------
    options: dict[str, Any]
        split, groups, origin, name, overwrite, item_steps, follow_links
    """
    # 分割のしかたは, 選んだ場合だけ method を渡す (既定はグループの有無で)
    split: dict[str, Any] = {
        "valid": body.split.valid, "test": body.split.test,
        "seed": body.split.seed,
    }
    if body.split.method:
        split["method"] = body.split.method
    if body.split.unlabeled:
        split["unlabeled"] = body.split.unlabeled
    options = {
        "split": split, "groups": body.groups or None,
        "origin": body.origin.model_dump(), "name": body.name,
        "overwrite": body.overwrite, "item_steps": body.item_steps or None,
        "follow_links": body.follow_links,
    }

    return options


def pair_result(
    target: Path, info: dict[str, Any], model: dict[str, Any]
) -> dict[str, Any]:
    """
    ファイルの組の書き出しの結果を, 画面に返す形にする関数

    Parameters
    ----------
    target: Path
        書き出した場所
    info: dict[str, Any]
        ML-EDA の書き出しの結果 (dataset.yaml の中身と, 注意の印
        notices)
    model: dict[str, Any]
        モデルに要るもの (items_model の結果)

    Returns
    ----------
    result: dict[str, Any]
        場所, dataset.yaml の中身 (notices を除く), 注意の文と, 注意の印
        (code, count, message と添え), モデルに要るもの (model) と求め
        られない理由 (model_error)
    """
    # 注意の文は画面で並べ, 注意の印は種類で案内を出し分けるので取り出す
    written = {key: value for key, value in info.items()
               if key != "notices"}
    result = {
        "path": str(target), "info": to_json(written),
        "notes": [str(note) for note in info.get("notes") or []],
        "notices": to_json(list(info.get("notices") or [])),
        **to_json(model),
    }

    return result


def exists_error(
    body: PairExport, error: FileExistsError
) -> HTTPException:
    """
    書き出す場所が既にある場合の 409 を作る関数

    Parameters
    ----------
    body: PairExport
        書き出しの要求
    error: FileExistsError
        ML-EDA の誤り (置き換えの指定が無いか, データセットでない場所)

    Returns
    ----------
    result: HTTPException
        409 (置き換えを指定した場合は ML-EDA の理由)
    """
    # 置き換えを指定していなければ名前で, していればデータセットでない場所
    detail = str(error) if body.overwrite else f"{body.name} は既にあります"
    result = HTTPException(409, detail)

    return result


def export_message(error: Exception) -> str:
    """
    書き出しの誤りを画面に出す文にする関数

    Parameters
    ----------
    error: Exception
        書き出しの誤り

    Returns
    ----------
    message: str
        ML-EDA の誤りの文 (想定していない誤りは種類を添える)
    """
    # 入力の誤り (ValueError) はそのまま, 他は壊れたファイルなどとして
    if isinstance(error, ValueError):
        message = str(error)
    else:
        message = f"書き出せませんでした ({type(error).__name__}): {error}"

    return message


@router.post("/datasets/image_masks")
def export_image_masks(
    request: Request, body: ImageMaskExport
) -> dict[str, Any]:
    """
    画像と領域の対を, 版 2 のデータセットに書き出す関数

    Parameters
    ----------
    request: Request
        リクエスト
    body: ImageMaskExport
        画像と領域のディレクトリ, 値の名前, 領域の名前の終わり, 分割,
        グループ, 正解の出どころ, 名前, 置き換えるか, 外を指すリンクの
        先も写すか

    Returns
    ----------
    result: dict[str, Any]
        書き出した場所, dataset.yaml の中身, 注意

    Raises
    ----------
    HTTPException
        名前と組と手順の誤りは 422, 既にある場合は 409
    """
    # 手順の引数の上限を確かめ, 置き場の datasets の下に書き出す
    check_step_limits(body.item_steps)
    store = get_store(request)
    try:
        target = store.dataset_dir(body.name)
        with EXPORT_LOCK:
            info = ml_eda.export_image_masks(
                Path(body.images).expanduser(),
                Path(body.masks).expanduser(), target,
                classes=body.classes or None,
                mask_suffix=body.mask_suffix, **pair_options(body)
            )
            # モデルに要るものも, 次の書き出しが入れ替える前に読む
            model = items_model(target, info.get("role"))
    except FileExistsError as error:
        raise exists_error(body, error) from error
    except Exception as error:  # noqa: BLE001 (壊れたファイルも理由を返す)
        raise HTTPException(422, export_message(error)) from error
    result = pair_result(target, info, model)

    return result


@router.post("/datasets/capture_clouds")
def export_capture_clouds(
    request: Request, body: CaptureCloudExport
) -> dict[str, Any]:
    """
    多視点の撮影と正解の点群の対を, 版 2 のデータセットに書き出す関数

    Parameters
    ----------
    request: Request
        リクエスト
    body: CaptureCloudExport
        撮影と点群のディレクトリ, 点群の単位, 分割, グループ, 正解の
        出どころ, 名前, 置き換えるか, 外を指すリンクの先も写すか

    Returns
    ----------
    result: dict[str, Any]
        書き出した場所, dataset.yaml の中身, 注意

    Raises
    ----------
    HTTPException
        名前と組と手順の誤りは 422, 既にある場合は 409
    """
    # 手順の引数の上限を確かめ, 置き場の datasets の下に書き出す
    check_step_limits(body.item_steps)
    store = get_store(request)
    try:
        target = store.dataset_dir(body.name)
        with EXPORT_LOCK:
            info = ml_eda.export_capture_clouds(
                Path(body.captures).expanduser(),
                Path(body.clouds).expanduser(), target,
                cloud_units=body.cloud_units, **pair_options(body)
            )
            # モデルに要るものも, 次の書き出しが入れ替える前に読む
            model = items_model(target, info.get("role"))
    except FileExistsError as error:
        raise exists_error(body, error) from error
    except Exception as error:  # noqa: BLE001 (壊れたファイルも理由を返す)
        raise HTTPException(422, export_message(error)) from error
    result = pair_result(target, info, model)

    return result
