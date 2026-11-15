#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""构建用于 Cloudflare Pages / Workers Static Assets 静态托管的 site/ 目录。

打包内容：
- app/index.html 与核心 JS（bettergi-parse.js / audio-engine.js / app.js）
- 默认写占位 js/samples.js（回退内置合成音色）；
  传入 --with-samples 复制已有的 app/js/samples*.js；
  传入 --fetch-samples 时若缺失则先自动拉取 8 套乐器采样再打包
- library/*.json 示范曲库与 library/manifest.json（供网页端开箱试听）

用法：
    python app/scripts/build_site.py
    python app/scripts/build_site.py --with-samples
    python app/scripts/build_site.py --fetch-samples
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APP_DIR = os.path.join(ROOT, "app")
LIB_DIR = os.path.join(ROOT, "library")
OUT_DIR = os.path.join(ROOT, "site")


def build_site(out_dir=OUT_DIR, with_samples=False):
    """Build clean static bundle in out_dir, optionally including local samples*.js."""
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)

    js_out = os.path.join(out_dir, "js")
    lib_out = os.path.join(out_dir, "library")
    os.makedirs(js_out, exist_ok=True)
    os.makedirs(lib_out, exist_ok=True)

    shutil.copy2(os.path.join(APP_DIR, "index.html"), os.path.join(out_dir, "index.html"))
    for name in ("bettergi-parse.js", "audio-engine.js", "app.js"):
        shutil.copy2(os.path.join(APP_DIR, "js", name), os.path.join(js_out, name))

    sample_files = sorted(glob.glob(os.path.join(APP_DIR, "js", "samples*.js"))) if with_samples else []
    if sample_files:
        for src in sample_files:
            shutil.copy2(src, os.path.join(js_out, os.path.basename(src)))
        samples_note = f"{len(sample_files)} sample bundles"
    else:
        with open(os.path.join(js_out, "samples.js"), "w", encoding="utf-8") as f:
            f.write("/* Game audio samples omitted for copyright; fallback to built-in WebAudio synth. */\n")
        samples_note = "synth fallback placeholder"

    files = sorted(f for f in os.listdir(LIB_DIR) if f.lower().endswith(".json"))
    for fname in files:
        shutil.copy2(os.path.join(LIB_DIR, fname), os.path.join(lib_out, fname))

    with open(os.path.join(lib_out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"files": files}, f, ensure_ascii=False, indent=2)

    print(f"Built static site -> {out_dir} ({len(files)} showcase scores, {samples_note})")


def main(argv=None):
    ap = argparse.ArgumentParser(description="构建用于静态托管的 site/ 目录")
    ap.add_argument("--with-samples", action="store_true", help="若 app/js/samples*.js 存在则一并打包进 site/js/")
    ap.add_argument("--fetch-samples", action="store_true", help="若缺少采样文件则先运行 fetch_samples.py 拉取再打包")
    args = ap.parse_args(argv)

    with_samples = args.with_samples or args.fetch_samples
    if args.fetch_samples and not os.path.exists(os.path.join(APP_DIR, "js", "samples.js")):
        fetch_script = os.path.join(APP_DIR, "scripts", "fetch_samples.py")
        rc = subprocess.call([sys.executable, fetch_script])
        if rc != 0:
            print("⚠ 采样拉取失败，将回退使用合成音色占位", file=sys.stderr)

    build_site(with_samples=with_samples)
    return 0


if __name__ == "__main__":
    sys.exit(main())
