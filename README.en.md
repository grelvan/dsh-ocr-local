# dsh-ocr-local

[English](README.en.md) · [中文](README.md)

[![license](https://img.shields.io/npm/l/dsh-ocr-local?style=flat-square)](LICENSE) [![GitHub](https://img.shields.io/badge/GitHub-grelvan%2Fdsh--ocr--local-2f81f7?style=flat-square)](https://github.com/grelvan/dsh-ocr-local)

A **local OCR fallback** for DeepSeek Harness (Web): when the model a session is
routed to **cannot accept image input**, this plugin reads the text out of a
pasted image for it. When the model *can* see images, the plugin stays completely
silent.

The engine is PP-OCRv5 + ONNX Runtime — **CPU-only, fully offline**, and your
images never leave your machine.

## When the plugin acts, and when it stays silent

This is the most important table here. The decision is based on the input
capabilities the session's **actually routed model** declares
(`inputModalities`) — it is not a guess:

| Model routed by the session | Plugin behaviour | What the model actually receives |
| --- | --- | --- |
| **Explicitly cannot accept images** (e.g. a text-only model) | ✅ **Acts**: the image is saved to a local cache and its path is injected, so the model calls `ocr_image` | Text. For these models the harness substitutes only `[image omitted because this model accepts text only; …]` — **no path at all**, so without this plugin the model cannot read the image |
| **Explicitly accepts images** (multimodal model) | 🔇 **Silent**: no cache write, no hint injected | The image itself. The harness also prefixes a **read-only copy path**, so the model can call `ocr_image` on that path when it needs verbatim characters |
| **Cannot be determined** (provider not registered / lookup failed / no modalities declared) | 🔇 **Silent** | Handled by the harness as usual. Better not to intrude than to add an OCR hint to a model that may well see images |

"Silent when undetermined" is deliberate. If you genuinely want unconditional
intervention, set `autoOcr: 'always'` (see Configuration below).

> On **unlisted model ids**: the DeepSeek adapter explicitly returns
> `inputModalities: ["text"]` for ids that are not in the model catalog, so those
> text-only routes are covered by row 1. Other providers that report no modality
> information for undeclared models fall through to row 3 (silent).

## Relationship to vision models

The two paths do not interfere, because they operate at different layers:

- **This plugin only does local OCR**: it caches the image and asks the model to
  call `ocr_image`.
- **Whether the image is sent to the model** is decided by model capability and
  client configuration; the plugin does not interfere.

So with a multimodal model you do not need to do anything: the plugin withdraws
on its own. If you want the text read anyway, just tell the agent "read this
image with ocr_image".

## Quick start

### Step 1: Install the plugin

DSH profiles are isolated, so install the plugin into **the profile you use**
(the Web profile is usually called `web`).

**From a local clone:**

```sh
git clone https://github.com/grelvan/dsh-ocr-local.git
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-ocr-local
```

**Or straight from GitHub:**

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:grelvan/dsh-ocr-local
```

> The old npm release has been unpublished. Once it is republished,
> `... plugin --profile web add dsh-ocr-local` works again.

**Restart dsh** after installing, or the plugin will not take effect.

### Step 2: Prepare the recognition engine (once)

Send the agent any image and say:

> read the text in this image

If the engine is not ready yet, the tool tells you what is missing. Then say:

> install the OCR environment with the ocr_setup tool

The plugin will **create a virtualenv → install Python dependencies → download
the models** (about 20MB). After that every recognition runs locally in seconds.

> Manual install works too (replace `<profile>` with your profile name, e.g. `web`):
>
> ```sh
> python ~/.dsh/profiles/<profile>/node_modules/dsh-ocr-local/ocr/setup.py
> ```

### Step 3: Use it

**Option A: paste a screenshot (most common)**

Press Ctrl+V / Cmd+V in the Web composer. The image enters the session through
the browser's native attachment flow, and then splits according to the table
above: text-only model → this plugin covers it; multimodal model → the model
looks at the image directly.

**Option B: give the agent a path**

Send the agent the absolute path of an image file and say "read this image".

## What it handles / limits

| ✅ Good at | ⚠️ Mediocre |
| --- | --- |
| Screenshots, error dialogs, chat logs | Very small text (e.g. 4px) may have a few wrong characters |
| Mixed Chinese + English, long paragraphs | Complex backgrounds, stylized fonts, handwriting |
| Dark-theme screenshots (auto-inverted) | Blurry or heavily compressed images |

In the output, **lines that are too small or low-confidence are flagged ⚠**, so
you can tell which characters are not fully trustworthy.

### Why local OCR is still worth it for verbatim fidelity

A multimodal model looking at an image and local OCR reading it do **not** get
the same amount of information:

| | Multimodal model looking directly | Local OCR |
| --- | --- | --- |
| Resolution reaching the model | Bounded by the harness per-image pixel budget (640,000 px by default). A 1920×1080 screenshot is downscaled to about 1066×600 | Detection runs at a 736px longest side, but **recognition crops from the original image**, enlarging small text first (glyph height floor 20px, up to 6×) |
| Output | A paraphrase by the model, with **no signal about what it is unsure of** | Per-line text plus confidence / glyph height / box coordinates, with low-confidence lines flagged ⚠ |
| Best for | Understanding what is happening in the screenshot | Copying code, checking error messages, verifying hashes, reading table numbers |

An honest boundary note: the detection stage's 736px longest side is **more
conservative than the multimodal path's ~1066px**, so very small text in a
full-screen 4K screenshot can be missed here too. The accurate claim is
**"lines it does detect are transcribed more precisely"**, not "unlimited
resolution".

## Configuration (optional; defaults are fine)

Config file: `~/.dsh/profiles/web/cordis.patch.yml`

```yaml
- insert:
    - id: ocr
      name: 'dsh-ocr-local'
      config:
        autoOcr: true                                   # see the table below
        pythonPath: ~/miniconda3/envs/ocr/bin/python   # optional: pick a Python
        modelDir: ~/.dsh-ocr/models                     # optional: model directory
        maxCacheFiles: 300                              # optional: cache file cap
        maxCacheAgeDays: 30                             # optional: cache retention
```

`autoOcr` has three states:

| Value | Behaviour |
| --- | --- |
| `true` (default) | Automatic: acts **only when the model explicitly cannot accept images** |
| `false` | No automatic intervention at all. The model can still call `ocr_image` on request |
| `'always'` | Unconditional intervention (a hint is injected even for vision-capable models). The old 0.3.x behaviour; useful for troubleshooting |

Environment variables:

| Variable | Purpose |
| --- | --- |
| `DSH_OCR_MODELS_MIRROR` | Mirror prefix for model downloads (e.g. `https://ghproxy.com/`) |
| `DSH_OCR_PYTHON` | Which Python the OCR engine uses (auto-detected by default) |
| `DSH_OCR_MODELS` | Model directory (defaults to `~/.dsh-ocr/models`) |

## FAQ

**Q: I pasted an image but the model says it cannot see it.**
First check whether the current model is text-only (the only case this plugin is
meant to cover). If it is, verify the engine is ready ("check the OCR
environment with ocr_setup"). With a multimodal model the model simply looks at
the image, and this plugin is silent by design.

**Q: "Environment not ready" / "missing dependencies"?**
Tell the agent "install the OCR environment with ocr_setup", or run
`python ~/.dsh/profiles/web/node_modules/dsh-ocr-local/ocr/setup.py` manually.

**Q: Model download is slow or fails?**
Set the mirror and retry (idempotent):
`DSH_OCR_MODELS_MIRROR=https://ghproxy.com/ python .../ocr/setup.py`

**Q: pip reports externally-managed-environment (PEP 668)?**
Do not add `--break-system-packages`. Use `ocr/setup.py` — it creates a
virtualenv automatically and sidesteps the system Python restriction.

**Q: The recognition has wrong characters.**
Check the ⚠ flags in the output. For very small text the engine does misread:
scale the original image up and retry, or ask the agent to double-check that line.

**Q: Why does the plugin no longer intercept my paste?**
As of 0.4.0 it does not. The Web composer already intakes pasted images through
its native attachment flow; intercepting only prevented vision-capable models
from seeing the image. The old `pasteToPath` config key is gone — you can delete it.

## How it works (one sentence)

A pasted image enters the session as an attachment through the native flow →
the plugin listens for `user/message` events → it queries the routed model's
`inputModalities` → **only when the model explicitly cannot accept images** does
it save the image to `~/.dsh/ocr/cache` and inject its path → the model calls
`ocr_image` → local PP-OCRv5 models (ONNX Runtime, CPU-only) → text. Models are
downloaded to `~/.dsh-ocr/models` on first use and everything is offline
afterwards. More detail in [docs/usage.md](docs/usage.md).

## Upgrading

```sh
npx -y @deepseek-ai/dsh plugin --profile web update dsh-ocr-local
```

If you installed from a local directory, `git pull` and re-run `add` in the
plugin directory.

## License

MIT (code). The recognition models are Apache-2.0 (PaddleOCR) and are downloaded
during setup. See [LICENSE](LICENSE).
