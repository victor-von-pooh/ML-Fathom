from typing import Any, Literal, Optional

import ml_eda
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ml_fathom.api import find_source, load_source
from ml_fathom.jsonable import to_json

router = APIRouter(prefix="/api")

# 介入の記録の要約を求め, 効果の見積もりの問題の設定から始められるデータ
# の種類 (ML-EDA の describe_uplift と効果を見積もるが読むもの. 日時の列を
# 見つけた表も中身は表なので timeseries も)
UPLIFT_KINDS = ("table", "timeseries")

# 誤りとして理由を返す ML-EDA の例外 (列の誤り, 値の誤りなど)
INPUT_ERRORS = (ValueError, TypeError, KeyError)


class UpliftRequest(BaseModel):
    # 知らない欄の拒否 (取り違えた欄を黙って捨てないため)
    model_config = ConfigDict(extra="forbid")
    treatment: str = Field(min_length=1, description="処置の列")
    outcome: str = Field(min_length=1, description="結果の列")
    outcome_kind: Optional[Literal["binary", "amount"]] = Field(
        None, description="結果の種類 (省くと値から決める)"
    )
    id: Optional[str] = Field(None, description="行の id の列")


@router.post("/sources/{source_id}/uplift")
def describe(
    request: Request, source_id: str, body: UpliftRequest
) -> dict[str, Any]:
    """
    介入の記録の表の, 処置の群と対照の群の数, 結果の差, 釣り合いと気付きを
    返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    source_id: str
        データの ID
    body: UpliftRequest
        処置の列, 結果の列, 結果の種類, 行の id の列

    Returns
    ----------
    summary: dict[str, Any]
        ML-EDA の describe_uplift の結果

    Raises
    ----------
    HTTPException
        データが無ければ 404, 表でないか, 列と値の誤りは 422
    """
    # 読み込み済みの表を渡し, 読み直さない. 釣り合いの列は ML-EDA の既定
    data = load_source(find_source(request, source_id))
    if data.kind not in UPLIFT_KINDS:
        raise HTTPException(
            422, f"介入の記録の要約は表と時系列だけです (種類 {data.kind})"
        )
    try:
        summary: dict[str, Any] = to_json(ml_eda.describe_uplift(
            data, body.treatment, body.outcome,
            outcome_kind=body.outcome_kind, id=body.id or None
        ))
    except INPUT_ERRORS as error:
        raise HTTPException(
            422, f"介入の記録を要約できません: {error}"
        ) from error

    return summary
