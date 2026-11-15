#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""构建用于 Cloudflare Workers Static Assets / 静态托管部署的 site/ 目录。

打包内容：
- app/index.html 与核心 JS（bettergi-parse.js / audio-engine.js / app.js）
- 占位 js/samples.js（不随公网分发游戏音频采样，由浏览器自动回退内置合成音色）
- library/*.json 示范曲库与 library/manifest.json（供网页端开箱试听）

用法：
    python tools/build_site.py
"""
import json
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.join(ROOT, "app")
LIB_DIR = os.path.join(ROOT, "library")
OUT_DIR = os.path.join(ROOT, "site")


def build_site(out_dir=OUT_DIR):
    """Build clean static bundle in out_dir without copyrighted audio samples."""
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)

    js_out = os.path.join(out_dir, "js")
    lib_out = os.path.join(out_dir, "library")
    os.makedirs(js_out, exist_ok=True)
    os.makedirs(lib_out, exist_ok=True)

    shutil.copy2(os.path.join(APP_DIR, "index.html"), os.path.join(out_dir, "index.html"))
    for name in ("bettergi-parse.js", "audio-engine.js", "app.js"):
        shutil.copy2(os.path.join(APP_DIR, "js", name), os.path.join(js_out, name))

    # Avoid 404 on static hosting while keeping copyrighted samples out of deployment.
    with open(os.path.join(js_out, "samples.js"), "w", encoding="utf-8") as f:
        f.write("/* Game audio samples omitted for copyright; fallback to built-in WebAudio synth. */\n")

    files = sorted(f for f in os.listdir(LIB_DIR) if f.lower().endswith(".json"))
    for fname in files:
        shutil.copy2(os.path.join(LIB_DIR, fname), os.path.join(lib_out, fname))

    with open(os.path.join(lib_out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"files": files}, f, ensure_ascii=False, indent=2)

    print(f"Built static site -> {out_dir} ({len(files)} showcase scores)")


if __name__ == "__main__":
    build_site()
