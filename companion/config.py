import configparser
import os
import re
import secrets
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile

from filelock import FileLock


DEFAULT_PORT = 49371
TOKEN_FORMAT = re.compile(r"[A-Za-z0-9_-]{43}")


def data_directory():
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local"
        return Path(local) / "ThunderQuail"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "ThunderQuail"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "thunderquail"


def companion_token(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    token_file = directory / "companion-token"
    with FileLock(str(directory / ".token.lock"), timeout=5):
        if token_file.exists():
            token = token_file.read_text(encoding="ascii").strip()
            if not TOKEN_FORMAT.fullmatch(token):
                raise ValueError(f"Invalid companion token file: {token_file}")
            return token

        token = secrets.token_urlsafe(32)
        temporary = NamedTemporaryFile(mode="w", encoding="ascii", dir=directory, delete=False)
        temporary_path = Path(temporary.name)
        try:
            with temporary:
                temporary.write(token + "\n")
            temporary_path.replace(token_file)
        finally:
            temporary_path.unlink(missing_ok=True)
        return token


def default_profile():
    if os.name == "nt":
        roaming = os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming"
        root = Path(roaming) / "Thunderbird"
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Thunderbird"
    else:
        root = Path.home() / ".thunderbird"
    return profile_from_registry(root)


def profile_from_registry(root):
    registry = configparser.ConfigParser(interpolation=None)
    try:
        registry.read(root / "profiles.ini", encoding="utf-8-sig")
        profiles = [(root / section["Path"] if section.getboolean("IsRelative", fallback=True)
                     else Path(section["Path"]), section.getboolean("Default", fallback=False))
                    for section in registry.values() if section.name.startswith("Profile") and section.get("Path")]
        install_defaults = [root / section["Default"] for section in registry.values()
                            if section.name.startswith("Install") and section.get("Default")]
        profile_paths = [path for path, _ in profiles]
        profile_defaults = [path for path, is_default in profiles if is_default]
    except (configparser.Error, ValueError) as error:
        raise ValueError("Could not read Thunderbird profiles.ini. Specify the active folder with --profile.") from error
    for candidates in (install_defaults, profile_defaults, profile_paths):
        existing = {path.resolve() for path in candidates if (path / "prefs.js").is_file()}
        if len(existing) == 1:
            return existing.pop()
        if len(existing) > 1:
            break
    raise ValueError("Could not choose a Thunderbird profile. Find Profile Folder in Thunderbird's Troubleshooting Information and specify it with --profile.")
