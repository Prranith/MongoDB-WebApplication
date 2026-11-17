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


def test_ads_txt_publishes_the_configured_google_seller():
    response = app.test_client().get("/ads.txt")
    assert response.status_code == 200
    assert "google.com, pub-4522839473874735, DIRECT, f08c47fec0942fa0" in response.get_data(as_text=True)
