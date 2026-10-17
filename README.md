# Stemix

**GPU-accelerated AI stem separation for Windows.** A local-first desktop interface built with Rust, Tauri 2, and vanilla JavaScript. Stemix controls a separate, existing Demucs/PyTorch installation; it does not modify Ultimate Vocal Remover.

> Status: **v0.1.0 developer preview**. Windows EXE and NSIS builds verified locally. CUDA integration was tested with `htdemucs` and a generated two-second WAV. Release signing and broader audio/model testing are still pending.

## Features

- Compact native desktop window with dark UI, dark title bar, and keyboard focus indicators
- File picker and operating-system drag and drop
- Demucs models: `htdemucs_ft`, `htdemucs`, `htdemucs_6s`, `mdx_extra`
- CUDA / CPU selection, shifts 1–10
- Four stems (vocals, drums, bass, other), six stems with `htdemucs_6s`, or vocals + instrumental
- 24-bit WAV, 32-bit float WAV, or 320 kbps MP3
- Custom output directory, live process log, progress and cancel
- Native Windows completion beep, including while minimized
- Overall progress across all model/shift passes; 100% only after every file is saved
- Saved model, device and Python settings between sessions
- Entirely local processing; no file upload or telemetry

## Prerequisites (Windows)

- Node.js 20+, Rust stable with MSVC toolchain, Microsoft C++ Build Tools, WebView2
- Python 3.11 virtual environment with `demucs`, compatible `torch` and `torchaudio`
- NVIDIA CUDA-compatible PyTorch for GPU processing

### Existing environment

The initial default Python path is:

```text
C:\AI\Demucs\.venv\Scripts\python.exe
```

Check it in PowerShell:

```powershell
& "C:\AI\Demucs\.venv\Scripts\python.exe" -c "import torch, demucs; print(torch.cuda.is_available())"
```

By default, results are written directly to a `stems` subfolder beside the source audio. For example, `C:\Music\Projects\kflay\track.wav` produces `C:\Music\Projects\kflay\stems\track - vocals.wav`, `track - drums.wav`, and the other stems. No model or song subfolders are added. The song prefix distinguishes different tracks in the same project. Stemix creates the output folder when separation starts. Use **Choose output folder** for a custom destination, or **Use source folder** to return to the project's folder. Custom destinations apply to the current session; new sessions always use the source project by default.

The frontend uses plain HTML, CSS, and JavaScript served directly by Tauri. No frontend bundler or development server is required.

## Development

```powershell
cd stemix
npm install
npm run dev
```

## Windows installer

```powershell
npm run build
```

Tauri's NSIS installer output is under `src-tauri\target\release\bundle\nsis\`. **The installer does not bundle Python, PyTorch, Demucs, or model weights.** End users must install/configure an engine separately; a self-contained installer is future work.

The standalone executable is `src-tauri\target\release\stemix.exe`. Icons are generated from `app_icon.png` with `npm run tauri -- icon app_icon.png`.

## Local verification

CI checks JavaScript syntax and builds the Windows installer. For a local WebView smoke test, launch a dedicated test instance from PowerShell:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
Start-Process .\src-tauri\target\release\stemix.exe
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
node tools/webview-qa.mjs
```

The test checks native IPC, dark controls, settings persistence, validation recovery, navigation, and layout at four viewport sizes. Reports and screenshots are saved under `artifacts/`. Add `--engine` to separate a generated two-second WAV using CUDA/`htdemucs`, verify four output files, and test cancellation. The engine test requires the configured Python environment and may download model weights on first use. Close the test instance afterward; ordinary launches do not enable remote debugging.

## How it works

The Rust backend launches your selected `python.exe` with an embedded adapter using Demucs's Python API, passing arguments as a structured list (not via a shell). The adapter controls the flat output layout without changing the existing Python installation. The UI receives live events for logs and job status. A native Windows sound plays only after successful completion. Model weights may be downloaded automatically by Demucs on first use. No login or HF token is required for publicly available weights, though rate limits may apply.

## Roadmap

- [ ] Build/test signed Windows releases
- [ ] Bundled Python engine and setup wizard
- [x] Persistent settings
- [ ] Multi-file queue
- [ ] Audio preview, stem waveform display, BPM detection
- [ ] Per-stem progress and clearer cancellation reporting
- [ ] macOS and Linux packaging

## License

Stemix application source is MIT licensed. Third-party dependencies and model weights retain their respective licenses; review them before redistributing a bundled engine or weights. You are responsible for rights to the audio you process or distribute.

