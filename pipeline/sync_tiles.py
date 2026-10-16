#!/usr/bin/env python3
"""Upload the Berlin tiles (data/berlin/) to S3-compatible object storage.

Any S3 API works: MinIO (e.g. the Datahub Berlin), Hetzner, STACKIT, IONOS,
Cloudflare R2, AWS. The upload goes through the AWS CLI (`brew install
awscli`); credentials come from its own configuration, never from here:

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
import os
import subprocess
import sys
import time

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
    log("world.json: %d tiles" % build_berlin.reindex())

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
