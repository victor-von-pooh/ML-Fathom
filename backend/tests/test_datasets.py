from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml
from fastapi import HTTPException
from fastapi.testclient import TestClient
from ml_eda import ITEM_STEPS
from ml_eda.itemprep import ENTRY_STEPS
from ml_eda.pipeline import ITEMS_FORMAT_VERSIONS
from ml_eda.synthetic import write_image_masks, write_shape_captures

from ml_fathom.api import PAIR_STEPS, STEP_LIMITS, check_step_limits
from ml_fathom.app import create_app
from ml_fathom.datasets import dataset_summary

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


def test_image_masks_unlabeled(client: TestClient, tmp_path: Path) -> None:
    """
    正解の無い件を, 既定では除き, keep なら unlabeled の分割に書くことを
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
    # 合成の見本に, 領域の無い画像を 1 つ足す
    sample = write_image_masks(tmp_path / "pairs", count=10)
    (sample["images"] / "lonely.png").write_bytes(
        (sample["images"] / "sample_000.png").read_bytes()
    )
    body = {
        "images": str(sample["images"]), "masks": str(sample["masks"]),
        "name": "dropped", "split": {"valid": 0.2, "test": 0.0, "seed": 0},
    }

    # 既定 (除く) は分割に入れず, 注意に書く
    dropped = client.post("/api/datasets/image_masks", json=body)
    assert dropped.status_code == 200, dropped.text
    splits = dropped.json()["info"]["splits"]
    assert "unlabeled" not in splits
    assert any("lonely" in note for note in dropped.json()["notes"])

    # keep なら unlabeled の分割に書く. 正解の付いた件は同じ
    kept = client.post("/api/datasets/image_masks", json={
        **body, "name": "kept",
        "split": {**body["split"], "unlabeled": "keep"},
    })
    assert kept.status_code == 200, kept.text
    info = kept.json()["info"]
    assert info["split"]["unlabeled"] == "keep"
    assert info["splits"]["unlabeled"] == {"items": 1}
    assert {name: value for name, value in info["splits"].items()
            if name != "unlabeled"} == splits

    # drop と keep の他は 422
    wrong = client.post("/api/datasets/image_masks", json={
        **body, "name": "wrong",
        "split": {**body["split"], "unlabeled": "yes"},
    })
    assert wrong.status_code == 422


def test_image_masks_item_steps(
    client: TestClient, tmp_path: Path
) -> None:
    """
    大きさの混ざった画像に中身の手順をかけて版 3 で書き出し, 一覧で手順を
    出すことを確かめる関数

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
    # 画面で選べる手順は, 画像は resize, grayscale, rgb だけ (領域は無し)
    pairs = client.get("/api/info").json()["pair_steps"]
    image = pairs["image_masks"]
    assert list(image) == ["image"]
    assert [step["op"] for step in image["image"]] == [
        "resize", "grayscale", "rgb",
    ]
    assert image["image"][0]["required"] == ["width", "height"]
    assert image["image"][0]["limits"] == {"width": 4096, "height": 4096}
    assert image["image"][1]["limits"] == {}
    cloud = pairs["capture_clouds"]["cloud"]
    assert [step["op"] for step in cloud] == ["sample_points"]
    assert cloud[0]["limits"] == {"points": 1_000_000}

    # 大きさの混ざった見本を 16 × 20 にそろえる
    sample = write_image_masks(
        tmp_path / "mixed", count=6, sizes=[(24, 32), (30, 18)]
    )
    steps = [{"op": "resize", "width": 20, "height": 16}]
    body = {
        "images": str(sample["images"]), "masks": str(sample["masks"]),
        "name": "resized", "item_steps": {"image": steps},
    }
    response = client.post("/api/datasets/image_masks", json=body)
    assert response.status_code == 200, response.text
    info = response.json()["info"]
    assert info["format_version"] == 3
    assert info["entries"]["image"]["steps"] == steps
    assert info["entries"]["mask"]["steps"] == [
        {"op": "resize_mask", "width": 20, "height": 16},
    ]

    # 領域の手順, ファイルに残せない手順, 上限を超えた大きさは 422
    for wrong in ({"mask": steps}, {"image": [{"op": "normalize"}]},
                  {"image": [{"op": "resize", "width": 0, "height": 4}]},
                  {"image": [{"op": "resize", "width": 4, "height": 4097}]}):
        response = client.post("/api/datasets/image_masks", json={
            **body, "name": "wrong", "item_steps": wrong,
        })
        assert response.status_code == 422, wrong

    # 一覧は版 3 をファイルの組として読み, 項目ごとの手順を出す
    item = client.get("/api/datasets").json()[0]
    assert item["form"] == "items"
    assert item["format_version"] == 3
    entries = {entry["name"]: entry for entry in item["entries"]}
    assert entries["image"]["steps"] == steps
    assert entries["image"]["shape"][:2] == [16, 20]
    assert entries["mask"]["steps"][0]["op"] == "resize_mask"


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
    assert entries["cloud"]["steps"] is None

    # 点の数の上限を超えると, 読む前に 422
    response = client.post("/api/datasets/capture_clouds", json={
        **body, "name": "huge",
        "item_steps": {"cloud": [{"op": "sample_points",
                                  "points": 1_000_001}]},
    })
    assert response.status_code == 422
    assert "1000000 以下" in response.json()["detail"]

    # 撮影と点群にも中身の手順をかけられる (版 3)
    steps = {
        "capture": [{"op": "resize", "width": 32, "height": 24},
                    {"op": "grayscale"}],
        "cloud": [{"op": "sample_points", "points": 50, "seed": 1}],
    }
    response = client.post("/api/datasets/capture_clouds", json={
        **body, "name": "sampled", "item_steps": steps,
    })
    assert response.status_code == 200, response.text
    sampled = next(item for item in client.get("/api/datasets").json()
                   if item["name"] == "sampled")
    entries = {entry["name"]: entry for entry in sampled["entries"]}
    assert sampled["format_version"] == 3
    assert entries["capture"]["steps"] == steps["capture"]
    assert entries["capture"]["shape"][-2:] == [24, 32]
    assert entries["cloud"]["steps"] == steps["cloud"]
    assert entries["cloud"]["shape"] == [50, 3]


def test_list_unreadable(client: TestClient, tmp_path: Path) -> None:
    """
    知らない版と壊れたデータセット, 外を指すリンクの dataset.yaml が,
    一覧から消えずに理由を出すことを確かめる関数

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
        yaml.safe_dump({
            "format_version": max(ITEMS_FORMAT_VERSIONS) + 1,
            "name": "future",
        }),
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
    # 外の dataset.yaml を指すリンク (ML-EDA の load_items と同じく読まない)
    (root / "linked").mkdir()
    (root / "linked" / "dataset.yaml").symlink_to(
        root / "v1" / "dataset.yaml"
    )

    # 版 1 は今までどおり, 他は読めないものとして並ぶ
    datasets = {
        item["name"]: item for item in client.get("/api/datasets").json()
    }
    assert set(datasets) == {
        "v1", "future", "broken", "float", "listed", "linked"
    }
    assert datasets["linked"]["form"] == "unreadable"
    assert datasets["linked"]["unknown_version"] is False
    assert "外を指すリンク" in datasets["linked"]["error"]

    # データセットのディレクトリ自体のリンクは信頼する (一覧は同じ場所を
    # 1 つにするので, 1 件を直に読む)
    (tmp_path / "alias").symlink_to(root / "v1")
    alias = dataset_summary(tmp_path / "alias")
    assert alias is not None and alias["form"] == "table"
    assert datasets["float"]["unknown_version"] is True
    assert datasets["listed"]["unknown_version"] is False
    assert "辞書" in datasets["listed"]["error"]
    assert datasets["v1"]["form"] == "table"
    assert datasets["v1"]["format_version"] == 1
    assert datasets["v1"]["splits"] == {"train": 30, "valid": 10}
    assert datasets["future"]["form"] == "unreadable"
    assert datasets["future"]["unknown_version"] is True
    future = max(ITEMS_FORMAT_VERSIONS) + 1
    assert f"format_version {future}" in datasets["future"]["error"]
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


def test_pair_steps_in_entry_steps() -> None:
    """
    画面で選べる中身の手順 (PAIR_STEPS) が全て, ML-EDA の書き出しがその
    項目の種類に受け付ける手順 (ENTRY_STEPS) にあることを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 書き出しの項目の名前から, dataset.yaml の項目の種類
    kinds = {
        ("image_masks", "image"): "image",
        ("capture_clouds", "capture"): "capture",
        ("capture_clouds", "cloud"): "point_cloud",
    }
    listed = {(form, entry) for form, entries in PAIR_STEPS.items()
              for entry in entries}
    assert listed == set(kinds)
    for (form, entry), kind in kinds.items():
        _, ops = PAIR_STEPS[form][entry]
        assert set(ops) <= set(ENTRY_STEPS[kind]), (form, entry)
        assert all(op in ITEM_STEPS for op in ops), (form, entry)


def test_check_step_limits() -> None:
    """
    中身の手順の引数の上限を, 版 1 のレシピの並びとファイルの組の項目ごと
    の辞書の両方で確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 上限ちょうどの値と, 形の誤り (ML-EDA が確かめる) は通す
    at_limit = [{"op": "resample", "rate": 192_000},
                {"op": "fix_length", "seconds": 600}]
    check_step_limits(at_limit)
    check_step_limits({"capture": [{"op": "resize", "width": 4096,
                                    "height": 4096}]})
    check_step_limits(None)
    check_step_limits([{"op": "resample", "rate": "many"}, "resize"])

    # 並びは「中身の手順」, 辞書は項目の名前で, 番号と入れた値を出す
    with pytest.raises(HTTPException) as caught:
        check_step_limits([{"op": "mix_channels", "channels": 1},
                           {"op": "normalize"},
                           {"op": "resample", "rate": 200_000}])
    assert caught.value.status_code == 422
    assert caught.value.detail == (
        "中身の手順 3 の resample の rate (200000) は 192000 以下に"
        "してください"
    )
    with pytest.raises(HTTPException) as caught:
        check_step_limits({"image": [{"op": "resize", "width": 8,
                                      "height": 4097}]})
    assert caught.value.detail == (
        "image の手順 1 の resize の height (4097) は 4096 以下に"
        "してください"
    )

    # 同じ名前の引数はどの手順でも同じ上限
    for name in ("channels", "max_tokens", "length", "seconds", "points"):
        with pytest.raises(HTTPException):
            check_step_limits([{"op": "any", name: STEP_LIMITS[name] + 1}])


def test_info_item_step_limits(client: TestClient) -> None:
    """
    版 1 のレシピの中身の手順の一覧に, 引数の上限を添えることを確かめる
    関数

    Parameters
    ----------
    client: TestClient
        クライアント

    Returns
    ----------
    None
    """
    # 上限は STEP_LIMITS のうち, その手順の引数にあるものだけ
    steps = {
        step["op"]: step
        for step in client.get("/api/info").json()["item_steps"]
    }
    assert steps["resize"]["limits"] == {"width": 4096, "height": 4096}
    assert steps["resample"]["limits"] == {"rate": 192_000}
    assert steps["fix_length"]["limits"] == {"seconds": 600}
    assert steps["sample_points"]["limits"] == {"points": 1_000_000}
    assert steps["normalize"]["limits"] == {}
    for step in steps.values():
        assert set(step["limits"]) <= set(step["params"]), step["op"]
        assert all(
            STEP_LIMITS[name] == value
            for name, value in step["limits"].items()
        ), step["op"]
