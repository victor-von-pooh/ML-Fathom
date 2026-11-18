import json
import math
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from ml_fathom.app import create_app

# テストで使うトークン
TOKEN = "test-token"


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    """
    一時ディレクトリを置き場にしたアプリのクライアントを作る関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    client: TestClient
        トークンを送るクライアント
    """
    app = create_app(
        data_dir=tmp_path / "home", token=TOKEN, allowed_hosts=["testserver"]
    )
    client = TestClient(app, headers={"x-fathom-token": TOKEN})

    return client


def write_capture(place: Path, count: int) -> Path:
    """
    中心の周りを一周した撮影 (画像, 生の深度, 信頼度, 点群) を書く関数

    Parameters
    ----------
    place: Path
        撮影のディレクトリ
    count: int
        枚数 (等間隔の方位)

    Returns
    ----------
    place: Path
        撮影のディレクトリ
    """
    # カメラは中心から 1 m, -Z が中心を向く (OpenGL)
    for name in ("images", "raw_depth", "confidence"):
        (place / name).mkdir(parents=True)
    frames = []
    for index in range(count):
        angle = 2 * math.pi * index / count
        position = np.array([math.sin(angle), 0.2, math.cos(angle)])
        back = position / np.linalg.norm(position)
        right = np.cross([0.0, 1.0, 0.0], back)
        right = right / np.linalg.norm(right)
        pose = np.eye(4)
        pose[:3, 0], pose[:3, 1] = right, np.cross(back, right)
        pose[:3, 2], pose[:3, 3] = back, position
        Image.new("RGB", (16, 12), (200, 100, 50)).save(
            place / "images" / f"{index}.jpg"
        )
        depth = np.linspace(900, 1100, 12 * 16).reshape(12, 16)
        Image.fromarray(depth.astype(np.uint16)).save(
            place / "raw_depth" / f"{index}.png"
        )
        Image.fromarray(np.full((12, 16), 200, np.uint8)).save(
            place / "confidence" / f"{index}.png"
        )
        frames.append({
            "file_path": f"images/{index}.jpg",
            "transform_matrix": pose.tolist(),
            "raw_depth_file_path": f"raw_depth/{index}.png",
            "confidence_file_path": f"confidence/{index}.png",
        })
    (place / "points.ply").write_text(
        "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\n"
        "property float y\nproperty float z\nend_header\n0 0 0\n1 1 1\n",
        "utf-8",
    )
    (place / "transforms.json").write_text(json.dumps({
        "fl_x": 10.0, "fl_y": 10.0, "cx": 8.0, "cy": 6.0, "w": 16, "h": 12,
        "depth": {"depth_format": "png16_millimeter", "invalid_value": 0},
        "coordinate_convention": {"world_up": [0.0, 1.0, 0.0]},
        "point_cloud": {"file_path": "points.ply"},
        "frames": frames,
    }), "utf-8")

    return place


def test_capture_view(client: TestClient, tmp_path: Path) -> None:
    """
    多視点の撮影を登録し, 1 件の配置, 1 枚の画像と深度と信頼度, 点群を
    返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 6 枚の一周 (方位の隙間 60 度)
    place = write_capture(tmp_path / "captures" / "round", 6)
    source = client.post("/api/sources", json={
        "path": str(place.parent)
    }).json()
    assert source["kind"] == "capture"
    url = f"/api/sources/{source['id']}/items/0"
    item = client.get(url).json()
    assert len(item["frames"]) == 6 and item["point_cloud"] is True
    assert item["layout"]["gap"] == pytest.approx(60, abs=0.5)
    assert all(camera["x"] is not None
               for camera in item["layout"]["cameras"])

    # 1 枚の層ごとの PNG と点群
    for layer in ("image", "depth", "confidence"):
        response = client.get(f"{url}/frames/2?layer={layer}&size=32")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
    assert client.get(f"{url}/frames/9").status_code == 404
    assert client.get(f"{url}/frames/0?layer=other").status_code == 422
    assert client.get(f"{url}/cloud").json()["count"] == 2


def test_capture_limits(client: TestClient, tmp_path: Path) -> None:
    """
    撮影の外を指す場所の画像は返さず, 撮影でないデータは断ることを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        一時ディレクトリ

    Returns
    ----------
    None
    """
    # 1 枚目の画像が撮影の外を指す
    place = write_capture(tmp_path / "one", 4)
    Image.new("RGB", (4, 4)).save(tmp_path / "secret.png")
    transforms = json.loads((place / "transforms.json").read_text("utf-8"))
    transforms["frames"][0]["file_path"] = "../secret.png"
    (place / "transforms.json").write_text(json.dumps(transforms), "utf-8")
    source = client.post("/api/sources", json={"path": str(place)}).json()
    url = f"/api/sources/{source['id']}/items/0"
    assert client.get(url).json()["frames"][0]["image"] is False
    assert client.get(f"{url}/frames/0").status_code == 404

    # 表のデータには撮影の 1 枚は無い
    (tmp_path / "t.csv").write_text("a,b\n1,2\n3,4\n", "utf-8")
    table = client.post("/api/sources", json={
        "path": str(tmp_path / "t.csv")
    }).json()
    assert client.get(
        f"/api/sources/{table['id']}/items/0/frames/0"
    ).status_code == 422
