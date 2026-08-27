"""HTTP helper.

Downloads go through curl rather than urllib on purpose: this machine sits
behind a TLS-inspecting proxy whose root certificate lives in the macOS
keychain. curl trusts the keychain, while the bundled CPython carries its own
CA bundle and rejects the intercepted chain. Shelling out keeps certificate
verification switched on instead of disabling it.
"""
import subprocess


class FetchError(RuntimeError):
    pass


def get(url, timeout=180, retries=2, post=None):
    """Return response body as bytes, or raise FetchError."""
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
    raise FetchError("%s: %s" % (url, last or "curl failed"))


def download(url, dest, timeout=180):
    data = get(url, timeout=timeout)
    tmp = dest + ".part"
    with open(tmp, "wb") as fh:
        fh.write(data)
    import os
    os.replace(tmp, dest)
    return len(data)
