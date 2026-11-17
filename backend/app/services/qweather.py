"""和风天气客户端（JWT / Ed25519 认证）。

- JWT 在服务端用私钥签发，15 分钟有效；私钥只保存在服务器上
- 实时、逐小时、逐天三个接口并行请求，合并成前端直接可用的结构
- 结果按坐标缓存 10 分钟，避免重复消耗免费额度
- 该账号的专属 API Host 只开放旧版 /v7 接口（新版 /weather/v1 返回 404），
  因此统一使用 /v7/weather/{now,24h,10d}；返回时间已是北京时间
"""

import asyncio
import base64
import json
import logging
import time
from functools import lru_cache

import httpx
from cryptography.hazmat.primitives import serialization

from app.core import config

logger = logging.getLogger(__name__)

TOKEN_TTL_SECONDS = 900
CACHE_TTL_SECONDS = 600
REQUEST_TIMEOUT_SECONDS = 8.0

# 旧版 v7 逐天接口只能按固定天数取，按需选择最接近的档位
DAILY_PATHS = ((3, "3d"), (7, "7d"), (10, "10d"), (15, "15d"), (30, "30d"))


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@lru_cache(maxsize=1)
def _private_key():
    return serialization.load_pem_private_key(
        config.QWEATHER_PRIVATE_KEY_PATH.read_bytes(), password=None
    )


_cached_token: str | None = None
_token_expires_at = 0.0


def _token() -> str:
    """生成（并复用）JWT：header 带 kid，payload 带开发者 ID 与项目 ID。"""
    global _cached_token, _token_expires_at
    now = int(time.time())
    if _cached_token and _token_expires_at - 60 > now:
        return _cached_token

    header = {"alg": "EdDSA", "kid": config.QWEATHER_CREDENTIAL_ID}
    payload = {
        "iss": config.QWEATHER_DEVELOPER_ID,
        "sub": config.QWEATHER_PROJECT_ID,
        "iat": now - 30,
        "exp": now + TOKEN_TTL_SECONDS,
    }
    unsigned = (
        f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}."
        f"{_b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    )
    signature = _private_key().sign(unsigned.encode())
    _cached_token = f"{unsigned}.{_b64url(signature)}"
    _token_expires_at = now + TOKEN_TTL_SECONDS
    return _cached_token


def _daily_path(days: int) -> str:
    for limit, suffix in DAILY_PATHS:
        if days <= limit:
            return f"/v7/weather/{suffix}"
    return "/v7/weather/30d"


def _num(value) -> float:
    return float(value)


async def _get(client: httpx.AsyncClient, path: str) -> dict:
    response = await client.get(
        f"https://{config.QWEATHER_API_HOST}{path}",
        headers={"Authorization": f"Bearer {_token()}"},
    )
    if response.status_code != 200:
        raise RuntimeError(f"和风天气请求失败：{path} HTTP {response.status_code}")
    payload = response.json()
    if str(payload.get("code")) != "200":
        raise RuntimeError(f"和风天气请求失败：{path} code {payload.get('code')}")
    return payload


_cache: dict[tuple[str, str], tuple[float, dict]] = {}


async def fetch_weather(latitude: float, longitude: float, days: int = 8) -> dict:
    """拉取当前天气、24 小时与逐天预报，返回前端使用的统一结构。"""
    cache_key = (f"{latitude:.3f}", f"{longitude:.3f}")
    cached = _cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    # 旧版 v7 用「经度,纬度」，坐标最多 2 位小数
    location = f"{longitude:.2f},{latitude:.2f}"
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        current, hourly, daily = await asyncio.gather(
            _get(client, f"/v7/weather/now?location={location}"),
            _get(client, f"/v7/weather/24h?location={location}"),
            _get(client, f"{_daily_path(days)}?location={location}"),
        )

    now = current["now"]
    result = {
        "current": {
            "temp": _num(now["temp"]),
            "feels_like": _num(now["feelsLike"]),
            "text": now["text"],
            "wind_dir": now["windDir"],
            "wind_scale": now["windScale"],
        },
        # v7 返回的时间已带 +08:00，直接透传
        "hourly": [
            {
                "time": hour["fxTime"],
                "temp": _num(hour["temp"]),
                "text": hour["text"],
                "precip": _num(hour["precip"]),
            }
            for hour in hourly.get("hourly", [])
        ],
        "daily": [
            {
                "date": day["fxDate"],
                "text": day["textDay"],
                "text_night": day["textNight"],
                "temp_max": _num(day["tempMax"]),
                "temp_min": _num(day["tempMin"]),
                "precip": _num(day["precip"]),
            }
            for day in daily.get("daily", [])[:days]
        ],
    }
    _cache[cache_key] = (time.monotonic(), result)
    return result
