import json
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Literal, Optional

import ml_eda
import numpy as np
import yaml
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from ml_eda.pipeline import frame_view
from ml_eda.profile import to_json
from pydantic import BaseModel, Field

from ml_fathom.items import (
    capture_layer,
    item_response,
    item_view,
    png_response,
    points_response,
)
from ml_fathom.samples import sample_target, write_samples
from ml_fathom.store import SourceStore

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


# 読み込んだデータと分析の結果
DATA_CACHE = Cache(CACHE_SIZE)
PROFILE_CACHE = Cache(CACHE_SIZE * 4)

# 多視点の撮影の 1 件の中身 (各枚の場所と姿勢. 1 枚ずつの要求で読み直さ
# ないように)
CAPTURE_CACHE = Cache(CACHE_SIZE * 4)


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
        loaders, steps, kinds, 版
    """
    info = {
        "loaders": ml_eda.describe_loaders(),
        "steps": ml_eda.describe_steps(),
        "item_steps": ml_eda.describe_item_steps(),
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
        candidates: list[dict[str, Any]] = ml_eda.detect(body.path)
    except FileNotFoundError as error:
        raise HTTPException(404, str(error)) from error

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
        candidates = ml_eda.detect(path)
        if not candidates:
            raise HTTPException(422, f"{path.name} を読める読み込みがありません")
        loader = candidates[0]["loader"]
    draft = {"path": str(path), "loader": loader, "options": body.options}
    data = load_source(draft)
    # クラスのフォルダから読んだラベルは, 初めから目的の列にする
    store = get_store(request)
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
def get_profile(request: Request, source_id: str) -> dict[str, Any]:
    """
    データの分析の結果を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID

    Returns
    ----------
    result: dict[str, Any]
        概要 (summary) と ml_eda.profile の結果

    Raises
    ----------
    HTTPException
        無い場合は 404, 読めない場合は 422
    """
    # 目的の列ごとに分析を覚える
    source = find_source(request, source_id)
    key = json.dumps([source_key(source), source.get("target")])
    cached: Optional[dict[str, Any]] = PROFILE_CACHE.get(key)
    if cached is not None:
        return cached
    data = load_source(source)
    target = source.get("target")
    if target and target not in data.frame.columns:
        target = None
    try:
        analysis = ml_eda.profile(data, target=target)
    except (ValueError, TypeError) as error:
        raise HTTPException(422, f"分析できませんでした: {error}") from error
    result = {"summary": to_json(data.summary()), **analysis}
    PROFILE_CACHE.put(key, result)

    return result


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
        画像は PNG, 点群と文は JSON
    """
    data = load_source(find_source(request, source_id))
    if not 0 <= index < len(data.frame):
        raise HTTPException(404, f"{index} 番目はありません")
    response = item_response(data, index, size)

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
        cloud = ml_eda.media.read_cloud(Path(item["point_cloud"]))
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
        upto が全ての手順なら学習に使う列, 注意, 分割の後の気付き
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
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise HTTPException(422, str(error)) from error

    converted: dict[str, Any] = to_json(result)

    return converted


@router.post("/sources/{source_id}/item_preview")
def item_preview(
    request: Request, source_id: str, body: ItemPreviewRequest
) -> dict[str, Any]:
    """
    画像, 文, 点群の中身の手順を, 数件にかけた前と後を返す関数

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
        中身を持たない種類か, 手順が誤っている場合は 422
    """
    # 少ない見本で当てはめて, 画面で見せる形にする (画像の形の誤りも 422)
    data = load_source(find_source(request, source_id))
    try:
        result = ml_eda.preview_items(data, body.recipe, body.count)
        vocabulary = next(
            (
                spec.get("state") for spec in result["steps"]
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
                    item["after"], data.kind, True, vocabulary
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
        名前の誤りと前処理の失敗は 422, 既にある場合は 409
    """
    # 置き場の datasets の下に書き出し, レシピも保存
    store = get_store(request)
    data = load_source(find_source(request, source_id))
    try:
        target = store.dataset_dir(body.name)
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


def model_hints(path: Path, info: dict[str, Any]) -> dict[str, Any]:
    """
    書き出したデータセットに合わせてモデルを組むときの数を求める関数

    Parameters
    ----------
    path: Path
        書き出したデータセットの場所
    info: dict[str, Any]
        dataset.yaml の中身

    Returns
    ----------
    hints: dict[str, Any]
        input_shape (1 件の入力の形), input_dtype, vocabulary (文の語彙の
        大きさ. 文だけ), outputs (出力の幅. 分類はクラスの数, 目的が無ければ
        None, それ以外は 1)
    """
    # 画像などは中身の配列の形, 表は学習に使う列の数
    train = info["splits"]["train"]
    if "shape" in train:
        shape = [int(size) for size in train["shape"][1:]]
    else:
        shape = [len(info["features"])]
    # 目的の無いデータセット (task: none) は出力の幅を決めない
    task = info["task"]
    hints: dict[str, Any] = {
        "input_shape": shape,
        "input_dtype": "int64" if info["kind"] == "text" else "float32",
        "outputs": (
            len(info["classes"]) if task == "classification"
            else None if task == "none" else 1
        ),
    }
    # 文の語彙の大きさは, 書き出したレシピの当てはめた語彙から (読めなけれ
    # ば省く. 書き出しは済んでいるので誤りにしない)
    if info["kind"] == "text":
        try:
            recipe = yaml.safe_load(
                (path / "recipe.yaml").read_text(encoding="utf-8")
            )
            hints["vocabulary"] = next(
                len(step["state"]["vocabulary"])
                for step in recipe.get("item_steps") or []
                if step["op"] == "vocabulary"
            )
        except (OSError, yaml.YAMLError, KeyError, StopIteration,
                AttributeError, TypeError):
            pass

    return hints


@router.get("/datasets")
def list_datasets(request: Request) -> list[dict[str, Any]]:
    """
    書き出したデータセットの一覧を返す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    datasets: list[dict[str, Any]]
        名前, 場所, 種類, タスク, 分割の件数, 作った時刻
    """
    # datasets の下の dataset.yaml を読む
    root = get_store(request).home / "datasets"
    datasets = []
    if root.is_dir():
        for child in sorted(root.iterdir()):
            try:
                info = ml_eda.load_dataset(child).info
                splits = {
                    k: v.get("rows") for k, v in info["splits"].items()
                }
            except (OSError, ValueError, KeyError, TypeError,
                    AttributeError):
                continue
            datasets.append({
                "name": child.name, "path": str(child),
                "kind": info.get("kind"), "task": info.get("task"),
                "target": info.get("target"),
                "splits": splits,
                "features": len(info.get("features", [])),
                "created_at": info.get("created_at"),
            })
    datasets.sort(key=lambda item: str(item["created_at"]), reverse=True)

    return datasets

