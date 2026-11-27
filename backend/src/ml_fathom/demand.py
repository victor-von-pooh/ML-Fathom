from typing import Any, Optional

import ml_eda
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ml_fathom.api import find_source, load_source
from ml_fathom.jsonable import to_json

# 頭なしの router (頭は mount する側が決める)
router = APIRouter()

# 需要の記録の要約を求められるデータの種類 (ML-EDA の describe_demand と需要
# の予測が読むもの. 日時の列を見つけた表も中身は表なので timeseries も)
DEMAND_KINDS = ("table", "timeseries")

# 誤りとして理由を返す ML-EDA の例外 (列の誤り, 値の誤りなど)
INPUT_ERRORS = (ValueError, TypeError, KeyError)


class DemandRequest(BaseModel):
    # 知らない欄の拒否 (取り違えた欄を黙って捨てないため)
    model_config = ConfigDict(extra="forbid")
    product: str = Field(min_length=1, description="商品の id の列")
    date: str = Field(min_length=1, description="日付の列")
    units: str = Field(min_length=1, description="日ごとの売れた数の列")
    stock: Optional[str] = Field(None, description="在庫の数の列")
    horizon: int = Field(7, ge=1, description="先の期間の日数")


@router.post("/sources/{source_id}/demand")
def describe(
    request: Request, source_id: str, body: DemandRequest
) -> dict[str, Any]:
    """
    需要の記録の表の, 日付の範囲, 売れた数, 曜日ごとの売れた数, 商品ごとの
    記録の日数と抜けの日, 在庫が 0 の日と気付きを返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: DemandRequest
        商品の id の列, 日付の列, 売れた数の列, 在庫の数の列, 先の期間の
        日数

    Returns
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_demand の結果

    Raises
    ----------
    HTTPException
        データが無ければ 404, 表でないか, 列の誤りは 422
    """
    # 読み込み済みの表を渡し, 読み直さない
    data = load_source(find_source(request, source_id))
    if data.kind not in DEMAND_KINDS:
        raise HTTPException(
            422, f"需要の記録の要約は表と時系列だけです (種類 {data.kind})"
        )
    try:
        summary: dict[str, Any] = to_json(ml_eda.describe_demand(
            data, body.product, body.date, body.units,
            stock=body.stock or None, horizon=body.horizon
        ))
    except INPUT_ERRORS as error:
        raise HTTPException(
            422, f"需要の記録を要約できません: {error}"
        ) from error

    return summary
