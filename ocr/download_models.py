#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
下载 PP-OCRv5 ONNX 模型与字典到缓存目录（默认 ~/.dsh-ocr/models）。

特点：
- sha256 校验：已存在且校验通过则跳过；损坏/不完整文件自动删除重下
- 镜像支持：DSH_OCR_MODELS_MIRROR 指定镜像前缀（ghproxy 风格，直接拼在原 URL 前）
- 原子写入：先写 .part 再 rename，中断不会留下半截"可用"文件
- 自动重试：单文件最多 3 次

用法:
    python download_models.py                 # 下载到 ~/.dsh-ocr/models
    python download_models.py --model-dir D   # 自定义目录
    DSH_OCR_MODELS_MIRROR=https://ghproxy.com/ python download_models.py

模型来源：paddleocr-onnx 社区发布（PaddleOCR v5 官方模型导出），Apache-2.0 许可。
"""
import argparse
import hashlib
import os
import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://github.com/MeKo-Christian/paddleocr-onnx/releases/download/v1.0.0"
DICT_URL = "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_dict.txt"

# 文件 -> (默认 URL, sha256)。镜像通过环境变量 DSH_OCR_MODELS_MIRROR 注入。
MANIFEST = {
    "PP-OCRv5_mobile_det.onnx": (
        f"{BASE}/PP-OCRv5_mobile_det.onnx",
        "ca3014670099126189c9519ef770470c03bf41695fb138c6bc19737bd4ba2875",
    ),
    "PP-OCRv5_mobile_rec.onnx": (
        f"{BASE}/PP-OCRv5_mobile_rec.onnx",
        "64ea1b54ea0506609378a3638ff5b2547af7e24809b890e501fb0cce54de21f7",
    ),
    "ppocrv5_dict.txt": (
        DICT_URL,
        "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
    ),
}

MODELS_DIR = Path(os.environ.get("DSH_OCR_MODELS") or Path.home() / ".dsh-ocr" / "models")


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(256 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# GitHub 直连之外的公共加速代理。它们时好时坏，所以多备几个轮着试。
GITHUB_PROXIES = (
    "https://ghproxy.com",
    "https://gh-proxy.com",
    "https://ghfast.top",
)
# jsDelivr 是**首选替代源**，排在这些代理前面：它把 GitHub 仓库和 npm 包都做成了 CDN，
# 国内通常比 GitHub 直连快一到两个数量级，也比公共代理稳（不会被限流或跑路）。
# 两种托管方式都留着，谁先可用用谁：
#   1) 模型文件提交进本仓库的 `ocr/models/`  → 走 gh 端点
#   2) 或发成一个独立 npm 包 `dsh-ocr-models` → 走 npm 端点
JSDELIVR_GH = "https://cdn.jsdelivr.net/gh/grelvan/dsh-ocr-local@main"
JSDELIVR_NPM = "https://cdn.jsdelivr.net/npm/dsh-ocr-models@1"
MODELS_SUBDIR = "ocr/models"
# 单次连接/读取超时。太大的话，一个不通的源要挂好几分钟才轮到下一个。
REQUEST_TIMEOUT = 30
RETRIES = 3
# 低于这个速度就别耗着了，换下一个源试试。
# 「慢」不是「失败」——只按失败回退的话，一个 80KB/s 的直连能把 21MB 磨成五分钟，
# 而换个镜像可能就是几秒。`DSH_OCR_MIN_SPEED_KBPS` 可调。
DEFAULT_MIN_SPEED_KBPS = 200
SPEED_SAMPLE_SECONDS = 3
SPEED_GRACE_SECONDS = 8


class SlowSource(Exception):
    """当前源速度低于阈值 —— 值得换一个，而不是干等。"""


def min_speed_bytes_per_sec() -> int:
    raw = os.environ.get("DSH_OCR_MIN_SPEED_KBPS", "").strip()
    if raw.isdigit():
        return max(1, int(raw)) * 1024
    return DEFAULT_MIN_SPEED_KBPS * 1024


def source_urls(original: str):
    """给定 GitHub 上的原始 URL，返回各源下的候选 URL（按优先级）。

    顺序：直连 → jsDelivr（gh 端点，仅模型）→ jsDelivr（npm 端点，仅模型）→ 各公共代理。
    设了 `DSH_OCR_MODELS_MIRROR` 就只用它（尊重显式选择，不再自动回退）。
    """
    pinned = os.environ.get("DSH_OCR_MODELS_MIRROR", "").strip().rstrip("/")
    if pinned:
        return [f"{pinned}/{original}"]
    name = original.rsplit("/", 1)[-1]
    candidates = [original]
    if name.endswith(".onnx"):
        candidates.append(f"{JSDELIVR_GH}/{MODELS_SUBDIR}/{name}")
        candidates.append(f"{JSDELIVR_NPM}/{name}")
    candidates.extend(f"{proxy}/{original}" for proxy in GITHUB_PROXIES)
    return candidates


def source_label(url: str) -> str:
    if not url:
        return "直连"
    parts = url.split("/")
    host = parts[2] if len(parts) > 2 else url
    return "jsDelivr" if "jsdelivr" in host else host


def try_once(url: str, dest: Path, expected_sha: str, label: str, slow_bailout: bool = True) -> bool:
    """从一个 URL 拉一次（含进度、速度监测、校验、原子落盘）。"""
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "dsh-ocr-local/0.4"})
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp, open(tmp, "wb") as f:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            started = time.monotonic()
            mark_t, mark_bytes = started, 0
            limit = min_speed_bytes_per_sec()
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    sys.stdout.write(
                        f"\r    {pct}% ({done // 1024 // 1024}MB/{total // 1024 // 1024}MB) [{label}]"
                    )
                    sys.stdout.flush()
                now = time.monotonic()
                # 只在**还有剩余**时嫌慢。否则一个小文件（比如 74KB 的字典）一次就读完了，
                # 却因为采样窗口刚过而被判「太慢」丢弃重来 —— 白下一遍。
                has_more = total == 0 or done < total
                if slow_bailout and has_more and now - mark_t >= SPEED_SAMPLE_SECONDS:
                    speed = (done - mark_bytes) / (now - mark_t)
                    if speed < limit and now - started >= SPEED_GRACE_SECONDS:
                        raise SlowSource(f"{speed / 1024:.0f}KB/s < {limit / 1024:.0f}KB/s")
                    mark_t, mark_bytes = now, done
        sys.stdout.write("\n")
        sys.stdout.flush()
        actual = sha256_of(tmp)
        if actual != expected_sha:
            print(f"    sha256 不匹配（期望 {expected_sha[:12]}…，实际 {actual[:12]}…）", file=sys.stderr)
            tmp.unlink(missing_ok=True)
            return False
        tmp.rename(dest)
        print(f"  完成: {dest.name} ({dest.stat().st_size} 字节)")
        return True
    except SlowSource as e:
        sys.stdout.write("\n")
        sys.stdout.flush()
        tmp.unlink(missing_ok=True)
        print(f"    源 {label} 太慢（{e}），换下一个", file=sys.stderr)
        return False
    except Exception as e:
        sys.stdout.write("\n")
        sys.stdout.flush()
        tmp.unlink(missing_ok=True)
        print(f"    失败（{label}）: {type(e).__name__}: {e}", file=sys.stderr)
        return False


def download(url: str, dest: Path, expected_sha: str) -> bool:
    if dest.exists():
        try:
            if dest.stat().st_size > 0 and sha256_of(dest) == expected_sha:
                print(f"  已存在且校验通过，跳过: {dest.name}")
                return True
            print(f"  文件损坏（sha256 不匹配），重新下载: {dest.name}")
            dest.unlink()
        except OSError as e:
            print(f"  校验失败: {dest.name}: {e}", file=sys.stderr)
            return False

    sources = source_urls(url)
    for round_no in range(1, RETRIES + 1):
        # 最后一轮不再嫌慢：万一所有源都慢，也得把文件下完，而不是永远在换源。
        relax = round_no == RETRIES
        for candidate in sources:
            label = source_label(candidate)
            if round_no == 1 and candidate == sources[0]:
                print(f"  下载 {dest.name} ...")
            else:
                print(f"  重试 {dest.name}（第 {round_no} 轮 · 源: {label}"
                      + ("，本轮不再因慢中断" if relax else "") + "）...")
            if try_once(candidate, dest, expected_sha, label, slow_bailout=not relax):
                return True
            time.sleep(0.5)
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="下载 PP-OCRv5 ONNX 模型（含 sha256 校验）")
    ap.add_argument("--model-dir", default=str(MODELS_DIR), help="模型缓存目录")
    args = ap.parse_args()
    md = Path(args.model_dir)
    md.mkdir(parents=True, exist_ok=True)
    print(f"模型目录: {md}")
    print(f"共 {len(MANIFEST)} 个文件，约 21MB；已下过且校验通过的会跳过")
    first_url = next(iter(MANIFEST.values()))[0]
    print(f"源候选（按顺序回退）: {' → '.join(source_label(u) for u in source_urls(first_url))}")
    print(f"换源条件: 连接失败、或持续低于 {min_speed_bytes_per_sec() // 1024}KB/s"
          f"（DSH_OCR_MIN_SPEED_KBPS 可调）")
    proxies = ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY")
    if not any(os.environ.get(p) for p in proxies):
        print("提示: 本机若有可用代理，加上它通常最快（GitHub 直连常只有几十 KB/s）——")
        print("      https_proxy=http://<host>:<port> python setup.py")
    items = list(MANIFEST.items())
    ok = True
    for index, (name, (url, sha)) in enumerate(items, start=1):
        print(f"[{index}/{len(items)}] {name}")
        if not download(url, md / name, sha):
            ok = False
    if ok:
        print("全部完成 ✓")
        return 0
    print("", file=sys.stderr)
    print("有文件没下下来。按顺序试这几招：", file=sys.stderr)
    print("  1. 加代理（GitHub 直连不稳时最有效）：", file=sys.stderr)
    print("       https_proxy=http://127.0.0.1:7892 http_proxy=http://127.0.0.1:7892 python setup.py",
          file=sys.stderr)
    print("  2. 钉一个镜像：", file=sys.stderr)
    print("       DSH_OCR_MODELS_MIRROR=https://ghproxy.com/ python setup.py", file=sys.stderr)
    print("  3. 网络恢复后直接重跑，已下好的文件会跳过。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
