"""靜態檔的快取標頭。

vendor/ 底下 15MB 的第三方檔案每次開頁都做條件式請求，是單核機器上最大的一筆
無謂負擔。這裡驗的是「vendor 可以無限期快取、app 自己的 JS 不行」這條分界——
分界劃錯的後果是學生拿到舊的前端，而那種 bug 只會在部署之後才看得見。
"""


def test_vendor_assets_are_cached_for_a_year(flask_app):
    resp = flask_app.test_client().get("/static/vendor/js/socket.io.js")

    assert resp.status_code == 200
    assert "max-age=31536000" in resp.headers["Cache-Control"]


def test_app_javascript_is_not_cached_long_term(flask_app):
    """webpack 產出的檔名沒有內容雜湊，長期快取會讓重新 build 的前端傳不出去。"""
    resp = flask_app.test_client().get("/static/js/main.js")

    if resp.status_code == 404:
        # 沒 build 過的環境（CI 只跑 python 測試）——分界本身仍然要成立
        assert flask_app.get_send_file_max_age("js/main.js") is None
        return

    assert "max-age=31536000" not in resp.headers.get("Cache-Control", "")
