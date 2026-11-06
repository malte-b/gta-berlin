#!/usr/bin/env python3
"""Upload the Berlin tiles (data/berlin/) to S3-compatible object storage.

Any S3 API works: MinIO (e.g. the Datahub Berlin), Hetzner, STACKIT, IONOS,
Cloudflare R2, AWS. Custom endpoints use the MinIO Python SDK; AWS itself
uses the AWS CLI. Both read the existing credentials profile:

    aws configure --profile tiles            # access key and secret, once

    python3 pipeline/sync_tiles.py s3://gta-berlin \\
        --endpoint https://s3.example.berlin --profile tiles
    python3 pipeline/sync_tiles.py s3://gta-berlin --endpoint ... --dry-run

Only new and changed files go up, so after a rebuild of a few tiles the next
sync takes minutes. world.json goes last, so it never names a tile whose files
are not there yet. Every object gets its content type and a cache header:
tile files are cached for good, because world.json gives each tile a version
the game appends to its URLs and a rebuilt tile is fetched under a new one;
world.json itself is checked on every load.

The bucket must allow anonymous reads (a public-read bucket policy) and,
when the game runs on another domain, CORS GET requests from that domain.
Then build the game against it:

    VITE_TILE_BASE=https://s3.example.berlin/gta-berlin/ npm run build
"""
import argparse
import hashlib
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_berlin                                              # noqa: E402

OUT = build_berlin.OUT
TYPES = {
    ".glb": "model/gltf-binary",
    ".bin": "application/octet-stream",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".json": "application/json",
    ".hdr": "image/vnd.radiance",
}
FOREVER = "public, max-age=31536000, immutable"
# ground textures and the sky are not versioned: they rarely change, and a
# day's delay when they do is harmless
DAY = "public, max-age=86400"
GROUPS = [("tiles", FOREVER), ("ground", DAY), ("env", DAY)]


def log(m):
    print(m, flush=True)


def aws(args, cmd):
    full = ["aws"] + cmd
    if args.endpoint:
        full += ["--endpoint-url", args.endpoint]
    if args.profile:
        full += ["--profile", args.profile]
    if args.dry_run and cmd[:2] in (["s3", "sync"], ["s3", "cp"]):
        full.append("--dryrun")
    env = dict(os.environ)
    # newer CLIs checksum every upload in a way many S3-compatible stores
    # (MinIO, Hetzner, ...) reject; only send checksums the API requires
    env.setdefault("AWS_REQUEST_CHECKSUM_CALCULATION", "when_required")
    env.setdefault("AWS_RESPONSE_CHECKSUM_VALIDATION", "when_required")
    # a busy server answers 503 SlowDown; retry each request patiently ...
    env.setdefault("AWS_MAX_ATTEMPTS", "10")
    # ... and the whole step a few times: a sync only sends what is missing
    for attempt in range(1, 6):
        try:
            subprocess.run(full, env=env, check=True)
            return
        except subprocess.CalledProcessError:
            if attempt == 5:
                raise
            log("  some uploads failed; again in %d min" % (2 * attempt))
            time.sleep(120 * attempt)


def unknown_types():
    """File types under data/berlin/ that no rule here would upload."""
    seen = set()
    for _dir, _sub, files in os.walk(OUT):
        for f in files:
            ext = os.path.splitext(f)[1]
            if ext not in TYPES and not f.endswith(".part"):
                seen.add(ext or f)
    return sorted(seen)


def same_content(path, remote):
    """Fast size/time check, then ETag checks for copied files with new mtimes."""
    if remote is None:
        return False
    st = os.stat(path)
    if st.st_size != remote.size:
        return False
    if remote.last_modified and st.st_mtime <= remote.last_modified.timestamp():
        return True
    etag = (remote.etag or "").strip('"')
    if "-" not in etag:
        digest = hashlib.md5()
        with open(path, "rb") as fh:
            while data := fh.read(1024 * 1024):
                digest.update(data)
        return digest.hexdigest() == etag
    # The existing uploads used the CLI's 8 MiB multipart chunks; the SDK
    # defaults to 5 MiB. Check either without retransmitting unchanged GLBs.
    try:
        count = int(etag.rsplit("-", 1)[1])
    except ValueError:
        return False
    for chunk in (8 * 1024 * 1024, 5 * 1024 * 1024):
        if (st.st_size + chunk - 1) // chunk != count:
            continue
        parts = []
        with open(path, "rb") as fh:
            while data := fh.read(chunk):
                parts.append(hashlib.md5(data).digest())
        if hashlib.md5(b"".join(parts)).hexdigest() + "-%d" % len(parts) == etag:
            return True
    return False


def sync_endpoint(args, dest, client=None):
    """S3-compatible endpoints through the MinIO SDK and the existing profile.
    Assets first, tile manifests next, the world index only after all succeed.
    """
    if client is None:
        from minio import Minio
        from minio.credentials import AWSConfigProvider
        endpoint = urlsplit(args.endpoint)
        if endpoint.scheme not in ("http", "https") or endpoint.path not in ("", "/"):
            raise ValueError("endpoint must be an http(s) service URL without a path")
        client = Minio(endpoint=endpoint.netloc, secure=endpoint.scheme == "https",
                       credentials=AWSConfigProvider(profile=args.profile or "default"))
    target = urlsplit(dest)
    bucket = target.netloc
    prefix = target.path.strip("/")
    prefix = prefix + "/" if prefix else ""
    pending, manifests, managed, remote = [], [], set(), {}
    for sub, cache in GROUPS:
        for obj in client.list_objects(bucket, prefix=prefix + sub + "/", recursive=True):
            remote[obj.object_name] = obj
        for folder, _dirs, files in os.walk(os.path.join(OUT, sub)):
            for name in files:
                ext = os.path.splitext(name)[1]
                if ext not in TYPES or name.endswith(".part"):
                    continue
                path = os.path.join(folder, name)
                key = prefix + os.path.relpath(path, OUT).replace(os.sep, "/")
                managed.add(key)
                if same_content(path, remote.get(key)):
                    continue
                item = (path, key, TYPES[ext], cache)
                (manifests if name == "tile.json" else pending).append(item)
    size = sum(os.path.getsize(p) for p, *_ in pending + manifests)
    log("%d assets and %d tile manifests to upload (%.2f GiB)" % (len(pending), len(manifests), size / 1024 ** 3))
    if args.dry_run:
        log("Dry run: world.json would be published last")
        return

    def put(item):
        path, key, content_type, cache = item
        client.fput_object(bucket, key, path, content_type=content_type,
                           metadata={"Cache-Control": cache}, num_parallel_uploads=2)

    for label, items in (("assets", pending), ("tile manifests", manifests)):
        failures = []
        with ThreadPoolExecutor(max_workers=6) as pool:
            jobs = {pool.submit(put, item): item[1] for item in items}
            for count, future in enumerate(as_completed(jobs), 1):
                try:
                    future.result()
                except Exception as error:
                    failures.append((jobs[future], str(error)))
                if count % 200 == 0 or count == len(items):
                    log("  %d/%d %s uploaded" % (count, len(items), label))
        if failures:
            raise RuntimeError("upload failed for %d files; world index not published: %s" % (len(failures), failures[:3]))
    if args.delete:
        from minio.deleteobjects import DeleteObject
        errors = list(client.remove_objects(bucket, [DeleteObject(key) for key in remote
                      if key not in managed and os.path.splitext(key)[1] in TYPES and not key.endswith('.part')]))
        if errors:
            raise RuntimeError("remote deletion failed; world index not published: %s" % errors[:3])
    put((os.path.join(OUT, "world.json"), prefix + "world.json", "application/json", "no-cache"))
    log("world.json published")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dest", help="bucket and optional prefix, e.g. s3://gta-berlin/v1")
    ap.add_argument("--endpoint", help="S3 endpoint URL; omit for AWS itself")
    ap.add_argument("--profile", help="AWS CLI profile holding the credentials")
    ap.add_argument("--delete", action="store_true",
                    help="also delete remote files that are gone locally")
    ap.add_argument("--dry-run", action="store_true", help="show what would change")
    args = ap.parse_args()
    dest = args.dest.rstrip("/")
    if not dest.startswith("s3://"):
        ap.error("dest must be an s3:// URL")
    if not os.path.exists(os.path.join(OUT, "world.json")):
        ap.error("nothing to upload: build tiles with pipeline/build_berlin.py first")

    odd = unknown_types()
    if odd:
        log("Warning: not uploaded, no content type known for: %s" % ", ".join(odd))

    # versions for every finished tile, also if world.json predates them
    if not args.dry_run:
        log("world.json: %d tiles" % build_berlin.reindex())

    if args.endpoint:
        sync_endpoint(args, dest)
        log("Done. Tiles available at %s/%s/" % (args.endpoint.rstrip("/"), dest[len("s3://"):]))
        return 0

    for sub, cache in GROUPS:
        for ext, ctype in TYPES.items():
            src = os.path.join(OUT, sub)
            if not os.path.isdir(src):
                continue
            log("%s/*%s" % (sub, ext))
            cmd = ["s3", "sync", src, "%s/%s" % (dest, sub), "--only-show-errors",
                   "--exclude", "*", "--include", "*" + ext, "--exclude", "*.part",
                   "--content-type", ctype, "--cache-control", cache]
            if args.delete:
                cmd.append("--delete")
            aws(args, cmd)

    log("world.json")
    aws(args, ["s3", "cp", os.path.join(OUT, "world.json"), dest + "/world.json",
               "--only-show-errors", "--content-type", "application/json",
               "--cache-control", "no-cache"])
    log("Done. The game finds the tiles with VITE_TILE_BASE set to the bucket's "
        "public URL, e.g. %s/%s/" % ((args.endpoint or "https://<bucket host>").rstrip("/"),
                                     dest[len("s3://"):]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        sys.exit("aws failed (exit %d); nothing after that step was uploaded" % e.returncode)
