#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-ocr-local 一键自举安装：建 venv → 装依赖 → 下模型（幂等，可重复执行）。

由插件的 ocr_setup 工具调用，也可手动运行；只依赖 Python 标准库。

用法:
    python setup.py                 # 完整安装（venv + 依赖 + 模型）
    python setup.py --check         # 只检查现状（相当于 ocr.py --doctor 的快捷入口）
    python setup.py --json          # 结尾输出单个 JSON 对象（供插件解析）
    python setup.py --no-venv       # 不建 venv，直接在当前解释器装依赖
    python setup.py --no-models     # 只装依赖，不下载模型
    python setup.py --force         # 强制重装依赖（即使 import 成功）

环境变量:
    DSH_OCR_VENV          venv 目录（默认 ~/.dsh-ocr/venv）
    DSH_OCR_MODELS        模型目录（默认 ~/.dsh-ocr/models）
    DSH_OCR_MODELS_MIRROR 模型下载镜像前缀（ghproxy 风格），透传给 download_models.py
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOWNLOAD_SCRIPT = ROOT / "download_models.py"
DOCTOR_SCRIPT = ROOT / "ocr.py"
DEFAULT_VENV = Path(os.environ.get("DSH_OCR_VENV") or Path.home() / ".dsh-ocr" / "venv")
DEFAULT_MODELS = Path(os.environ.get("DSH_OCR_MODELS") or Path.home() / ".dsh-ocr" / "models")
PIP_PACKAGES = ["onnxruntime", "numpy", "opencv-python-headless"]
INSTALL_TIMEOUT = 900


def venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def run(cmd, **kw):
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("timeout", INSTALL_TIMEOUT)
    kw.setdefault("env", dict(os.environ))
    return subprocess.run(cmd, **kw)


def deps_ok(python: Path):
    r = run([str(python), "-c", "import onnxruntime, numpy, cv2"])
    return r.returncode == 0


def ensure_venv(venv_dir: Path, no_venv: bool):
    """返回 (target_python, created: bool, message)"""
    if no_venv:
        return Path(sys.executable), False, "使用当前解释器（--no-venv）"
    if sys.prefix != sys.base_prefix:
        return Path(sys.executable), False, f"已在 venv 中（{sys.prefix}），直接使用"
    py = venv_python(venv_dir)
    if py.exists():
        return py, False, f"venv 已存在（{venv_dir}）"
    print(f"[setup] 创建 venv: {venv_dir} ...")
    r = run([sys.executable, "-m", "venv", str(venv_dir)])
    if r.returncode != 0:
        raise RuntimeError(
            f"创建 venv 失败: {r.stderr.strip()[:500] or r.stdout.strip()[:500]}\n"
            "（Ubuntu/Debian 可能需要: sudo apt install python3-venv）"
        )
    return py, True, f"venv 已创建（{venv_dir}）"


def ensure_deps(python: Path, force: bool):
    if not force and deps_ok(python):
        return True, "依赖已就绪"
    print(f"[setup] 安装依赖: {' '.join(PIP_PACKAGES)} ...")
    r = run([str(python), "-m", "pip", "install", "--disable-pip-version-check", *PIP_PACKAGES])
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()[-5:]
        raise RuntimeError("pip install 失败:\n" + "\n".join(tail))
    if not deps_ok(python):
        raise RuntimeError("依赖安装完成但 import 校验失败（可能是无可用 wheel 的 Python 版本）")
    return True, "依赖安装完成"


def ensure_models(python: Path, model_dir: Path):
    print(f"[setup] 下载模型到 {model_dir} ...")
    r = run([str(python), "-X", "utf8", str(DOWNLOAD_SCRIPT), "--model-dir", str(model_dir)])
    if r.returncode != 0:
        raise RuntimeError("模型下载失败：" + (r.stderr or r.stdout).strip().splitlines()[-3:][-1])
    return True, "模型已就绪"


def check_report(venv_dir: Path, model_dir: Path, no_venv: bool):
    """--check：用目标解释器跑 ocr.py --doctor，汇总为单个 JSON。"""
    py = venv_python(venv_dir)
    result = {"ok": False, "venv": str(venv_dir), "python": None, "doctor": None, "missing": []}
    if no_venv or py.exists():
        r = run([str(py if not no_venv else sys.executable), "-X", "utf8", str(DOCTOR_SCRIPT), "--doctor", "--model-dir", str(model_dir)])
        try:
            doctor = json.loads(r.stdout)
        except Exception:
            doctor = {"ok": False, "python": {"ok": False, "error": (r.stderr or r.stdout)[:300]}}
        result["python"] = str(py if not no_venv else sys.executable)
        result["doctor"] = doctor
        result["ok"] = bool(doctor.get("ok"))
        result["missing"] = [k for k, v in (doctor.get("dependencies") or {}).items() if not v.get("ok")]
        result["missing"] += [k for k, v in (doctor.get("models") or {}).items() if not v.get("sha256_ok")]
    else:
        result["missing"] = ["venv"]
    return result


def main():
    ap = argparse.ArgumentParser(description="dsh-ocr-local 自举安装")
    ap.add_argument("--venv", default=str(DEFAULT_VENV), help="venv 目录")
    ap.add_argument("--model-dir", default=str(DEFAULT_MODELS), help="模型目录")
    ap.add_argument("--check", action="store_true", help="只检查，不安装")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--no-venv", action="store_true", help="不建 venv，直接用当前解释器")
    ap.add_argument("--no-models", action="store_true", help="跳过模型下载")
    ap.add_argument("--force", action="store_true", help="强制重装依赖")
    args = ap.parse_args()

    venv_dir = Path(args.venv)
    model_dir = Path(args.model_dir)

    if args.check:
        report = check_report(venv_dir, model_dir, args.no_venv)
        if args.json:
            print(json.dumps(report, ensure_ascii=False))
        else:
            print("检查完成: " + ("✓ 就绪" if report["ok"] else "✗ 未就绪，缺少: " + ", ".join(report["missing"])))
        sys.exit(0 if report["ok"] else 1)

    steps = []
    ok = False
    try:
        python, created, msg = ensure_venv(venv_dir, args.no_venv)
        steps.append(("venv", created, msg))
        ok1, msg1 = ensure_deps(python, args.force)
        steps.append(("dependencies", ok1, msg1))
        if not args.no_models:
            ok2, msg2 = ensure_models(python, model_dir)
            steps.append(("models", ok2, msg2))
        else:
            steps.append(("models", False, "跳过（--no-models）"))
        ok = True
    except Exception as e:
        if args.json:
            print(json.dumps({"ok": False, "error": str(e), "steps": [s[1] for s in steps]}, ensure_ascii=False))
        else:
            print(f"[setup] 失败: {e}")
        sys.exit(1)

    if args.json:
        print(json.dumps({"ok": True, "venv": str(venv_dir), "steps": {s[0]: s[2] for s in steps}}, ensure_ascii=False))
    else:
        print("[setup] 完成 ✓")
        for name, _, msg in steps:
            print(f"  - {name}: {msg}")
        print(f"  测试: {venv_python(venv_dir)} {DOCTOR_SCRIPT} <图片路径>")


if __name__ == "__main__":
    main()
