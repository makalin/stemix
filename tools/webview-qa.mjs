// Run against a locally launched WebView2 with remote debugging enabled.
// No testing or debugging server is included in the shipped application.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const endpoint = process.env.STEMIX_DEBUG_URL || "http://127.0.0.1:9223";
const targets = await fetch(`${endpoint}/json/list`).then((response) =>
  response.json(),
);
const target = targets.find(
  (page) => page.type === "page" && page.url.includes("tauri.localhost"),
);
assert.ok(target, "Stemix WebView must be running");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown")
    errors.push(message.params.exceptionDetails);
  if (
    message.method === "Log.entryAdded" &&
    message.params.entry.level === "error"
  )
    errors.push(message.params.entry);
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timeout);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      await evaluate(
        "document.getElementById('status')?.textContent === 'READY'",
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const initial = await evaluate(`({
    title: document.title,
    status: document.getElementById('status').textContent,
    python: document.getElementById('python').value,
    output: document.getElementById('output-path').textContent,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.documentElement).backgroundColor,
    overflow: document.documentElement.scrollWidth > innerWidth,
    logoLoaded: document.querySelector('.brand-icon').naturalWidth > 0,
    startEnabled: !document.getElementById('start').disabled
  })`);
  assert.equal(initial.status, "READY");
  assert.equal(initial.colorScheme, "dark");
  assert.equal(initial.overflow, false);
  assert.equal(initial.logoLoaded, true);
  assert.equal(initial.startEnabled, true);
  assert.ok(initial.python.endsWith("python.exe"));
  assert.match(initial.output, /Select audio to use its project folder/);
  await evaluate(
    "document.getElementById('drop').dataset.path = 'C:/Music/Projects/kflay/track.wav'; document.getElementById('reset-output').click()",
  );
  assert.equal(
    await evaluate("document.getElementById('output-path').textContent"),
    "C:/Music/Projects/kflay/stems",
  );
  await evaluate(
    "delete document.getElementById('drop').dataset.path; document.getElementById('reset-output').click()",
  );
  await evaluate("document.getElementById('start').click()");
  assert.match(
    await evaluate("document.getElementById('log').textContent"),
    /Choose an audio file first/,
  );
  assert.equal(
    await evaluate("document.getElementById('start').disabled"),
    false,
  );
  await evaluate(
    "document.getElementById('drop').dataset.path = 'C:/stemix-missing-test.wav'; document.getElementById('start').click()",
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      await evaluate(
        "document.getElementById('status').textContent === 'ERROR'",
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    await evaluate("document.getElementById('status').dataset.state"),
    "error",
  );
  assert.equal(
    await evaluate("document.getElementById('start').disabled"),
    false,
  );
  assert.equal(
    await evaluate("document.getElementById('cancel').disabled"),
    true,
  );
  await evaluate("delete document.getElementById('drop').dataset.path");
  const original = await evaluate(
    "({ model: document.getElementById('model').value, two: document.getElementById('two').checked })",
  );
  try {
    await evaluate(
      "document.getElementById('two').checked = false; document.getElementById('model').value = 'htdemucs_6s'; document.getElementById('model').dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await evaluate("document.getElementById('stem-grid').children.length"),
      6,
    );
    await evaluate(
      "document.getElementById('two').checked = true; document.getElementById('two').dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await evaluate("document.getElementById('stem-grid').children.length"),
      2,
    );
    await send("Page.reload", { ignoreCache: true });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        await evaluate(
          "document.getElementById('status')?.textContent === 'READY'",
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      await evaluate("document.getElementById('model').value"),
      "htdemucs_6s",
    );
    assert.equal(
      await evaluate("document.getElementById('two').checked"),
      true,
    );
  } finally {
    await evaluate(
      `document.getElementById('model').value = ${JSON.stringify(original.model)}; document.getElementById('two').checked = ${original.two}; document.getElementById('model').dispatchEvent(new Event('change'))`,
    );
  }
  const missingInput =
    await evaluate(`window.__TAURI__.core.invoke('start_job', { job: {
    python: document.getElementById('python').value,
    input: 'C:\\\\stemix-missing-test.wav',
    output: document.getElementById('output-path').textContent,
    model: 'htdemucs', device: 'cpu', shifts: 1, format: 'int24', twoStems: false
  }}).then(() => 'unexpected success', error => String(error))`);
  assert.match(
    missingInput,
    /Input audio file not found|Select an existing python.exe/,
  );
  let engine;
  if (process.argv.includes("--engine")) {
    await mkdir("artifacts/flat-output", { recursive: true });
    const sampleRate = 44100;
    const frames = sampleRate * 2;
    const audio = Buffer.alloc(44 + frames * 4);
    audio.write("RIFF");
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write("WAVEfmt ", 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(2, 22);
    audio.writeUInt32LE(sampleRate, 24);
    audio.writeUInt32LE(sampleRate * 4, 28);
    audio.writeUInt16LE(4, 32);
    audio.writeUInt16LE(16, 34);
    audio.write("data", 36);
    audio.writeUInt32LE(frames * 4, 40);
    for (let frame = 0; frame < frames; frame++) {
      const sample = Math.round(
        Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 1000,
      );
      audio.writeInt16LE(sample, 44 + frame * 4);
      audio.writeInt16LE(sample, 46 + frame * 4);
    }
    const input = path.resolve("artifacts/flat-output/qa-input.wav");
    const output = path.resolve("artifacts/flat-output/stems");
    await writeFile(input, audio);
    const job = {
      input,
      output: "",
      python: initial.python,
      model: process.env.STEMIX_QA_MODEL || "htdemucs",
      device: "cuda",
      shifts: Number(process.env.STEMIX_QA_SHIFTS || 1),
      format: "int24",
      twoStems: false,
    };
    await evaluate(
      "(async () => { window.stemixQaEvents = []; window.stemixQaUnlisten = await window.__TAURI__.event.listen('job-event', ({ payload }) => window.stemixQaEvents.push(payload)); })()",
    );
    console.log("Starting real CUDA separation of a generated two-second WAV…");
    await evaluate(
      `window.__TAURI__.core.invoke('start_job', { job: ${JSON.stringify(job)} })`,
    );
    let result;
    try {
      for (let attempt = 0; attempt < 240; attempt++) {
        result = await evaluate(
          "window.stemixQaEvents.find(event => ['done', 'error'].includes(event.kind))",
        );
        if (result) break;
        if (attempt % 15 === 0)
          console.log(
            await evaluate(
              "window.stemixQaEvents.at(-1)?.message || 'Loading model…'",
            ),
          );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.ok(result, "Engine must finish within four minutes");
      assert.equal(result.kind, "done", result.message);
      const progressEvents = await evaluate(
        "window.stemixQaEvents.filter(event => typeof event.progress === 'number')",
      );
      const percentages = progressEvents.map((event) => event.progress);
      assert.deepEqual(
        percentages,
        [...percentages].sort((a, b) => a - b),
        "Overall progress must never reset",
      );
      assert.ok(
        progressEvents
          .filter((event) => event.kind !== "done")
          .every((event) => event.progress < 100),
        "100% is reserved for successful completion",
      );
      assert.equal(percentages.at(-1), 100);
      for (const stem of ["vocals", "drums", "bass", "other"]) {
        const { stat } = await import("node:fs/promises");
        assert.ok(
          (await stat(path.join(output, `qa-input - ${stem}.wav`))).size > 44,
        );
      }
      const { readdir } = await import("node:fs/promises");
      assert.ok(
        (await readdir(output, { withFileTypes: true })).every((entry) =>
          entry.isFile(),
        ),
        "Stems must be flat, without model or song directories",
      );
      engine = {
        ...result,
        model: job.model,
        shifts: job.shifts,
        device: job.device,
        output,
        progressSamples: percentages,
      };
      await evaluate("window.stemixQaEvents = []");
      await evaluate(
        `window.__TAURI__.core.invoke('start_job', { job: ${JSON.stringify(job)} })`,
      );
      await evaluate("window.__TAURI__.core.invoke('cancel_job')");
      let cancelled;
      for (let attempt = 0; attempt < 50; attempt++) {
        cancelled = await evaluate(
          "window.stemixQaEvents.find(event => event.kind === 'error')",
        );
        if (cancelled) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(cancelled, "Cancellation must terminate the child process");
      engine.cancellationVerified = true;
    } finally {
      if (!result) await evaluate("window.__TAURI__.core.invoke('cancel_job')");
      await evaluate(
        "window.stemixQaUnlisten(); delete window.stemixQaEvents; delete window.stemixQaUnlisten",
      );
    }
  }
  await evaluate("document.getElementById('nav-engine').click()");
  assert.equal(await evaluate("document.activeElement.id"), "python");
  await evaluate("document.getElementById('nav-separate').click()");
  assert.equal(await evaluate("document.activeElement.id"), "pick");
  await evaluate(
    "document.getElementById('clear').click(); window.scrollTo({ top: 0, behavior: 'instant' })",
  );
  const layouts = [];
  await mkdir("artifacts", { recursive: true });
  for (const [width, height] of [
    [1080, 730],
    [1150, 800],
    [840, 640],
    [1440, 900],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const layout = await evaluate(
      "({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, contentTop: document.querySelector('main').getBoundingClientRect().top, contentBottom: document.querySelector('footer').getBoundingClientRect().bottom })",
    );
    assert.equal(layout.overflow, false, `Horizontal overflow at ${width}`);
    assert.ok(layout.contentTop <= 1, "Main content must start at the top");
    if (width === 1080)
      assert.ok(
        layout.contentBottom <= height,
        "Default desktop layout must fit vertically",
      );
    layouts.push(layout);
    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    await writeFile(
      `artifacts/stemix-${width}.png`,
      Buffer.from(screenshot.data, "base64"),
    );
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await send("Page.reload", { ignoreCache: true });
  assert.deepEqual(errors, [], "WebView must have no runtime or CSP errors");
  const report = {
    initial,
    layouts,
    missingInput,
    engine,
    errors,
    checks: [
      "native IPC",
      "dark theme",
      "logo",
      "source project output path",
      "empty input validation",
      "failed job recovery",
      "six and two stem views",
      "settings persistence",
      "navigation focus",
      "responsive layout",
    ],
  };
  await writeFile("artifacts/webview-qa.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket.close();
}
