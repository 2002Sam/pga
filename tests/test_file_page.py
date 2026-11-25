"""Exercise the real file-frame route, not a generic static fixture server."""
import re

from fastapi.testclient import TestClient

from pga.api.app import create_app
from pga.filepreview import describe


def test_file_page_and_dependencies_are_served():
    # No lifespan/database is needed for static assets.
    client = TestClient(create_app())
    response = client.get('/ui/file-page.html', params={
        'node': 'test-file', 'as': 'test-user', 'path': '/tmp/投递 计划.xlsx',
    })
    assert response.status_code == 200, response.text
    assert response.headers['content-type'].startswith('text/html')
    assert response.headers['cache-control'] == 'no-cache'
    assert 'class="file-page"' in response.text
    assets = re.findall(r'(?:src|href)="(/ui/[^\"]+)"', response.text)
    assert '/ui/file-page.js' in assets
    for asset in assets:
        assert client.get(asset).status_code == 200, asset


def test_file_page_does_not_expose_other_html_or_paths():
    client = TestClient(create_app())
    for path in ['/ui/app.html', '/ui/missing.html', '/ui/.env',
                 '/ui/%2e%2e%2fapi%2fapp.py']:
        assert client.get(path).status_code == 404, path


def test_file_frame_can_load_a_sheet_preview(tmp_path):
    client = TestClient(create_app())
    sheet = tmp_path / '中文 投递计划.csv'
    sheet.write_text('公司,岗位\n示例公司,数据分析\n', encoding='utf-8')
    info = describe(sheet, 'testserver')
    assert info['kind'] == 'sheet'
    assert client.get('/ui/file-page.html', params={'path': str(sheet)}).status_code == 200
    response = client.get(info['url'])
    assert response.status_code == 200
    assert '<table' in response.text and '数据分析' in response.text
