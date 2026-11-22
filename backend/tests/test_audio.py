import io
import wave
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from ml_fathom.app import create_app
from ml_fathom.items import AUDIO_SECONDS, WAVEFORM_BINS, wav_bytes

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


def write_wave(path: Path, seconds: float, channels: int) -> Path:
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

    Returns
    ----------
    path: Path
        保存した場所
    """
    # 440 Hz の正弦波を半分の大きさで, 全てのチャンネルに
    path.parent.mkdir(parents=True, exist_ok=True)
    times = np.arange(int(seconds * RATE)) / RATE
    tone = 0.5 * np.sin(2 * np.pi * 440 * times)
    values = (np.repeat(tone[:, None], channels, axis=1) * 32767).astype(
        "<i2"
    )
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(channels)
        stream.setsampwidth(2)
        stream.setframerate(RATE)
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
