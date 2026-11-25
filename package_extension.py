"""Build the installable Thunderbird XPI without local configuration or data."""

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=root / "extension")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    extension = args.source
    manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
    output = args.output or root / "dist" / f"thunderquail-{manifest['version']}.xpi"
    output.parent.mkdir(parents=True, exist_ok=True)
    asset_types = {".css", ".html", ".js", ".json", ".mjs", ".png", ".svg", ".txt"}
    assets = sorted(path for path in extension.rglob("*")
                    if path.is_file() and not path.is_symlink()
                    and not any(part.startswith(".") for part in path.relative_to(extension).parts)
                    and (path.name == "manifest.json" or path.suffix in asset_types))
    temporary = output.with_suffix(".tmp")
    with ZipFile(temporary, "w") as archive:
        for path in assets:
            entry = ZipInfo(path.relative_to(extension).as_posix())
            archive.writestr(entry, path.read_bytes(), compress_type=ZIP_DEFLATED)
    temporary.replace(output)
    print(output)


if __name__ == "__main__":
    main()
