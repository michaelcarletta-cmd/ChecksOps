#!/usr/bin/env python3
import hashlib
import json
import sys
import zipfile


def hashes(zip_path):
    out = {}
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            out[info.filename] = hashlib.sha256(zf.read(info.filename)).hexdigest()
    print(json.dumps(out, sort_keys=True))


def read_entry(zip_path, name):
    with zipfile.ZipFile(zip_path) as zf:
        sys.stdout.buffer.write(zf.read(name))


def overlay(base_zip, dest_zip, spec_path):
    with open(spec_path, encoding="utf-8") as fh:
        replacements = json.load(fh)
    with zipfile.ZipFile(base_zip, "r") as src, zipfile.ZipFile(dest_zip, "w") as dst:
        replaced = set()
        for info in src.infolist():
            name = info.filename
            if name in replacements:
                data = open(replacements[name], "rb").read()
                dst.writestr(info, data)
                replaced.add(name)
            else:
                dst.writestr(info, src.read(name))
        for name, path in replacements.items():
            if name in replaced:
                continue
            dst.writestr(name, open(path, "rb").read())


def main(argv):
    cmd = argv[1]
    if cmd == "hashes":
        hashes(argv[2])
    elif cmd == "read":
        read_entry(argv[2], argv[3])
    elif cmd == "overlay":
        overlay(argv[2], argv[3], argv[4])
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv)
