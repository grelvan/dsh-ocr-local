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

关于 venv：建完一定会**实测 `import pip`**，不只看退出码。Debian / Deepin /
Ubuntu 上系统常缺 `python3.x-venv`（ensurepip 被剥离），此时 `python3 -m venv`
会成功退出却建出一个没有 pip 的空壳，后续 pip install 全挂。遇到这种环境会
自动改用 `uv venv --seed`（若 PATH 上有 uv），两条路都不通才报错并给出解法。
"""
import argparse
import collections
import hashlib
import json
import os
import re
import shutil
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
# 依赖默认走国内镜像：onnxruntime + opencv 加起来近百 MB，官方源在国内常常只有几 KB/s。
# 想用官方源：`DSH_OCR_PIP_INDEX=` （显式设为空）。
DEFAULT_PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"

# `--json`（插件在调）时，诊断信息一律走 stderr，stdout 只留最后那一个 JSON 对象。
# 否则插件 `JSON.parse(stdout)` 会被 "[setup] …" 这些行打乱，永远报「输出无法解析」。
JSON_MODE = False


def log(msg=""):
    """诊断输出：按模式选 stdout / stderr。"""
    print(msg, file=sys.stderr if JSON_MODE else sys.stdout, flush=True)


def pip_index():
    """依赖源：`DSH_OCR_PIP_INDEX` 可覆盖，设为空则回到官方源。"""
    raw = os.environ.get("DSH_OCR_PIP_INDEX")
    return DEFAULT_PIP_INDEX if raw is None else raw.strip()


def venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _run_streaming(cmd, timeout=INSTALL_TIMEOUT, env=None):
    """边跑边把子进程输出转给用户，同时留住尾部若干行供报错引用。

    冷启动最糟的观感就是「没有输出所以像卡死」——装依赖和下模型都会打进度，
    必须让它实时冒出来。
    """
    tail = collections.deque(maxlen=8)
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, env=env,
    )
    try:
        while True:
            chunk = proc.stdout.read(256)
            if not chunk:
                break
            sys.stdout.write(chunk)
            sys.stdout.flush()
            # 进度条靠 \r 刷新，所以 \r 和 \n 都要切，才能留住「最后看到的那一行」
            for piece in re.split(r"[\r\n]+", chunk):
                if piece.strip():
                    tail.append(piece.strip())
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise RuntimeError(f"命令超时（>{timeout}s）：{' '.join(map(str, cmd))}")
    text = "\n".join(tail)
    return subprocess.CompletedProcess(cmd, proc.returncode, text, text)


def run(cmd, **kw):
    """跑子进程。

    - `--json`（插件调用）：捕获输出，保证 stdout 只有一个 JSON；
    - 否则（人跑）：**实时转发**子进程输出，进度条不被吞。
    """
    timeout = kw.get("timeout", INSTALL_TIMEOUT)
    env = kw.get("env", dict(os.environ))
    if JSON_MODE:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    return _run_streaming(list(cmd), timeout=timeout, env=env)


def deps_ok(python: Path):
    r = run([str(python), "-c", "import onnxruntime, numpy, cv2"])
    return r.returncode == 0


def has_pip(python: Path) -> bool:
    """目标解释器能否 `import pip`。

    **不能只看 bin/python 是否存在**：Debian / Deepin / Ubuntu 上系统没装
    `python3.x-venv`（或 ensurepip 被剥离）时，`python3 -m venv` 会**成功退出**
    却建出一个没有 pip 的 venv，之后 `python -m pip install` 一律
    ModuleNotFoundError: No module named 'pip'。
    """
    if not python.exists():
        return False
    return run([str(python), "-c", "import pip"]).returncode == 0


def find_uv() -> str | None:
    """找 uv：先查 PATH，再查几个默认安装位置。

    不能只信 `shutil.which` —— 被插件以子进程拉起时（Web 服务、沙箱、systemd）
    PATH 常被精简，`~/.local/bin` 不在其中，uv 明明装着却找不到。
    """
    found = shutil.which("uv")
    if found:
        return found
    names = ("uv.exe", "uv") if os.name == "nt" else ("uv",)
    for base in (Path.home() / ".local" / "bin", Path.home() / ".cargo" / "bin"):
        for name in names:
            candidate = base / name
            if candidate.exists():
                return str(candidate)
    return None


def can_bootstrap_pip() -> bool:
    """当前解释器能否自己造出带 pip 的 venv（即 ensurepip 在不在）。"""
    return run([sys.executable, "-c", "import ensurepip"]).returncode == 0


def create_venv(venv_dir: Path):
    """建一个**带 pip** 的 venv，返回 `(python_path, 用的哪种方式)`。

    每一步都实测 `import pip`，不看退出码就下结论。ensurepip 缺失时**直接走 uv** ——
    否则标准 venv 会先喷一屏 ensurepip 报错、再留个没有 pip 的空壳，观感很差。
    """
    last = None
    uv = find_uv()

    if can_bootstrap_pip() or uv is None:
        shutil.rmtree(venv_dir, ignore_errors=True)
        last = run([sys.executable, "-m", "venv", str(venv_dir)])
        if last.returncode == 0 and has_pip(venv_python(venv_dir)):
            return venv_python(venv_dir), "python -m venv"

    if uv:
        log("[setup] 改用 uv 建环境（自带 pip，不依赖系统 ensurepip）...")
        shutil.rmtree(venv_dir, ignore_errors=True)
        last = run([uv, "venv", "--seed", "--python", sys.executable, str(venv_dir)])
        if last.returncode == 0 and has_pip(venv_python(venv_dir)):
            return venv_python(venv_dir), "uv venv --seed"

    # 3) 都失败 → 把可执行的三条出路直接写进报错里
    shutil.rmtree(venv_dir, ignore_errors=True)
    raw = [l.strip() for l in (last.stderr or last.stdout or "").splitlines() if l.strip()] if last else []
    # 优先保留点名真因的那几行；Debian 的报错末尾只剩 "Failing command: ..."，
    # 把 "ensurepip is not available / apt install python3-venv" 丢掉就白报了。
    key = [l for l in raw if any(k in l for k in ("ensurepip", "apt install", "python3-venv", "No module", "error"))]
    detail = key[:3] or raw[-3:]
    py = venv_python(venv_dir)
    raise RuntimeError(
        "无法创建带 pip 的 venv。"
        + (("\n  " + "\n  ".join(detail)) if detail else "")
        + "\n解法（任选其一）："
        + "\n  1. 装系统 venv/pip 支持：sudo apt install python3-venv python3-pip"
        + "\n  2. 没 sudo 就装 uv（推荐，自带 pip、不依赖系统 ensurepip）："
        + "\n       curl -LsSf https://astral.sh/uv/install.sh | sh"
        + f"\n       uv venv --seed {venv_dir}"
        + f"\n       uv pip install --python {py} " + " ".join(PIP_PACKAGES)
        + "\n  3. 用现成的 conda 环境：conda create -n ocr python=3.12 && conda activate ocr"
        + "\n       然后 python setup.py --no-venv"
    )


def ensure_venv(venv_dir: Path, no_venv: bool):
    """返回 (target_python, created: bool, message)"""
    if no_venv:
        return Path(sys.executable), False, "使用当前解释器（--no-venv）"
    if sys.prefix != sys.base_prefix:
        return Path(sys.executable), False, f"已在 venv 中（{sys.prefix}），直接使用"
    py = venv_python(venv_dir)
    if py.exists() and has_pip(py):
        return py, False, f"venv 已存在（{venv_dir}）"
    if py.exists():
        log("[setup] 现有 venv 没有可用 pip（多半是缺 ensurepip 建的半成品），删除重建 ...")
        shutil.rmtree(venv_dir, ignore_errors=True)
    log(f"[setup] 创建 venv: {venv_dir} ...")
    py, how = create_venv(venv_dir)
    return py, True, f"venv 已创建（{how}，{venv_dir}）"


def ensure_deps(python: Path, force: bool):
    if not force and deps_ok(python):
        return True, "依赖已就绪"
    index = pip_index()
    log(f"[setup] 安装依赖: {' '.join(PIP_PACKAGES)}（约 85MB）")
    if index:
        log(f"    源: {index}")
        log("    （换源：DSH_OCR_PIP_INDEX=…；想用官方源：DSH_OCR_PIP_INDEX=）")
    if has_pip(python):
        cmd = [str(python), "-m", "pip", "install", "--disable-pip-version-check"]
        if index:
            cmd += ["-i", index]
        cmd += PIP_PACKAGES
    else:
        # 解释器没 pip（--no-venv 指向系统 python，或环境被手工改过）→ 用 uv pip
        uv = find_uv()
        if not uv:
            raise RuntimeError(
                f"{python} 没有 pip，也没有找到 uv。请先让 `pip --version` 可用，或安装 uv。"
            )
        cmd = [uv, "pip", "install", "--python", str(python)]
        if index:
            cmd += ["-i", index]
        cmd += PIP_PACKAGES
    r = run(cmd)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()[-5:]
        raise RuntimeError("安装依赖失败:\n" + "\n".join(tail))
    if not deps_ok(python):
        raise RuntimeError("依赖安装完成但 import 校验失败（可能是无可用 wheel 的 Python 版本）")
    return True, "依赖安装完成"


def bundled_models_dir() -> Path:
    """随 npm 包一起发布的模型目录。

    不进 git（21MB 不该压在仓库里），由 `prepublishOnly` 在发布时准备好。
    """
    return ROOT.parent / "models"


def sha256_local(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(256 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def copy_bundled_models(model_dir: Path) -> bool:
    """把随包发布的模型复制就位。全部齐了才返回 True，缺一个都不算。

    为什么要随包发：模型原本放在 GitHub releases，对国内用户就是「一直卡在下载」的
    源头。跟着 npm 包走，用户 `dsh plugin add` 时就已经拿到了 —— 装完跑 setup
    只剩装依赖，**完全不联网下模型**。
    """
    src_dir = bundled_models_dir()
    if not src_dir.is_dir():
        return False
    try:
        sys.path.insert(0, str(ROOT))
        from download_models import MANIFEST  # noqa: PLC0415
    except Exception:
        return False
    model_dir.mkdir(parents=True, exist_ok=True)
    all_ok = True
    for name, (_url, expected_sha) in MANIFEST.items():
        dst = model_dir / name
        try:
            if dst.exists() and dst.stat().st_size > 0 and sha256_local(dst) == expected_sha:
                continue
        except OSError:
            pass
        src = src_dir / name
        try:
            if not src.exists() or sha256_local(src) != expected_sha:
                all_ok = False
                continue
        except OSError:
            all_ok = False
            continue
        shutil.copy2(src, dst)
    return all_ok


def ensure_models(python: Path, model_dir: Path):
    # 模型随 npm 包发布：装插件时就已经在本地，直接复制就位 —— 零下载。
    if copy_bundled_models(model_dir):
        log("[setup] 模型随包自带，直接就位，无需下载 ✓")
        return True, "模型已就绪（随包自带，未联网）"
    log(f"[setup] 下载识别模型到 {model_dir}（约 21MB，已下过的会跳过）")
    r = run([str(python), "-X", "utf8", str(DOWNLOAD_SCRIPT), "--model-dir", str(model_dir)])
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()[-4:]
        raise RuntimeError("模型下载失败。" + ("\n" + "\n".join(tail) if tail else ""))
    return True, "模型已就绪"


def check_report(venv_dir: Path, model_dir: Path, no_venv: bool):
    """--check：用目标解释器跑 ocr.py --doctor，汇总为单个 JSON。"""
    py = venv_python(venv_dir)
    target = Path(sys.executable) if no_venv else py
    result = {"ok": False, "venv": str(venv_dir), "python": str(target), "doctor": None, "missing": []}
    if not target.exists():
        result["missing"] = ["venv"]
        return result
    if not has_pip(target):
        # 「半成品 venv」：解释器在、pip 不在。以前这里照样跑 doctor，报出来的是
        # 「依赖缺失」，把「这环境根本装不进东西」这个真因盖掉了。
        result["missing"] = ["pip（venv 缺 pip，重建即可：python setup.py）"]
        return result
    r = run([str(target), "-X", "utf8", str(DOCTOR_SCRIPT), "--doctor", "--model-dir", str(model_dir)])
    try:
        doctor = json.loads(r.stdout)
    except Exception:
        doctor = {"ok": False, "python": {"ok": False, "error": (r.stderr or r.stdout)[:300]}}
    result["doctor"] = doctor
    result["ok"] = bool(doctor.get("ok"))
    result["missing"] = [k for k, v in (doctor.get("dependencies") or {}).items() if not v.get("ok")]
    result["missing"] += [k for k, v in (doctor.get("models") or {}).items() if not v.get("sha256_ok")]
    return result


def main():
    global JSON_MODE
    ap = argparse.ArgumentParser(description="dsh-ocr-local 自举安装")
    ap.add_argument("--venv", default=str(DEFAULT_VENV), help="venv 目录")
    ap.add_argument("--model-dir", default=str(DEFAULT_MODELS), help="模型目录")
    ap.add_argument("--check", action="store_true", help="只检查，不安装")
    ap.add_argument("--json", action="store_true", help="输出 JSON（诊断信息转 stderr，stdout 只留 JSON）")
    ap.add_argument("--no-venv", action="store_true", help="不建 venv，直接用当前解释器")
    ap.add_argument("--no-models", action="store_true", help="跳过模型下载")
    ap.add_argument("--force", action="store_true", help="强制重装依赖")
    args = ap.parse_args()
    JSON_MODE = bool(args.json)

    venv_dir = Path(args.venv)
    model_dir = Path(args.model_dir)

    if args.check:
        report = check_report(venv_dir, model_dir, args.no_venv)
        if args.json:
            print(json.dumps(report, ensure_ascii=False))  # stdout：机器读的那一份
        else:
            log("检查完成: " + ("✓ 就绪" if report["ok"] else "✗ 未就绪，缺少: " + ", ".join(report["missing"])))
        sys.exit(0 if report["ok"] else 1)

    steps = []
    log("[setup] dsh-ocr-local —— 本地 OCR 环境准备")
    log(f"  venv: {venv_dir}")
    log(f"  模型: {model_dir}")
    log("  共 3 步，首次约 2-6 分钟（大头是下载）；每步都会打进度，不用干等。")
    try:
        log("")
        log("[setup] 1/3 准备 Python 虚拟环境 ...")
        python, created, msg = ensure_venv(venv_dir, args.no_venv)
        steps.append(("venv", created, msg))

        log("[setup] 2/3 安装依赖 ...")
        ok1, msg1 = ensure_deps(python, args.force)
        steps.append(("dependencies", ok1, msg1))

        if not args.no_models:
            log("[setup] 3/3 准备识别模型（随包自带则无需下载）...")
            ok2, msg2 = ensure_models(python, model_dir)
            steps.append(("models", ok2, msg2))
        else:
            steps.append(("models", False, "跳过（--no-models）"))
    except Exception as e:
        if args.json:
            print(json.dumps(
                {"ok": False, "error": str(e), "steps": [s[1] for s in steps]},
                ensure_ascii=False,
            ))
        else:
            log("")
            log(f"[setup] 失败: {e}")
            log("  提示：网络问题可加代理后重跑（已装好的部分会跳过），例如")
            log("        https_proxy=http://127.0.0.1:7892 http_proxy=http://127.0.0.1:7892 \\")
            log(f"          python3 {Path(__file__).resolve()}")
        sys.exit(1)

    if args.json:
        print(json.dumps(
            {"ok": True, "venv": str(venv_dir), "steps": {s[0]: s[2] for s in steps}},
            ensure_ascii=False,
        ))
    else:
        log("")
        log("[setup] 完成 ✓ 以后每次识别都在本地完成，不再需要网络。")
        for name, _, msg in steps:
            log(f"  - {name}: {msg}")
        log(f"  自检: {venv_python(venv_dir)} {DOCTOR_SCRIPT} --doctor")
        log(f"  试用: {venv_python(venv_dir)} {DOCTOR_SCRIPT} <图片路径>")


if __name__ == "__main__":
    main()
