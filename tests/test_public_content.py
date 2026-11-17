from api.index import app


def test_public_content_pages_are_reachable_and_indexable():
    client = app.test_client()
    for path in (
        "/about",
        "/faq",
        "/guides/sql-playground",
        "/guides/mongodb-playground",
        "/privacy",
        "/terms",
        "/contact",
    ):
        response = client.get(path)
        body = response.get_data(as_text=True)
        assert response.status_code == 200
        assert "<meta name=\"robots\" content=\"index,follow\">" in body
        assert "CodeLeaf" in body


def test_welcome_screen_links_to_all_public_information_pages():
    body = app.test_client().get("/").get_data(as_text=True)
    for path in (
        "/about",
        "/faq",
        "/guides/sql-playground",
        "/guides/mongodb-playground",
        "/privacy",
        "/terms",
        "/contact",
    ):
        assert f'href="/workspaceide{path}"' in body


def test_workspace_shell_renders_public_pages_inside_the_editor_grid():
    body = app.test_client().get("/").get_data(as_text=True)
    assert 'id="workspace-content-view"' in body
    assert 'function openWorkspaceContent' in body
    assert 'workspace-content-active' in body


def test_workspace_prefixed_content_routes_boot_the_editor_shell():
    client = app.test_client()
    for content_path in (
        "/about",
        "/faq",
        "/guides/sql-playground",
        "/guides/mongodb-playground",
        "/privacy",
        "/terms",
        "/contact",
    ):
        response = client.get(f"/workspaceide{content_path}")
        body = response.get_data(as_text=True)
        assert response.status_code == 200
        assert 'window.__CODELEAF_ROUTE' in body
        assert f'"content":"{content_path}"' in body
        assert 'content="noindex,follow"' in body


def test_ads_txt_publishes_the_configured_google_seller():
    response = app.test_client().get("/ads.txt")
    assert response.status_code == 200
    assert "google.com, pub-4522839473874735, DIRECT, f08c47fec0942fa0" in response.get_data(as_text=True)


def test_public_pages_include_the_adsense_site_code():
    client = app.test_client()
    for path in (
        "/about",
        "/faq",
        "/guides/sql-playground",
        "/guides/mongodb-playground",
        "/privacy",
        "/terms",
        "/contact",
    ):
        body = client.get(path).get_data(as_text=True)
        assert 'pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4522839473874735' in body
