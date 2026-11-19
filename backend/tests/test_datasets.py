from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml
from fastapi.testclient import TestClient
from ml_eda.synthetic import write_image_masks, write_shape_captures

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


def test_image_masks_export_and_list(
    client: TestClient, tmp_path: Path
) -> None:
    """
    画像と領域の対の書き出しと, 版 2 の一覧を確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 合成の見本に, 組にならない領域を 1 つ足す
    sample = write_image_masks(tmp_path / "pairs", count=10)
    (sample["masks"] / "orphan.png").write_bytes(
        (sample["masks"] / "sample_000.png").read_bytes()
    )
    body = {
        "images": str(sample["images"]), "masks": str(sample["masks"]),
        "name": "shapes",
        "classes": {"0": "background", "1": "circle", "2": "square"},
        "split": {"valid": 0.2, "test": 0.0, "seed": 0},
        "origin": {
            "type": "process", "name": "threshold",
            "settings": {"level": 0.5},
        },
    }
    exported = client.post("/api/datasets/image_masks", json=body)
    assert exported.status_code == 200
    result = exported.json()
    assert Path(result["path"], "dataset.yaml").is_file()
    assert result["info"]["format_version"] == 2
    assert any("orphan" in note for note in result["notes"])

    # 同じ名前は置き換えの指定が無ければ 409, 名前の誤りは 422
    assert client.post(
        "/api/datasets/image_masks", json=body
    ).status_code == 409
    assert client.post(
        "/api/datasets/image_masks", json={**body, "overwrite": True}
    ).status_code == 200
    assert client.post(
        "/api/datasets/image_masks", json={**body, "name": "../x"}
    ).status_code == 422

    # 一覧は版 2 として, 受け持ち, 正解, 項目, 分割, 出どころを出す
    datasets = client.get("/api/datasets").json()
    assert len(datasets) == 1
    item = datasets[0]
    assert item["form"] == "items"
    assert item["format_version"] == 2
    assert item["role"] == "predict"
    assert item["target"]["kind"] == "mask"
    assert item["target"]["origin"] == {
        "type": "process", "name": "threshold", "settings": {"level": 0.5},
    }
    entries = {entry["name"]: entry for entry in item["entries"]}
    assert entries["image"]["role"] == "input"
    assert entries["mask"]["units"] == "pixel"
    assert entries["mask"]["convention"]["origin"] == "top_left"
    assert item["items"] == 10
    assert sum(item["splits"].values()) == 10
    assert item["normalization"] is None


def test_image_masks_errors(client: TestClient, tmp_path: Path) -> None:
    """
    画像と領域の対の書き出しの誤りを確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 無いディレクトリ, 知らない出どころ, 知らない分割は 422
    sample = write_image_masks(tmp_path / "pairs", count=4)
    body = {
        "images": str(sample["images"]), "masks": str(sample["masks"]),
        "name": "bad",
    }
    missing = client.post(
        "/api/datasets/image_masks",
        json={**body, "images": str(tmp_path / "none")}
    )
    assert missing.status_code == 422
    assert "ディレクトリではありません" in missing.json()["detail"]
    assert client.post(
        "/api/datasets/image_masks", json={**body, "origin": {"type": "x"}}
    ).status_code == 422
    assert client.post(
        "/api/datasets/image_masks",
        json={**body, "split": {"method": "stratified"}}
    ).status_code == 422

    # 名前の終わりで組にする (a.png と a_mask.png)
    for path in sorted(sample["masks"].iterdir()):
        path.rename(path.with_name(f"{path.stem}_mask.png"))
    assert client.post(
        "/api/datasets/image_masks", json=body
    ).status_code == 422
    suffixed = client.post(
        "/api/datasets/image_masks", json={**body, "mask_suffix": "_mask"}
    )
    assert suffixed.status_code == 200
    assert suffixed.json()["info"]["source"]["mask_suffix"] == "_mask"


def test_capture_clouds_export(client: TestClient, tmp_path: Path) -> None:
    """
    撮影と点群の対の書き出しと, グループと単位を確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 球 2 つと箱 2 つ. 形の種類をグループにする
    sample = write_shape_captures(tmp_path / "shapes", views=4, points=200)
    names = [shape["name"] for shape in sample["shapes"]]
    groups = {name: name.split("_")[0] for name in names}
    body = {
        "captures": str(sample["captures"]), "clouds": str(sample["clouds"]),
        "name": "objects", "groups": groups, "cloud_units": "meter",
        "split": {"valid": 0.5, "test": 0.0, "seed": 0},
        "origin": {"type": "synthetic", "name": "ml_eda.synthetic"},
    }
    assert client.post(
        "/api/datasets/capture_clouds", json={**body, "cloud_units": "inch"}
    ).status_code == 422
    exported = client.post("/api/datasets/capture_clouds", json=body)
    assert exported.status_code == 200
    info = exported.json()["info"]
    assert info["split"]["method"] == "group"
    assert info["target"]["kind"] == "point_cloud"
    assert set(info["splits"]) == {"train", "valid"}
    # 元の場所は名前だけ (手元のディレクトリの構成を残さない)
    assert info["source"]["captures"] == "captures"
    assert info["source"]["clouds"] == "clouds"
    assert str(tmp_path) not in str(info["source"])

    # 壊れた点群は 500 でなく 422
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "sphere_a.ply").write_text(
        "ply\nelement vertex 3\nproperty float x\nend_header\n",
        encoding="utf-8"
    )
    response = client.post("/api/datasets/capture_clouds", json={
        **body, "clouds": str(broken), "name": "broken", "groups": None,
    })
    assert response.status_code == 422
    assert "書き出せませんでした" in response.json()["detail"]

    # 一覧は単位と正規化, 深度の測り方と画素の中心を出し, 元の場所を出さない
    item = client.get("/api/datasets").json()[0]
    assert item["form"] == "items"
    entries = {entry["name"]: entry for entry in item["entries"]}
    assert entries["capture"]["units"] == "meter"
    assert entries["cloud"]["kind"] == "point_cloud"
    assert item["normalization"] == "view_center"
    assert item["items"] == len(names)
    assert item["target"]["origin"]["type"] == "synthetic"
    convention = entries["capture"]["convention"]
    assert convention["depth"] == "z"
    assert convention["pixel_center"] == 0.5
    shown = {key: value for key, value in item.items() if key != "path"}
    assert str(sample["captures"]) not in str(shown)


def test_list_unreadable(client: TestClient, tmp_path: Path) -> None:
    """
    知らない版と壊れたデータセットが, 一覧から消えずに理由を出すことを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        クライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 版 1 を書き出し, 知らない版, 壊れた版 2, dataset.yaml の無いものを置く
    rng = np.random.default_rng(0)
    file = tmp_path / "table.csv"
    pd.DataFrame({
        "x": rng.normal(0, 1, 40), "y": rng.choice(["a", "b"], 40),
    }).to_csv(file, index=False)
    sid = client.post("/api/sources", json={"path": str(file)}).json()["id"]
    recipe = {
        "format_version": 1, "target": "y", "task": "classification",
        "steps": [], "split": {"method": "random", "valid": 0.25},
    }
    assert client.post(
        f"/api/sources/{sid}/export", json={"recipe": recipe, "name": "v1"}
    ).status_code == 200
    root = tmp_path / "home" / "datasets"
    (root / "future").mkdir()
    (root / "future" / "dataset.yaml").write_text(
        yaml.safe_dump({"format_version": 3, "name": "future"}),
        encoding="utf-8"
    )
    (root / "broken").mkdir()
    (root / "broken" / "dataset.yaml").write_text(
        yaml.safe_dump({"format_version": 2, "entries": {}}),
        encoding="utf-8"
    )
    (root / "empty").mkdir()
    (root / ".half.writing").mkdir()
    (root / "float").mkdir()
    (root / "float" / "dataset.yaml").write_text(
        "format_version: 1.0\n", encoding="utf-8"
    )
    (root / "listed").mkdir()
    (root / "listed" / "dataset.yaml").write_text(
        "- 1\n- 2\n", encoding="utf-8"
    )

    # 版 1 は今までどおり, 他は読めないものとして並ぶ
    datasets = {
        item["name"]: item for item in client.get("/api/datasets").json()
    }
    assert set(datasets) == {"v1", "future", "broken", "float", "listed"}
    assert datasets["float"]["unknown_version"] is True
    assert datasets["listed"]["unknown_version"] is False
    assert "辞書" in datasets["listed"]["error"]
    assert datasets["v1"]["form"] == "table"
    assert datasets["v1"]["format_version"] == 1
    assert datasets["v1"]["splits"] == {"train": 30, "valid": 10}
    assert datasets["future"]["form"] == "unreadable"
    assert datasets["future"]["unknown_version"] is True
    assert "format_version 3" in datasets["future"]["error"]
    assert datasets["broken"]["form"] == "unreadable"
    assert datasets["broken"]["unknown_version"] is False
    assert "entries" in datasets["broken"]["error"]

    # 壊れたレシピ (YAML の誤り) も 1 件の誤りにして一覧を止めない
    (root / "v1" / "recipe.yaml").write_text("a: [", encoding="utf-8")
    listed = client.get("/api/datasets")
    assert listed.status_code == 200
    v1 = next(item for item in listed.json() if item["name"] == "v1")
    assert v1["form"] == "unreadable"
    assert v1["unknown_version"] is False
