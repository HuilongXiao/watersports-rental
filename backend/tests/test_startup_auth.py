def test_health_and_database_startup(client):
    assert client.get("/api/health").json() == {
        "status": "ok",
        "service": "rental-app-api",
    }
    assert client.get("/api/health/database").json() == {
        "status": "ok",
        "database": "connected",
    }


def test_seeded_admin_can_login_and_read_current_user(logged_in_client):
    client = logged_in_client
    current_user = client.get("/api/auth/me")
    assert current_user.status_code == 200
    assert current_user.json()["username"] == "superuserx"
    assert current_user.json()["is_system"] is False


def test_invalid_password_is_rejected(client):
    response = client.post(
        "/api/auth/login",
        data={"username": "superuserx", "password": "wrong-password"},
    )
    assert response.status_code == 401


def test_system_user_cannot_log_in(client):
    # The protected System User must never authenticate via the normal flow.
    response = client.post(
        "/api/auth/login",
        data={"username": "system", "password": "anything"},
    )
    assert response.status_code in (401, 403)


def test_logout_clears_session(logged_in_client):
    client = logged_in_client
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401
