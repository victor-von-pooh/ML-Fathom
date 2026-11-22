import ast
import math
from pathlib import Path

import ml_eda
import ml_quest
import numpy as np

from ml_fathom.jsonable import to_json

# アプリのコードの場所
SOURCE_DIR = Path(__file__).resolve().parents[1] / "src" / "ml_fathom"

# 組のライブラリと, その公開の名前
PUBLIC = {
    "ml_eda": set(ml_eda.__all__),
    "ml_quest": set(ml_quest.__all__),
}

# 持ち主 (ML-EDA) に公開してもらうのを待つ名前 (待っている理由は TODO.md.
# 公開されたら置き換えて消す)
WAITING = {
    "ml_eda.pipeline.frame_view",
    "ml_eda.pipeline.DATASET_FORMAT_VERSION",
    "ml_eda.pipeline.ITEMS_FORMAT_VERSIONS",
    "ml_eda.media.read_image",
}


def private_names(tree: ast.AST) -> set[str]:
    """
    構文の木から, 組のライブラリの公開されていない名前を集める関数

    Parameters
    ----------
    tree: ast.AST
        1 つのファイルの構文の木

    Returns
    ----------
    names: set[str]
        モジュールから続けた名前 (ml_eda.media.read_image など)
    """
    # from の import と, ライブラリの名前から続く属性
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            top = node.module.split(".")[0]
            if top not in PUBLIC:
                continue
            for alias in node.names:
                if node.module != top or alias.name not in PUBLIC[top]:
                    names.add(f"{node.module}.{alias.name}")
        elif isinstance(node, ast.Import):
            # 中のモジュールの import と, 別名 (後の属性を追えない) は誤り
            for alias in node.names:
                if alias.name.split(".")[0] not in PUBLIC:
                    continue
                if alias.asname:
                    names.add(f"import {alias.name} as {alias.asname}")
                elif "." in alias.name:
                    names.add(alias.name)
        elif isinstance(node, ast.Attribute):
            chain = []
            value: ast.expr = node
            while isinstance(value, ast.Attribute):
                chain.append(value.attr)
                value = value.value
            if not isinstance(value, ast.Name) or value.id not in PUBLIC:
                continue
            chain.reverse()
            if chain[0] not in PUBLIC[value.id]:
                names.add(".".join([value.id, *chain]))

    return names


def test_only_public_names() -> None:
    """
    アプリのコードが ML-EDA と ML-Quest の公開の名前 (__all__) だけを
    使い, 公開を待つ名前の表が今の使い方と合うことを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 全てのファイルの公開されていない名前
    found: set[str] = set()
    for path in sorted(SOURCE_DIR.glob("**/*.py")):
        found |= private_names(ast.parse(path.read_text(encoding="utf-8")))

    # 属性で続けて呼ぶ名前 (ml_eda.media.read_image) は最も長い形だけ
    found = {
        name for name in found
        if not any(other.startswith(name + ".") for other in found)
    }
    assert found == WAITING


def test_private_names_found() -> None:
    """
    公開されていない名前を, from の import と属性の両方で見つけ, 組の
    ライブラリに別名を付ける import も見つけることを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 公開の名前は数えず, 公開されていない名前だけ
    code = (
        "import ml_eda\n"
        "from ml_eda import read_cloud\n"
        "from ml_eda.profile import to_json\n"
        "ml_eda.read_cloud(x)\n"
        "ml_eda.media.read_image(x)\n"
        "ml_quest.examples.example_problem()\n"
    )
    names = private_names(ast.parse(code))
    assert "ml_eda.profile.to_json" in names
    assert "ml_eda.media.read_image" in names
    assert "ml_quest.examples.example_problem" in names
    assert not any("read_cloud" in name for name in names)

    # 別名を付ける import は, 公開の名前だけを使う場合も誤り
    aliased = private_names(ast.parse(
        "import ml_eda as e\nimport ml_eda.media as m\ne.read_cloud(x)\n"
        "from ml_eda import read_cloud as load\n"
    ))
    assert aliased == {
        "import ml_eda as e", "import ml_eda.media as m"
    }


def test_to_json() -> None:
    """
    numpy の値と NaN, 無限大を JSON にできる値にすることを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 入れ物の中も変換し, NaN と無限大は None
    value = {
        1: np.int64(3), "f": np.float32(0.5), "b": np.bool_(True),
        "list": (math.nan, math.inf, "a"), "none": None,
    }
    assert to_json(value) == {
        "1": 3, "f": 0.5, "b": True, "list": [None, None, "a"],
        "none": None,
    }
    assert type(to_json({"x": np.int64(1)})["x"]) is int
