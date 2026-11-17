from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.auth import get_current_user
from app.models.user import User
from app.services import qweather

router = APIRouter(prefix="/api/weather", tags=["weather"])


@router.get("")
async def get_weather(
    latitude: float = Query(31.33, ge=-90, le=90),
    longitude: float = Query(121.52, ge=-180, le=180),
    days: int = Query(8, ge=1, le=8),
    _: User = Depends(get_current_user),
):
    """按店铺坐标返回实时/逐小时/逐天天气（和风天气代理，密钥不出后端）。"""
    try:
        return await qweather.fetch_weather(latitude, longitude, days)
    except Exception as exc:  # noqa: BLE001 - 统一降级为 502，前端显示加载失败
        raise HTTPException(status_code=502, detail="天气服务暂不可用") from exc
