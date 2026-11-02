"""In-process failed-login rate limiter.

Keyed by ``(client_ip, username)``. After ``FAILURE_THRESHOLD`` consecutive
failures for a key, further attempts are refused for an exponentially growing
window, capped at ``BACKOFF_CAP_SECONDS``. A successful login clears the key.

The server runs on a single eventlet hub thread, so plain dicts are safe here
without locks (same assumption as live_quiz.py).

This module is stdlib-only and knows nothing about HTTP. Callers decide what a
blocked attempt looks like; auth.py makes it indistinguishable from a wrong
password.
"""

import time
from typing import Callable, Dict, List, Tuple

#: Injectable clock. Read at call time so tests can monkeypatch it.
_clock: Callable[[], float] = time.monotonic

FAILURE_THRESHOLD = 5
BACKOFF_CAP_SECONDS = 900
#: Hard bound on tracked keys. An attacker can make up arbitrary usernames, so
#: without a bound the dict would grow without limit.
MAX_ENTRIES = 10_000

# Entry layout: [failure_count, blocked_until_monotonic]
_FAILURES = 0
_BLOCKED_UNTIL = 1


class LoginRateLimiter:
    def __init__(self, max_entries: int = MAX_ENTRIES) -> None:
        self._entries: Dict[Tuple[str, str], List[float]] = {}
        self._max_entries = max_entries

    def is_blocked(self, ip: str, username: str) -> bool:
        entry = self._entries.get((ip, username))
        if entry is None:
            return False
        return _clock() < entry[_BLOCKED_UNTIL]

    def record_failure(self, ip: str, username: str) -> None:
        key = (ip, username)
        entry = self._entries.get(key)
        if entry is None:
            self._make_room()
            entry = [0, 0.0]
            self._entries[key] = entry
        entry[_FAILURES] += 1
        failures = int(entry[_FAILURES])
        if failures >= FAILURE_THRESHOLD:
            # 5th failure -> 1 s, 6th -> 2 s, ... capped. The exponent is capped
            # too so a long-running attacker cannot make this a huge int.
            exponent = min(failures - FAILURE_THRESHOLD, 20)
            window = min(2**exponent, BACKOFF_CAP_SECONDS)
            entry[_BLOCKED_UNTIL] = _clock() + window

    def record_success(self, ip: str, username: str) -> None:
        self._entries.pop((ip, username), None)

    def _make_room(self) -> None:
        """Keep the dict under ``max_entries`` before inserting a new key.

        1. Drop entries that are not currently blocked. They only hold a
           sub-threshold failure count, so losing them is cheap.
        2. If still full, evict the oldest-inserted entries (dict order = FIFO).

        Caveat: step 2 can evict a currently blocked entry, so a flood of
        distinct usernames could briefly reset a target's block. Accepting that
        is the price of a bounded dict. Step 1 keeps it rare because the flood
        has to outnumber every unblocked key before blocked ones are touched.
        """
        if len(self._entries) < self._max_entries:
            return
        now = _clock()
        for key in [k for k, e in self._entries.items() if now >= e[_BLOCKED_UNTIL]]:
            del self._entries[key]
        while len(self._entries) >= self._max_entries:
            del self._entries[next(iter(self._entries))]


#: Process-wide instance used by auth.py.
limiter = LoginRateLimiter()
