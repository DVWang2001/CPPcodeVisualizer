"""靜態檔的快取標頭與壓縮。

vendor/ 底下 15MB 的第三方檔案每次開頁都做條件式請求，是單核機器上最大的一筆
無謂負擔。這裡驗的是「vendor 可以無限期快取、app 自己的 JS 不行」這條分界——
分界劃錯的後果是學生拿到舊的前端，而那種 bug 只會在部署之後才看得見。

壓縮那條測試存在的理由見 test_javascript_is_served_gzipped 的 docstring：
`Compress(app)` 那行對 JS 曾經整整空轉，而且沒有任何東西會告訴你。
"""


def test_vendor_assets_are_cached_for_a_year(flask_app):
    resp = flask_app.test_client().get("/static/vendor/js/jquery.min.js")

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


def test_javascript_is_served_gzipped(flask_app):
    """JS 必須壓縮送出。

    這條測試存在是因為它曾經是壞的，而且完全無聲：Flask-Compress 1.10.1 的預設
    COMPRESS_MIMETYPES 只有 `application/javascript`，但 IANA 後來把 JavaScript 的
    註冊型別改成 `text/javascript`，Werkzeug 跟著改了。結果是 `Compress(app)` 那行
    對**所有** JS 檔一直空轉——站台上 14.4 MB 的 JS 全部未壓縮送出（gzip 後只有
    3.5 MB，白送 76%）。使用者的症狀是點進教案要等兩分鐘。

    沒有任何錯誤訊息會告訴你這件事，只有實際去看 Content-Encoding 才看得到。
    """
    resp = flask_app.test_client().get(
        "/static/vendor/js/jquery.min.js", headers={"Accept-Encoding": "gzip"}
    )

    assert resp.status_code == 200
    assert resp.headers.get("Content-Encoding") == "gzip"
