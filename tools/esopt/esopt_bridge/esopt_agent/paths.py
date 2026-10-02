from __future__ import annotations

import os
import ctypes
from pathlib import Path


def workspace_root() -> Path:
    env = os.environ.get("ESOPT_ROOT")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[2]


def dcopf_dir() -> Path:
    root = workspace_root()
    for candidate in (root / "work" / "DCOPF", root / "DCOPF"):
        if candidate.exists():
            return candidate
    return root / "work" / "DCOPF"


def cases_dir() -> Path:
    return dcopf_dir() / "cases"


def build_dir() -> Path:
    return dcopf_dir() / "build"


def esoptc_exe() -> Path:
    exe = build_dir() / ("esoptc.exe" if os.name == "nt" else "esoptc")
    if exe.exists():
        return exe
    fallback = build_dir() / ("dc_opf.exe" if os.name == "nt" else "dc_opf")
    return fallback


def highs_dll() -> Path:
    root = workspace_root()
    for candidate in (
        build_dir() / "highs.dll",
        root / "tools" / "highs" / "bin" / "highs.dll",
        build_dir() / "libhighs.so",
    ):
        if candidate.exists():
            return candidate
    return build_dir() / "highs.dll"


def mingw_bin() -> Path:
    return workspace_root() / "tools" / "mingw64" / "bin"


def esopt_install() -> Path:
    root = workspace_root()
    for candidate in (root / "src" / "install", root / "esopt_src" / "install"):
        if candidate.exists():
            return candidate
    return root / "src" / "install"


def ensure_runtime_path() -> None:
    extras = [str(build_dir()), str(mingw_bin()), str(esopt_install() / "bin")]
    current = os.environ.get("PATH", "")
    prefix = os.pathsep.join(p for p in extras if Path(p).exists() and p not in current)
    if prefix:
        os.environ["PATH"] = prefix + os.pathsep + current


def native_path(value: Path) -> str:
    """Return a path the narrow-character native solver can open on Windows."""
    path = str(value)
    if os.name != "nt" or not value.exists():
        return path
    try:
        # The native ESOPT binary does not reliably decode non-ASCII absolute
        # paths. Its subprocess always runs with DCOPF as cwd, so project-local
        # assets should be passed as relative ASCII paths (for example
        # ``cases/case24.json`` and ``build/highs.dll``).
        relative = value.resolve().relative_to(dcopf_dir().resolve())
        return str(relative)
    except ValueError:
        pass
    try:
        root = Path(os.environ.get("ESOPT_ROOT", ""))
        alias = Path(os.environ.get("ESOPT_NATIVE_ROOT", str(root)))
        if root.exists() and alias.exists() and os.path.samefile(root, alias):
            try:
                path = str(alias / value.relative_to(root))
            except ValueError:
                pass
        get_short_path = ctypes.windll.kernel32.GetShortPathNameW
        get_short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
        get_short_path.restype = ctypes.c_uint32
        buffer = ctypes.create_unicode_buffer(32768)
        length = get_short_path(path, buffer, len(buffer))
        if length:
            return buffer.value
    except Exception:
        pass
    return path
