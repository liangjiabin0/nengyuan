"""
Cross-platform helper for locating and running LibreOffice (soffice).

Windows, Linux and macOS are all supported:

- The executable is resolved from ``AI4ES_SOFFICE`` / ``SOFFICE_PATH`` /
  ``LIBREOFFICE_PATH``, then the portable copy in ``<project>/tools/libreoffice``,
  then ``PATH``, then the usual per-platform install
  directories.  On Windows ``soffice.com`` is preferred over ``soffice.exe``
  because only the ``.com`` stub waits for the conversion to finish.
- On Linux, where AF_UNIX sockets may be blocked (sandboxed VMs), an
  LD_PRELOAD shim is compiled on demand.  Platforms without AF_UNIX (Windows)
  or without a C compiler skip the shim instead of raising.

Usage:
    from office.soffice import find_soffice, run_soffice, SofficeNotFound

    result = run_soffice(["--headless", "--convert-to", "pdf", "input.docx"])

Call soffice through run_soffice, not through subprocess with get_soffice_env():
the env dict carries the shim but names no user profile, and a non-root sandbox
cannot bootstrap the default one -- soffice aborts with "User installation could
not be completed" and converts nothing. get_soffice_env() stays public for the
callers that build their own argv (they must pass -env:UserInstallation too).

``SofficeNotFound`` subclasses ``FileNotFoundError`` so existing callers that
only catch ``FileNotFoundError`` keep reporting "LibreOffice is missing"
instead of crashing.

Run as a script for a one-line probe:
    python soffice.py --probe          # prints the path, exit 0/3
    python soffice.py --headless --convert-to pdf in.docx
Exit code 3 means "LibreOffice is not installed here" -- callers should fall
back to another renderer or skip the preview, not retry.
"""

import contextlib
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path

NOT_FOUND_EXIT = 3

ENV_OVERRIDES = ("AI4ES_SOFFICE", "SOFFICE_PATH", "LIBREOFFICE_PATH")

_BIN_NAMES = ("soffice.com", "soffice.exe", "soffice") if os.name == "nt" else ("soffice", "libreoffice")

_WINDOWS_DIRS = (
    r"C:\Program Files\LibreOffice\program",
    r"C:\Program Files (x86)\LibreOffice\program",
    r"C:\Program Files\LibreOffice 7\program",
    r"C:\ProgramData\chocolatey\lib\libreoffice-fresh\tools\LibreOffice\program",
)

_POSIX_PATHS = (
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/opt/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
)


class SofficeNotFound(FileNotFoundError):
    """LibreOffice is not installed (or not discoverable) on this machine."""

    def __init__(self, message: str = ""):
        super().__init__(message or _not_found_message())


def _not_found_message() -> str:
    hint = (
        "set AI4ES_SOFFICE to soffice.com"
        if os.name == "nt"
        else "install libreoffice or set AI4ES_SOFFICE"
    )
    return f"LibreOffice (soffice) not found on this machine; {hint}."


def _project_candidates() -> Iterable[str]:
    """Portable LibreOffice unpacked into <project>/tools/libreoffice."""
    roots = []
    env_root = (os.environ.get("AI4ES_PROJECT_ROOT") or "").strip().strip('"')
    if env_root:
        roots.append(Path(env_root))
    roots.extend(Path(__file__).resolve().parents)
    names = ("soffice.com", "soffice.exe") if os.name == "nt" else ("soffice",)
    for root in roots:
        program = root / "tools" / "libreoffice" / "program"
        for name in names:
            yield str(program / name)


def _candidates() -> Iterable[str]:
    for key in ENV_OVERRIDES:
        value = (os.environ.get(key) or "").strip().strip('"')
        if value:
            yield value
    yield from _project_candidates()
    for name in _BIN_NAMES:
        found = shutil.which(name)
        if found:
            yield found
    if os.name == "nt":
        for directory in _WINDOWS_DIRS:
            expanded = Path(os.path.expandvars(directory))
            for name in ("soffice.com", "soffice.exe"):
                yield str(expanded / name)
        local = os.environ.get("LOCALAPPDATA")
        if local:
            yield str(Path(local) / "Programs" / "LibreOffice" / "program" / "soffice.com")
    else:
        yield from _POSIX_PATHS


def find_soffice(required: bool = False) -> str | None:
    """Return an absolute path to the soffice launcher, or None when missing."""
    for candidate in _candidates():
        path = Path(candidate)
        if path.is_file() and (os.name == "nt" or os.access(path, os.X_OK)):
            return str(path)
    if required:
        raise SofficeNotFound()
    return None


def get_soffice_env() -> dict:
    env = os.environ.copy()

    if sys.platform.startswith("linux"):
        env["SAL_USE_VCLPLUGIN"] = "svp"
        shim = _ensure_shim() if _needs_shim() else None
        if shim:
            env["LD_PRELOAD"] = str(shim)

    return env


def run_soffice(args: Iterable[str], **kwargs) -> subprocess.CompletedProcess:
    """Run soffice with a throwaway user profile. Raises SofficeNotFound when absent."""
    args = list(args)
    exe = find_soffice(required=True)
    with contextlib.ExitStack() as stack:
        if not any(str(a).startswith("-env:UserInstallation") for a in args):
            profile = stack.enter_context(
                tempfile.TemporaryDirectory(prefix="lo_profile_", ignore_cleanup_errors=True)
            )
            args = [f"-env:UserInstallation={Path(profile).as_uri()}"] + args
        return subprocess.run([exe] + args, env=get_soffice_env(), **kwargs)


_SHIM_SO = Path(tempfile.gettempdir()) / "lo_socket_shim.so"


def _needs_shim() -> bool:
    af_unix = getattr(socket, "AF_UNIX", None)
    if af_unix is None:
        return False
    try:
        s = socket.socket(af_unix, socket.SOCK_STREAM)
        s.close()
        return False
    except OSError:
        return True


def _ensure_shim() -> Path | None:
    if _SHIM_SO.exists():
        return _SHIM_SO
    if not shutil.which("gcc"):
        return None

    src = Path(tempfile.gettempdir()) / "lo_socket_shim.c"
    src.write_text(_SHIM_SOURCE)
    try:
        subprocess.run(
            ["gcc", "-shared", "-fPIC", "-o", str(_SHIM_SO), str(src), "-ldl"],
            check=True,
            capture_output=True,
        )
    except (subprocess.CalledProcessError, OSError):
        return None
    finally:
        src.unlink(missing_ok=True)
    return _SHIM_SO


_SHIM_SOURCE = r"""
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int (*real_socket)(int, int, int);
static int (*real_socketpair)(int, int, int, int[2]);
static int (*real_listen)(int, int);
static int (*real_accept)(int, struct sockaddr *, socklen_t *);
static int (*real_close)(int);
static int (*real_read)(int, void *, size_t);

/* Per-FD bookkeeping (FDs >= 1024 are passed through unshimmed). */
static int is_shimmed[1024];
static int peer_of[1024];
static int wake_r[1024];            /* accept() blocks reading this */
static int wake_w[1024];            /* close()  writes to this      */
static int listener_fd = -1;        /* FD that received listen()    */

__attribute__((constructor))
static void init(void) {
    real_socket     = dlsym(RTLD_NEXT, "socket");
    real_socketpair = dlsym(RTLD_NEXT, "socketpair");
    real_listen     = dlsym(RTLD_NEXT, "listen");
    real_accept     = dlsym(RTLD_NEXT, "accept");
    real_close      = dlsym(RTLD_NEXT, "close");
    real_read       = dlsym(RTLD_NEXT, "read");
    for (int i = 0; i < 1024; i++) {
        peer_of[i] = -1;
        wake_r[i]  = -1;
        wake_w[i]  = -1;
    }
}

/* ---- socket ---------------------------------------------------------- */
int socket(int domain, int type, int protocol) {
    if (domain == AF_UNIX) {
        int fd = real_socket(domain, type, protocol);
        if (fd >= 0) return fd;
        /* socket(AF_UNIX) blocked – fall back to socketpair(). */
        int sv[2];
        if (real_socketpair(domain, type, protocol, sv) == 0) {
            if (sv[0] >= 0 && sv[0] < 1024) {
                is_shimmed[sv[0]] = 1;
                peer_of[sv[0]]    = sv[1];
                int wp[2];
                if (pipe(wp) == 0) {
                    wake_r[sv[0]] = wp[0];
                    wake_w[sv[0]] = wp[1];
                }
            }
            return sv[0];
        }
        errno = EPERM;
        return -1;
    }
    return real_socket(domain, type, protocol);
}

/* ---- listen ---------------------------------------------------------- */
int listen(int sockfd, int backlog) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        listener_fd = sockfd;
        return 0;
    }
    return real_listen(sockfd, backlog);
}

/* ---- accept ---------------------------------------------------------- */
int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        /* Block until close() writes to the wake pipe. */
        if (wake_r[sockfd] >= 0) {
            char buf;
            real_read(wake_r[sockfd], &buf, 1);
        }
        errno = ECONNABORTED;
        return -1;
    }
    return real_accept(sockfd, addr, addrlen);
}

/* ---- close ----------------------------------------------------------- */
int close(int fd) {
    if (fd >= 0 && fd < 1024 && is_shimmed[fd]) {
        int was_listener = (fd == listener_fd);
        is_shimmed[fd] = 0;

        if (wake_w[fd] >= 0) {              /* unblock accept() */
            char c = 0;
            write(wake_w[fd], &c, 1);
            real_close(wake_w[fd]);
            wake_w[fd] = -1;
        }
        if (wake_r[fd] >= 0) { real_close(wake_r[fd]); wake_r[fd]  = -1; }
        if (peer_of[fd] >= 0) { real_close(peer_of[fd]); peer_of[fd] = -1; }

        if (was_listener)
            _exit(0);                        /* conversion done – exit */
    }
    return real_close(fd);
}
"""


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--probe":
        exe = find_soffice()
        print(exe or "soffice-not-found")
        sys.exit(0 if exe else NOT_FOUND_EXIT)
    try:
        result = run_soffice(argv)
    except SofficeNotFound as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(NOT_FOUND_EXIT)
    sys.exit(result.returncode)
