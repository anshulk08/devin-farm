"""Deploy-by-SHA source fetch (WORKSPLIT lane A item 3): https only, shallow fetch of one commit,
hooks/submodules/LFS disabled, then path/size/symlink validation. Agent code never runs on the host."""
from __future__ import annotations

import os
import re
import shutil
import tempfile
from pathlib import Path

from .drivers.base import DeployError, run_cmd

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
URL_RE = re.compile(r"^https://[A-Za-z0-9._~:/@%+-]+$")
PATH_RE = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
MAX_BYTES = 2 * 1024 * 1024
MAX_FILES = 300
GIT_ENV = {
    "GIT_TERMINAL_PROMPT": "0", "GIT_ALLOW_PROTOCOL": "https", "GIT_LFS_SKIP_SMUDGE": "1",
    "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
}
GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "-c", "protocol.version=2",
             "-c", "submodule.recurse=false", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false"]


def validate_request(repo_url: str, sha: str, path: str) -> None:
    if not URL_RE.match(repo_url or ""):
        raise DeployError("lint_failed", "repo_url must be an https:// URL")
    if not SHA_RE.match(sha or ""):
        raise DeployError("lint_failed", "sha must be a full 40-character lowercase hex commit id")
    if not PATH_RE.match(path or "") or ".." in path.split("/") or path.startswith(".git"):
        raise DeployError("lint_failed", "path must be a relative directory path without '..'")


def validate_tree(root: Path) -> None:
    total = files = 0
    for p in root.rglob("*"):
        if p.is_symlink():
            raise DeployError("lint_failed", f"symlinks are not allowed: {p.relative_to(root)}")
        if p.is_file():
            files += 1
            total += p.stat().st_size
    if files == 0:
        raise DeployError("lint_failed", "path contains no files")
    if files > MAX_FILES or total > MAX_BYTES:
        raise DeployError("lint_failed", f"program too large ({files} files, {total} bytes; "
                                         f"limits {MAX_FILES} files, {MAX_BYTES} bytes)")


async def fetch_source(repo_url: str, sha: str, path: str, work: Path, timeout: float = 90.0) -> Path:
    """Returns the directory holding `path` at `sha`, inside `work` (caller deletes `work`)."""
    validate_request(repo_url, sha, path)
    repo = work / "repo"
    repo.mkdir(parents=True)
    env = {**os.environ, **GIT_ENV}

    async def git(*args: str) -> str:
        import asyncio
        proc = await asyncio.create_subprocess_exec(
            "git", *GIT_FLAGS, *args, cwd=repo, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise DeployError("fetch_failed", f"git {args[0]} timed out after {timeout:.0f}s") from None
        text = out.decode("utf-8", "replace").strip()
        if proc.returncode != 0:
            raise DeployError("fetch_failed", f"git {args[0]} failed", text[-2000:])
        return text

    await git("init", "-q")
    await git("fetch", "-q", "--depth", "1", "--no-recurse-submodules", "--no-tags", repo_url, sha)
    await git("-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD")
    got = await git("rev-parse", "HEAD")
    if got != sha:
        raise DeployError("fetch_failed", f"fetched {got}, expected {sha}")
    src = (repo / path).resolve()
    if repo.resolve() not in src.parents or not src.is_dir():
        raise DeployError("lint_failed", f"path {path!r} is not a directory in the repository")
    out = work / "program"
    shutil.copytree(src, out, symlinks=False, ignore=shutil.ignore_patterns(".git"))
    validate_tree(out)
    return out


def make_workdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="farm-run-"))
