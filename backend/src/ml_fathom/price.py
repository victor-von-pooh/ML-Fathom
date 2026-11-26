from typing import Any, Optional

import ml_eda
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ml_fathom.api import find_source, load_source
from ml_fathom.jsonable import to_json

router = APIRouter(prefix="/api")

# 値段を変えた記録の要約を求め, 値段を変える判断の問題の設定から始められる
# データの種類 (ML-EDA の describe_price と値段を変える判断が読むもの. 日時
# の列を見つけた表も中身は表なので timeseries も)
PRICE_KINDS = ("table", "timeseries")

# 誤りとして理由を返す ML-EDA の例外 (列の誤り, 値の誤りなど)
INPUT_ERRORS = (ValueError, TypeError, KeyError)


class PriceRequest(BaseModel):
    # 知らない欄の拒否 (取り違えた欄を黙って捨てないため)
    model_config = ConfigDict(extra="forbid")
    price: str = Field(min_length=1, description="値段の列")
    units: str = Field(min_length=1, description="売れた数の列")
    cost: Optional[str] = Field(None, description="原価の列")
    product: Optional[str] = Field(None, description="商品の id の列")
    id: Optional[str] = Field(None, description="行の id の列")


@router.post("/sources/{source_id}/price")
def describe(
    request: Request, source_id: str, body: PriceRequest
) -> dict[str, Any]:
    """
    値段を変えた記録の表の, 値段の幅と数, 値段と売れた数の関わり, 商品ごと
    の試した値段, 値段と他の列の関わりと気付きを返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: PriceRequest
        値段の列, 売れた数の列, 原価の列, 商品の id の列, 行の id の列

    Returns
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_price の結果

    Raises
    ----------
    HTTPException
        データが無ければ 404, 表でないか, 列の誤りは 422
    """
    # 読み込み済みの表を渡し, 読み直さない. 関わりの列は ML-EDA の既定
    data = load_source(find_source(request, source_id))
    if data.kind not in PRICE_KINDS:
        raise HTTPException(
            422, f"値段を変えた記録の要約は表と時系列だけです (種類 {data.kind})"
        )
    try:
        summary: dict[str, Any] = to_json(ml_eda.describe_price(
            data, body.price, body.units, cost=body.cost or None,
            product=body.product or None, id=body.id or None
        ))
    except INPUT_ERRORS as error:
        raise HTTPException(
            422, f"値段を変えた記録を要約できません: {error}"
        ) from error

    return summary
