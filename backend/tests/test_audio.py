import base64
import io
import wave
from pathlib import Path

import ml_eda
import numpy as np
import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from ml_fathom.app import create_app
from ml_fathom.items import (
    AUDIO_SECONDS,
    PREVIEW_SECONDS,
    WAVEFORM_BINS,
    audio_clip,
    audio_rate,
    audio_view,
    item_place,
    wav_bytes,
)

# テストで使うトークン
TOKEN = "test-token"

# 試す音声の標本化の周波数
RATE = 8000


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


def write_wave(
    path: Path, seconds: float, channels: int, rate: int = RATE
) -> Path:
    """
    正弦波の 16 bit の PCM の WAVE を保存する関数

    Parameters
    ----------
    path: Path
        保存する場所
    seconds: float
        長さ (秒)
    channels: int
        チャンネルの数
    rate: int = RATE
        標本化の周波数

    Returns
    ----------
    path: Path
        保存した場所
    """
    # 440 Hz の正弦波を半分の大きさで, 全てのチャンネルに
    path.parent.mkdir(parents=True, exist_ok=True)
    times = np.arange(int(seconds * rate)) / rate
    tone = 0.5 * np.sin(2 * np.pi * 440 * times)
    values = (np.repeat(tone[:, None], channels, axis=1) * 32767).astype(
        "<i2"
    )
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(channels)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(values.tobytes())

    return path


def positions(client: TestClient, sid: str) -> dict[str, int]:
    """
    登録した音声のファイルの場所から行の位置を引く辞書を作る関数

    Parameters
    ----------
    client: TestClient
        クライアント
    sid: str
        データの ID

    Returns
    ----------
    found: dict[str, int]
        ファイルの名前 (クラスのフォルダを除く) から行の位置
    """
    # 表の中身の path の列
    rows = client.get(
        f"/api/sources/{sid}/rows", params={"offset": 0, "limit": 50}
    ).json()
    at = [column["name"] for column in rows["columns"]].index("path")
    found = {
        str(row[at]).split("/")[-1]: index
        for row, index in zip(rows["rows"], rows["index"], strict=True)
    }

    return found


def test_audio_items(client: TestClient, tmp_path: Path) -> None:
    """
    音声のフォルダの登録, 1 件の波形と再生用の WAVE, 長い録音を先頭で
    切ること, 読めないファイルと範囲の外を確かめる関数

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
    # 2 クラスの音声 (短いステレオ, 長いモノラル, 4 チャンネル, 壊れた件)
    root = tmp_path / "sounds"
    write_wave(root / "dog" / "short.wav", 0.5, 2)
    write_wave(root / "dog" / "long.wav", AUDIO_SECONDS + 5, 1)
    write_wave(root / "cat" / "many.wav", 0.25, 4)
    (root / "cat" / "broken.wav").write_bytes(b"not a wave")

    # 登録すると種類は audio で, label が目的の列になる
    source = client.post("/api/sources", json={"path": str(root)}).json()
    sid = source["id"]
    assert source["kind"] == "audio" and source["target"] == "label"
    profile = client.get(f"/api/sources/{sid}/profile").json()
    assert profile["summary"]["has_items"]
    assert profile["items"]["count"] == 4
    assert profile["items"]["unreadable"] == 1
    found = positions(client, sid)

    # 短い件は全てを読み, 区間ごとの最小と最大の波形を返す
    item = client.get(f"/api/sources/{sid}/items/{found['short.wav']}")
    assert item.status_code == 200
    body = item.json()
    assert body["sample_rate"] == RATE and body["channels"] == 2
    assert body["truncated"] is False
    assert body["seconds"] == pytest.approx(0.5)
    assert body["duration"] == pytest.approx(0.5)
    low, high = body["waveform"]["min"], body["waveform"]["max"]
    assert len(low) == len(high) == WAVEFORM_BINS
    assert all(a <= b for a, b in zip(low, high, strict=True))
    assert max(high) == pytest.approx(0.5, abs=0.01)
    assert min(low) == pytest.approx(-0.5, abs=0.01)

    # 再生用の WAVE は同じ周波数とチャンネルの 16 bit
    played = client.get(f"/api/sources/{sid}/items/{found['short.wav']}/audio")
    assert played.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(played.content)) as stream:
        assert stream.getframerate() == RATE
        assert stream.getnchannels() == 2
        assert stream.getsampwidth() == 2
        assert stream.getnframes() == int(0.5 * RATE)

    # 長い録音は先頭の AUDIO_SECONDS 秒だけ (全体の長さは表から)
    body = client.get(
        f"/api/sources/{sid}/items/{found['long.wav']}"
    ).json()
    assert body["truncated"] is True
    assert body["seconds"] == pytest.approx(AUDIO_SECONDS)
    assert body["duration"] == pytest.approx(AUDIO_SECONDS + 5)
    played = client.get(f"/api/sources/{sid}/items/{found['long.wav']}/audio")
    with wave.open(io.BytesIO(played.content)) as stream:
        assert stream.getnframes() == int(AUDIO_SECONDS * RATE)

    # 3 チャンネル以上は平均して 1 チャンネルで鳴らす
    played = client.get(f"/api/sources/{sid}/items/{found['many.wav']}/audio")
    with wave.open(io.BytesIO(played.content)) as stream:
        assert stream.getnchannels() == 1

    # 読めないファイルは 422, 範囲の外は 404
    broken = found["broken.wav"]
    assert client.get(f"/api/sources/{sid}/items/{broken}").status_code == 422
    assert client.get(
        f"/api/sources/{sid}/items/{broken}/audio"
    ).status_code == 422
    assert client.get(f"/api/sources/{sid}/items/99").status_code == 404
    assert client.get(f"/api/sources/{sid}/items/99/audio").status_code == 404


def test_audio_recipe(client: TestClient, tmp_path: Path) -> None:
    """
    音声の中身の手順の確認, 数件の前と後 (波形と再生用の WAVE), 版 1 の
    書き出しを確かめる関数

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
    # 周波数, チャンネル, 長さのそろわない音声と, 壊れた件
    root = tmp_path / "sounds"
    for number in range(3):
        write_wave(root / "dog" / f"d{number}.wav", 0.3 + number * 0.1, 2)
        write_wave(
            root / "cat" / f"c{number}.wav", 0.4, 1, RATE * 2
        )
    (root / "cat" / "broken.wav").write_bytes(b"not a wave")
    sid = client.post("/api/sources", json={"path": str(root)}).json()["id"]

    # 手順が無ければ, そろわないことと読めない件の注意
    recipe: dict = {
        "target": "label", "task": "classification",
        "split": {"method": "stratified", "valid": 0.3},
    }
    view = client.post(
        f"/api/sources/{sid}/preview", json={"recipe": recipe, "upto": 0}
    ).json()
    assert any("filter_rows" in note for note in view["notes"])
    assert any("resample" in note for note in view["notes"])

    # 読めない件を除き, 1 チャンネル, 8000 Hz, 0.5 秒にそろえる
    recipe["steps"] = [
        {"op": "filter_rows", "column": "error", "compare": "isna"}
    ]
    recipe["item_steps"] = [
        {"op": "mix_channels", "channels": 1},
        {"op": "resample", "rate": RATE},
        {"op": "fix_length", "seconds": 0.5},
    ]
    view = client.post(
        f"/api/sources/{sid}/preview", json={"recipe": recipe, "upto": 1}
    ).json()
    assert view["notes"] == []

    # 前は元の周波数とチャンネル, 後はそろえた形と再生用の WAVE
    shown = client.post(
        f"/api/sources/{sid}/item_preview",
        json={"recipe": recipe, "count": 4},
    ).json()
    assert len(shown["items"]) == 4
    rates = set()
    for item in shown["items"]:
        assert item["shape"] == [1, RATE // 2]
        before, after = item["before"], item["after"]
        rates.add(before["sample_rate"])
        assert after["sample_rate"] == RATE and after["channels"] == 1
        assert after["seconds"] == pytest.approx(0.5)
        assert after["truncated"] is False
        assert len(after["waveform"]["min"]) == WAVEFORM_BINS
        assert after["src"].startswith("data:audio/wav;base64,")
        played = base64.b64decode(after["src"].split(",", 1)[1])
        with wave.open(io.BytesIO(played)) as stream:
            assert stream.getframerate() == RATE
            assert stream.getnframes() == RATE // 2
    assert rates <= {RATE, RATE * 2}

    # 書き出すと (件数, 1, 4000) の配列で, ML-EDA の load_dataset で読める
    exported = client.post(
        f"/api/sources/{sid}/export",
        json={"recipe": recipe, "name": "sounds"},
    ).json()
    assert exported["info"]["splits"]["train"]["shape"][1:] == [1, RATE // 2]
    assert exported["hints"]["input_shape"] == [1, RATE // 2]
    dataset = ml_eda.load_dataset(exported["path"])
    features, _ = dataset.arrays("train")
    assert features.shape[1:] == (1, RATE // 2)
    total = sum(
        len(dataset.arrays(name)[0]) for name in exported["info"]["splits"]
    )
    assert total == 6


def test_audio_view_clips_head() -> None:
    """
    手順の前と後の音声で, 先頭の PREVIEW_SECONDS 秒だけを描いて鳴らす
    ことを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 長い音は先頭だけ (全体の長さは別に返す). 1 次元の値も 1 チャンネルに
    samples = np.zeros(int((PREVIEW_SECONDS + 2) * RATE), dtype=np.float32)
    view = audio_view(samples, RATE)
    assert view["channels"] == 1 and view["truncated"] is True
    assert view["seconds"] == pytest.approx(PREVIEW_SECONDS)
    assert view["duration"] == pytest.approx(PREVIEW_SECONDS + 2)

    # 後の周波数は最後の resample の rate (無ければ前の周波数)
    steps = [{"op": "resample", "rate": 16000}, {"op": "fix_length"}]
    assert audio_rate(steps, RATE) == 16000
    assert audio_rate([{"op": "mix_channels"}], RATE) == RATE


def test_audio_of_table(client: TestClient, tmp_path: Path) -> None:
    """
    音声でないデータの再生用の WAVE を断ることを確かめる関数

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
    # 表のデータは 422
    path = tmp_path / "table.csv"
    pd.DataFrame({"x": [1, 2, 3], "y": [0, 1, 0]}).to_csv(path, index=False)
    source = client.post("/api/sources", json={"path": str(path)}).json()
    reply = client.get(f"/api/sources/{source['id']}/items/0/audio")
    assert reply.status_code == 422


def test_wav_bytes_clips() -> None:
    """
    再生用の WAVE で, -1 から 1 の外の値と数でない値をそろえることを
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 浮動小数の大きすぎる値は端に, NaN は 0 に
    samples = np.array([[2.0], [-3.0], [np.nan], [0.5]], dtype=np.float32)
    data = wav_bytes({"samples": samples, "sample_rate": RATE})
    with wave.open(io.BytesIO(data)) as stream:
        values = np.frombuffer(stream.readframes(4), dtype="<i2")
    assert values.tolist() == [32767, -32767, 0, 16384]


def test_wav_bytes_mixes_channels() -> None:
    """
    再生用の WAVE で, 3 チャンネル以上を平均して 1 チャンネルにし,
    2 チャンネルまではそのまま残すことを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 4 チャンネルは標本の組ごとの平均
    samples = np.array(
        [[0.4, 0.2, 0.0, -0.2], [-1.0, -1.0, 1.0, 0.2]], dtype=np.float32
    )
    data = wav_bytes({"samples": samples, "sample_rate": RATE})
    with wave.open(io.BytesIO(data)) as stream:
        assert stream.getnchannels() == 1
        values = np.frombuffer(stream.readframes(2), dtype="<i2")
    expected = np.round(samples.mean(axis=1) * 32767).astype(int)
    assert values.tolist() == expected.tolist()

    # 2 チャンネルは左右を残す
    data = wav_bytes({"samples": samples[:, :2], "sample_rate": RATE})
    with wave.open(io.BytesIO(data)) as stream:
        assert stream.getnchannels() == 2
        values = np.frombuffer(stream.readframes(2), dtype="<i2")
    expected = np.round(samples[:, :2] * 32767).astype(int).ravel()
    assert values.tolist() == expected.tolist()


@pytest.mark.parametrize("kind", ["outside", "absolute", "link"])
def test_item_place_stays_inside(tmp_path: Path, kind: str) -> None:
    """
    1 件の場所が .. や絶対パス, 外を指すシンボリックリンクで読み込んだ
    ディレクトリの外に出る場合は 422 にすることを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    kind: str
        outside (..), absolute (絶対パス), link (外を指すシンボリック
        リンク)

    Returns
    ----------
    None
    """
    # 置き場の外の音声と, 置き場の中の音声
    root = tmp_path / "sounds"
    secret = write_wave(tmp_path / "secret.wav", 0.1, 1)
    write_wave(root / "inside.wav", 0.1, 1)
    places = {
        "outside": "../secret.wav", "absolute": str(secret),
        "link": "link.wav",
    }
    if kind == "link":
        (root / "link.wav").symlink_to(secret)
    data = ml_eda.Data(
        kind="audio",
        frame=pd.DataFrame({"path": [places[kind], "inside.wav"]}),
        source={"root": str(root)},
    )

    # 外は 422 で読まない. 中はたどった後の場所
    with pytest.raises(HTTPException) as caught:
        audio_clip(data, 0)
    assert caught.value.status_code == 422
    assert "外" in str(caught.value.detail)
    assert item_place(data, 1) == (root / "inside.wav").resolve()
    assert audio_clip(data, 1)["sample_rate"] == RATE


def test_outside_links_refused(client: TestClient, tmp_path: Path) -> None:
    """
    音声と画像のディレクトリの中の, 外を指すシンボリックリンクの件を,
    中身と再生の API で 422 にすることを確かめる関数

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
    image = pytest.importorskip("PIL.Image")

    # 音声: 中の 1 件と, 外の音声を指すリンク
    root = tmp_path / "sounds"
    write_wave(root / "inside.wav", 0.1, 1)
    secret = write_wave(tmp_path / "secret.wav", 0.1, 1)
    (root / "link.wav").symlink_to(secret)
    source = client.post("/api/sources", json={"path": str(root)}).json()
    sid = source["id"]
    found = positions(client, sid)
    link = found["link.wav"]
    assert client.get(f"/api/sources/{sid}/items/{link}").status_code == 422
    assert client.get(
        f"/api/sources/{sid}/items/{link}/audio"
    ).status_code == 422
    inside = found["inside.wav"]
    assert client.get(f"/api/sources/{sid}/items/{inside}").status_code == 200

    # 画像: 外の画像を指すリンク
    pictures = tmp_path / "pictures"
    pictures.mkdir()
    pixels = np.zeros((4, 4, 3), dtype=np.uint8)
    image.fromarray(pixels).save(pictures / "inside.png")
    image.fromarray(pixels).save(tmp_path / "secret.png")
    (pictures / "link.png").symlink_to(tmp_path / "secret.png")
    source = client.post("/api/sources", json={"path": str(pictures)}).json()
    sid = source["id"]
    found = positions(client, sid)
    assert client.get(
        f"/api/sources/{sid}/items/{found['link.png']}"
    ).status_code == 422
    assert client.get(
        f"/api/sources/{sid}/items/{found['inside.png']}"
    ).status_code == 200
