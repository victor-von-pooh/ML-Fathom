import json
import re
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import yaml

# 登録したデータの一覧のファイル
SOURCES_FILE = "sources.json"

# 書き出すデータセットの名前に使える文字
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")


class SourceStore:
    def __init__(self, home: Path):
        # 置き場を保存
        self.home = home
        self.lock = threading.Lock()

    @property
    def sources_path(self) -> Path:
        """
        登録したデータの一覧のファイルの場所を返す関数

        Parameters
        ----------
        None

        Returns
        ----------
        path: Path
            sources.json の場所
        """
        path = self.home / SOURCES_FILE

        return path

    def read(self) -> list[dict[str, Any]]:
        """
        登録したデータの一覧を読む関数

        Parameters
        ----------
        None

        Returns
        ----------
        sources: list[dict[str, Any]]
            登録したデータ (無い, 壊れている場合は空)
        """
        # 壊れたファイルは空として扱う
        try:
            loaded = json.loads(self.sources_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        sources = [item for item in loaded if isinstance(item, dict)]

        return sources

    def write(self, sources: list[dict[str, Any]]) -> None:
        """
        登録したデータの一覧を書く関数

        Parameters
        ----------
        sources: list[dict[str, Any]]
            登録したデータ

        Returns
        ----------
        None
        """
        # 書きかけを読まないように一時ファイルから置き換え
        self.home.mkdir(parents=True, exist_ok=True)
        temporary = self.sources_path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(sources, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
        temporary.replace(self.sources_path)

    def get(self, source_id: str) -> Optional[dict[str, Any]]:
        """
        1 つの登録したデータを返す関数

        Parameters
        ----------
        source_id: str
            データの ID

        Returns
        ----------
        source: Optional[dict[str, Any]]
            登録したデータ, 無ければ None
        """
        # ID で探す
        source = next(
            (item for item in self.read() if item.get("id") == source_id),
            None
        )

        return source

    def add(
        self, path: Path, name: str, loader: str, kind: str,
        options: dict[str, Any]
    ) -> dict[str, Any]:
        """
        データを登録する関数

        Parameters
        ----------
        path: Path
            ファイルかディレクトリ
        name: str
            表示の名前
        loader: str
            読み込みの名前
        kind: str
            データの種類
        options: dict[str, Any]
            読み込みの設定

        Returns
        ----------
        source: dict[str, Any]
            登録したデータ
        """
        # 短い ID を付けて先頭に加える
        source = {
            "id": uuid.uuid4().hex[:10],
            "name": name,
            "path": str(path),
            "loader": loader,
            "kind": kind,
            "options": options,
            "target": None,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        with self.lock:
            sources = self.read()
            sources.insert(0, source)
            self.write(sources)

        return source

    def update(
        self, source_id: str, changes: dict[str, Any]
    ) -> Optional[dict[str, Any]]:
        """
        登録したデータの名前, 目的の列, 読み込みの設定を変える関数

        Parameters
        ----------
        source_id: str
            データの ID
        changes: dict[str, Any]
            変える項目と値

        Returns
        ----------
        source: Optional[dict[str, Any]]
            変えた後のデータ, 無ければ None
        """
        # 決まった項目だけを書き換える
        allowed = {"name", "target", "loader", "options", "kind"}
        with self.lock:
            sources = self.read()
            for item in sources:
                if item.get("id") == source_id:
                    item.update(
                        {k: v for k, v in changes.items() if k in allowed}
                    )
                    self.write(sources)
                    return item

        return None

    def remove(self, source_id: str) -> bool:
        """
        データの登録を外す関数 (元のファイルは消さない)

        Parameters
        ----------
        source_id: str
            データの ID

        Returns
        ----------
        removed: bool
            外したか
        """
        # 一覧から除き, 保存したレシピも消す
        with self.lock:
            sources = self.read()
            kept = [item for item in sources if item.get("id") != source_id]
            if len(kept) == len(sources):
                return False
            self.write(kept)
        self.recipe_path(source_id).unlink(missing_ok=True)
        removed = True

        return removed

    def recipe_path(self, source_id: str) -> Path:
        """
        データごとのレシピのファイルの場所を返す関数

        Parameters
        ----------
        source_id: str
            データの ID

        Returns
        ----------
        path: Path
            レシピの YAML の場所
        """
        path = self.home / "recipes" / f"{source_id}.yaml"

        return path

    def read_recipe(self, source_id: str) -> Optional[dict[str, Any]]:
        """
        保存したレシピを読む関数

        Parameters
        ----------
        source_id: str
            データの ID

        Returns
        ----------
        recipe: Optional[dict[str, Any]]
            レシピ, 無ければ None
        """
        # 無いか壊れている場合は None
        try:
            loaded = yaml.safe_load(
                self.recipe_path(source_id).read_text(encoding="utf-8")
            )
        except (OSError, yaml.YAMLError):
            return None
        recipe = loaded if isinstance(loaded, dict) else None

        return recipe

    def write_recipe(self, source_id: str, recipe: dict[str, Any]) -> None:
        """
        レシピを保存する関数

        Parameters
        ----------
        source_id: str
            データの ID
        recipe: dict[str, Any]
            レシピ

        Returns
        ----------
        None
        """
        # データごとの YAML に保存
        path = self.recipe_path(source_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            yaml.safe_dump(recipe, allow_unicode=True, sort_keys=False),
            encoding="utf-8"
        )

    def dataset_dir(self, name: str) -> Path:
        """
        書き出すデータセットの既定の場所を返す関数

        Parameters
        ----------
        name: str
            データセットの名前

        Returns
        ----------
        path: Path
            置き場の datasets の下

        Raises
        ----------
        ValueError
            名前に使えない文字がある場合
        """
        # 名前を確かめてから場所を作る
        if not NAME_PATTERN.fullmatch(name):
            raise ValueError(
                "データセットの名前は英数字, _, -, . (64 文字まで) にして"
                "ください"
            )
        path = self.home / "datasets" / name

        return path
