"""Unit tests for the in-process failed-login rate limiter.

These exercise ``LoginRateLimiter`` directly (no Flask app, no database). The
HTTP-level check that a blocked login looks identical to a wrong password lives
with the auth tests, since it needs the app test client fixtures.
"""

import pytest

from gdbgui.server import ratelimit
from gdbgui.server.ratelimit import FAILURE_THRESHOLD, LoginRateLimiter


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock()
    monkeypatch.setattr(ratelimit, "_clock", fake)
    return fake


def _fail_n(limiter, ip, username, n):
    for _ in range(n):
        limiter.record_failure(ip, username)


def test_blocked_only_after_threshold_failures(clock):
    limiter = LoginRateLimiter()
    _fail_n(limiter, "1.2.3.4", "bob", FAILURE_THRESHOLD - 1)
    assert limiter.is_blocked("1.2.3.4", "bob") is False

    limiter.record_failure("1.2.3.4", "bob")
    assert limiter.is_blocked("1.2.3.4", "bob") is True


def test_block_expires_after_backoff(clock):
    limiter = LoginRateLimiter()
    _fail_n(limiter, "1.2.3.4", "bob", FAILURE_THRESHOLD)
    assert limiter.is_blocked("1.2.3.4", "bob") is True

    # 5th failure blocks for 2 ** 0 = 1 second.
    clock.now += 1.0
    assert limiter.is_blocked("1.2.3.4", "bob") is False


def test_backoff_doubles_per_failure_and_is_capped(clock):
    limiter = LoginRateLimiter()
    _fail_n(limiter, "1.2.3.4", "bob", FAILURE_THRESHOLD + 1)
    # 6th failure -> 2 ** 1 = 2 seconds.
    clock.now += 1.9
    assert limiter.is_blocked("1.2.3.4", "bob") is True
    clock.now += 0.2
    assert limiter.is_blocked("1.2.3.4", "bob") is False

    # Many failures later the window must not exceed the 15 minute cap.
    _fail_n(limiter, "1.2.3.4", "bob", 100)
    clock.now += ratelimit.BACKOFF_CAP_SECONDS
    assert limiter.is_blocked("1.2.3.4", "bob") is False


def test_record_success_clears_counter(clock):
    limiter = LoginRateLimiter()
    _fail_n(limiter, "1.2.3.4", "bob", FAILURE_THRESHOLD)
    assert limiter.is_blocked("1.2.3.4", "bob") is True

    limiter.record_success("1.2.3.4", "bob")
    assert limiter.is_blocked("1.2.3.4", "bob") is False

    # Counter starts over: four more failures are still below threshold.
    _fail_n(limiter, "1.2.3.4", "bob", FAILURE_THRESHOLD - 1)
    assert limiter.is_blocked("1.2.3.4", "bob") is False


def test_different_ip_has_independent_counter(clock):
    limiter = LoginRateLimiter()
    _fail_n(limiter, "1.2.3.4", "bob", FAILURE_THRESHOLD)
    assert limiter.is_blocked("1.2.3.4", "bob") is True
    assert limiter.is_blocked("9.9.9.9", "bob") is False


def test_different_username_has_independent_counter(clock):
    limiter = LoginRateLimiter()
    _fail_n(limiter, "1.2.3.4", "bob", FAILURE_THRESHOLD)
    assert limiter.is_blocked("1.2.3.4", "bob") is True
    assert limiter.is_blocked("1.2.3.4", "alice") is False


def test_success_on_one_key_does_not_clear_another(clock):
    limiter = LoginRateLimiter()
    _fail_n(limiter, "1.2.3.4", "bob", FAILURE_THRESHOLD)
    limiter.record_success("9.9.9.9", "bob")
    assert limiter.is_blocked("1.2.3.4", "bob") is True


def test_memory_is_bounded(clock):
    limiter = LoginRateLimiter(max_entries=10)
    for i in range(100):
        limiter.record_failure("1.2.3.4", f"user{i}")
    assert len(limiter._entries) <= 10


def test_flooding_distinct_usernames_does_not_grow_without_bound(clock):
    limiter = LoginRateLimiter(max_entries=50)
    for i in range(10_000):
        limiter.record_failure(f"10.0.{i // 256}.{i % 256}", "victim")
    assert len(limiter._entries) <= 50


# ---------------------------------------------------------------------------
# HTTP level: a blocked login must look exactly like a wrong password
# ---------------------------------------------------------------------------


def test_blocked_correct_password_is_indistinguishable_from_wrong_password(
    flask_app, monkeypatch
):
    from gdbgui.server import auth

    from .conftest import TEST_PASSWORD, register_user, unique_username

    fake = FakeClock()
    monkeypatch.setattr(ratelimit, "_clock", fake)

    user = register_user(flask_app, username=unique_username("rl"))
    client = flask_app.test_client()
    client.get("/login")
    with client.session_transaction() as sess:
        csrf = sess["csrf_token"]

    def attempt(password):
        return client.post(
            "/login",
            data={"csrf_token": csrf, "username": user.username, "password": password},
        )

    # Five wrong passwords from this client trip the limiter for this key.
    for _ in range(ratelimit.FAILURE_THRESHOLD):
        assert attempt("not-the-password").status_code == 401

    # Sixth attempt with the CORRECT password while blocked.
    blocked_correct = attempt(TEST_PASSWORD)
    blocked_wrong = attempt("still-not-the-password")

    assert blocked_correct.status_code == blocked_wrong.status_code == 401
    assert blocked_correct.data == blocked_wrong.data
    assert auth.LOGIN_FAILED_MESSAGE in blocked_correct.data.decode()
    with client.session_transaction() as sess:
        assert sess.get("user_id") is None
