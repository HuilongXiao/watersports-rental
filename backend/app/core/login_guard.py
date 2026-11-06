"""按来源 IP 的登录失败锁定。

规则：
- 同一 IP 5 分钟内失败 5 次：锁定 24 小时；
- 同一 IP 10 分钟内失败 10 次：永久锁定。

失败计数保存在进程内存（重启后清空）；锁定记录写入
``data/login_ip_blocks.json``，容器重启后依然生效。
永久锁定可通过删除该文件中对应 IP 的条目解除。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

SHORT_WINDOW_SECONDS = 5 * 60
LONG_WINDOW_SECONDS = 10 * 60
SHORT_WINDOW_LIMIT = 5
LONG_WINDOW_LIMIT = 10
LOCK_SECONDS = 24 * 60 * 60

BLOCK_FILE = Path(os.getenv("LOGIN_IP_BLOCK_FILE", "data/login_ip_blocks.json"))

_lock = threading.Lock()
_failures: dict[str, list[float]] = {}


@dataclass(frozen=True)
class BlockStatus:
    permanent: bool
    retry_after: int | None = None


def _load_blocks() -> dict:
    try:
        return json.loads(BLOCK_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("读取登录 IP 锁定文件失败，本次按无锁定处理：%s", BLOCK_FILE)
        return {}


def _save_blocks(blocks: dict) -> None:
    BLOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = BLOCK_FILE.with_name(BLOCK_FILE.name + ".tmp")
    tmp.write_text(json.dumps(blocks, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(BLOCK_FILE)


def check_block(client_ip: str) -> BlockStatus | None:
    """返回当前 IP 的锁定状态；未锁定或已到期时返回 None。"""
    now = time.time()
    with _lock:
        blocks = _load_blocks()
        entry = blocks.get(client_ip)
        if not entry:
            return None
        if entry.get("permanent"):
            return BlockStatus(permanent=True)
        until = float(entry.get("blocked_until") or 0)
        if until > now:
            return BlockStatus(permanent=False, retry_after=int(until - now) + 1)
        # 24 小时锁定已到期，清除记录，允许重新尝试。
        blocks.pop(client_ip, None)
        _save_blocks(blocks)
        return None


def record_failure(client_ip: str) -> BlockStatus | None:
    """记录一次登录失败；触发锁定时返回新的锁定状态。"""
    now = time.time()
    with _lock:
        timestamps = [ts for ts in _failures.get(client_ip, []) if now - ts <= LONG_WINDOW_SECONDS]
        timestamps.append(now)
        _failures[client_ip] = timestamps

        # 先判断永久锁定：10 分钟内累计 10 次。
        if len(timestamps) >= LONG_WINDOW_LIMIT:
            blocks = _load_blocks()
            blocks[client_ip] = {"permanent": True, "blocked_at": now}
            _save_blocks(blocks)
            _failures.pop(client_ip, None)
            return BlockStatus(permanent=True)

        # 再判断 24 小时锁定：5 分钟内累计 5 次。
        short_count = sum(1 for ts in timestamps if now - ts <= SHORT_WINDOW_SECONDS)
        if short_count >= SHORT_WINDOW_LIMIT:
            blocks = _load_blocks()
            blocks[client_ip] = {
                "permanent": False,
                "blocked_until": now + LOCK_SECONDS,
                "blocked_at": now,
            }
            _save_blocks(blocks)
            # 保留本次窗口内的失败时间戳：锁定期间继续尝试可触发永久锁定。
            return BlockStatus(permanent=False, retry_after=LOCK_SECONDS)

        return None


def record_blocked_attempt(client_ip: str) -> BlockStatus | None:
    """记录一次「已被 24 小时锁定仍继续尝试」的请求。

    只检查 10 分钟内累计 10 次的永久锁定条件；满足时返回永久锁定状态。
    """
    now = time.time()
    with _lock:
        timestamps = [ts for ts in _failures.get(client_ip, []) if now - ts <= LONG_WINDOW_SECONDS]
        timestamps.append(now)
        if len(timestamps) < LONG_WINDOW_LIMIT:
            _failures[client_ip] = timestamps
            return None
        blocks = _load_blocks()
        blocks[client_ip] = {"permanent": True, "blocked_at": now}
        _save_blocks(blocks)
        _failures.pop(client_ip, None)
        return BlockStatus(permanent=True)
