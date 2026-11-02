import pytest  # type: ignore

from gdbgui.server.app import app


@pytest.fixture
def test_client():
    """/login is public (http_util.PUBLIC_ENDPOINTS), so no logged-in session is needed."""
    return app.test_client()


def test_login_page_has_security_headers(test_client):
    response = test_client.get("/login")
    assert response.status_code == 200
    assert len(response.data) > 0
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
