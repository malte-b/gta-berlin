"""HTTP helper.

Downloads go through curl rather than urllib on purpose: this machine sits
behind a TLS-inspecting proxy whose root certificate lives in the macOS
keychain. curl trusts the keychain, while the bundled CPython carries its own
CA bundle and rejects the intercepted chain. Shelling out keeps certificate
verification switched on instead of disabling it.
"""
import contextlib
import fcntl
import os
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Overpass allows only a couple of requests per client at a time and answers
# 429 or 504 beyond that, so parallel tile builds queue up for it here.
OVERPASS_HOST = "overpass-api.de"
BUSY = ("429", "502", "503", "504")


class FetchError(RuntimeError):
    pass


@contextlib.contextmanager
def file_lock(path):
    """An exclusive lock shared by every process on this machine."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def get(url, timeout=180, retries=2, post=None):
    """Return response body as bytes, or raise FetchError."""
    if OVERPASS_HOST in url:
        with file_lock(os.path.join(ROOT, "cache", ".overpass.lock")):
            return _get(url, timeout, max(retries, 6), post)
    return _get(url, timeout, retries, post)


def _get(url, timeout, retries, post):
    cmd = ["curl", "-sSL", "--fail", "--max-time", str(timeout),
           "-A", "gta-berlin/0.1 (open data pipeline)"]
    if post is not None:
        cmd += ["--data-binary", post if isinstance(post, str) else post.decode()]
    cmd.append(url)
    last = ""
    for attempt in range(retries + 1):
        p = subprocess.run(cmd, capture_output=True)
        if p.returncode == 0:
            return p.stdout
        last = p.stderr.decode(errors="replace").strip()
        if "404" in last:
            break
        if any(code in last for code in BUSY) and attempt < retries:
            time.sleep(min(300, 20 * 2 ** attempt))      # server busy: back off
    raise FetchError("%s: %s" % (url, last or "curl failed"))


def download(url, dest, timeout=180):
    data = get(url, timeout=timeout)
    tmp = dest + ".part"
    with open(tmp, "wb") as fh:
        fh.write(data)
    import os
    os.replace(tmp, dest)
    return len(data)
