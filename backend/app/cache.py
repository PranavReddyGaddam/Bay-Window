"""Tiny in-memory TTL cache. Adequate for an MVP; swap for Redis if scaling."""
import time
from threading import Lock
from typing import Any, Optional

from .config import CACHE_TTL_SECONDS


class TTLCache:
    def __init__(self, ttl: int = CACHE_TTL_SECONDS):
        self._ttl = ttl
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            item = self._store.get(key)
            if not item:
                return None
            expires, value = item
            if time.time() > expires:
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._store[key] = (time.time() + self._ttl, value)


cache = TTLCache()
