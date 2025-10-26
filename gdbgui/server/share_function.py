from flask import session, current_app, redirect, url_for

def require_uploaded_binary():
    """If no uploaded binary in session or default initial_binary_and_args,
    return a redirect Response to the upload page. Otherwise return None."""
    if not session.get("uploaded_binary") and not current_app.config.get(
        "initial_binary_and_args"
    ):
        # blueprint name is "http_routes", endpoint "upload"
        return redirect(url_for("http_routes.upload"))
    return None