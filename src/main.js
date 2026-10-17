const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const open = (options) => invoke("plugin:dialog|open", { options });

const $ = (id) => document.getElementById(id);
let busy = false;
let outputDir = "";

document.querySelector("#app").innerHTML = `
<div class="shell">
 <aside class="sidebar">
  <div class="brand"><img class="brand-icon" src="./app-icon.png" alt="" width="43" height="43"/><div><strong>stemix</strong><small>AI AUDIO STUDIO</small></div></div>
  <button class="nav active" id="nav-separate"><span>◉</span> Separate</button>
  <button class="nav" id="nav-engine"><span>♬</span> Demucs Engine</button>
  <div class="side-bottom"><div class="status-dot"></div> Local processing <small>v0.1.0 · Open source</small></div>
 </aside>
 <main class="main">
  <header><div><div class="eyebrow">YOUR CREATIVE WORKSPACE</div><h1>Stem Separation</h1><p>Split any track into clean, production-ready stems with local AI.</p></div><div class="pill">⚡ GPU ACCELERATED</div></header>
  <section class="layout">
   <div class="left">
    <div class="panel"><div class="panel-head"><h2>01 <span>Source Audio</span></h2><span class="hint">WAV · MP3 · FLAC · M4A</span></div>
     <div class="drop" id="drop"><div class="drop-icon">♫</div><strong>Drop your audio file here</strong><span>or choose a file from your computer</span><button class="secondary" id="pick">Browse files</button><div id="file-name" class="filename">No file selected</div></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>02 <span>Separation Settings</span></h2></div>
     <div class="fields"><label>AI Model<select id="model"><option value="htdemucs_ft">Demucs v4 · Fine-tuned (HQ)</option><option value="htdemucs">Demucs v4 · Fast</option><option value="htdemucs_6s">Demucs v4 · 6 stems</option><option value="mdx_extra">MDX Extra</option></select></label>
     <label>Processing Device<select id="device"><option value="cuda">NVIDIA GPU · CUDA</option><option value="cpu">CPU</option></select></label>
     <label>Shifts <span class="value" id="shifts-value">2</span><input id="shifts" type="range" min="1" max="10" value="2"/></label>
     <label>Output Quality<select id="format"><option value="int24">WAV · 24-bit PCM</option><option value="float32">WAV · 32-bit Float</option><option value="mp3">MP3 · 320 kbps</option></select></label></div>
     <div class="stems"><div class="stems-head">STEMS TO EXTRACT</div><div class="stem-grid" id="stem-grid"><div>🎙️ <b>Vocals</b></div><div>🥁 <b>Drums</b></div><div>〰 <b>Bass</b></div><div>♫ <b>Other</b></div></div><label class="check"><input type="checkbox" id="two"/> Vocals + instrumental only (2 stems)</label></div>
    </div>
   </div>
   <div class="right">
    <div class="panel"><div class="panel-head"><h2>03 <span>Output</span></h2><button class="text-button" id="reset-output" hidden>Use source folder</button></div><div class="output-path" id="output-path">Select audio to use its project folder</div><button class="secondary full" id="output">Choose output folder</button></div>
    <div class="panel" id="engine-panel"><div class="panel-head"><h2>04 <span>Engine</span></h2></div><label for="python">Python executable</label><div class="engine-path"><input id="python" spellcheck="false" placeholder="...\\.venv\\Scripts\\python.exe"/><button class="secondary" id="pick-python" aria-label="Choose Python executable" title="Choose Python executable">Browse</button></div></div>
    <div class="panel process"><div class="panel-head"><h2>05 <span>Processing</span></h2><span class="indicator" id="status" role="status">LOADING</span></div><div class="progress-row"><span id="progress-label" aria-live="polite">Connecting to engine…</span><b id="percent">0%</b></div><div class="progress"><div id="bar"></div></div><button class="primary full" id="start" disabled>▶ &nbsp; Separate Stems</button><button class="secondary full" id="cancel" disabled>Stop processing</button><button class="text-button" id="open-output">Open output folder ↗</button></div>
   </div>
  </section>
  <section class="panel log-panel"><div class="panel-head"><h2>PROCESS LOG</h2><button class="text-button" id="clear">Clear</button></div><pre id="log" role="log" aria-live="polite">Stemix ready. Select an audio file to begin.</pre></section>
  <footer>Stemix processes audio locally. Your files are never uploaded to a server.</footer>
 </main>
</div>`;

const log = (message) => {
  const el = $("log");
  el.textContent = (el.textContent + "\n" + message).slice(-100000);
  el.scrollTop = el.scrollHeight;
};
const setStatus = (value) => {
  $("status").textContent = value;
  $("status").dataset.state = value.toLowerCase();
};
const setInput = (path) => {
  if (busy) return;
  $("file-name").textContent = path;
  $("file-name").title = path;
  $("drop").classList.add("selected");
  $("drop").dataset.path = path;
  refreshOutput();
};
function sourceOutput() {
  const input = $("drop").dataset.path || "";
  const separator = Math.max(input.lastIndexOf("\\"), input.lastIndexOf("/"));
  return separator >= 0 ? input.slice(0, separator + 1) + "stems" : "";
}
function refreshOutput() {
  const path = outputDir || sourceOutput();
  $("output-path").textContent =
    path || "Select audio to use its project folder";
  $("output-path").title = path;
  $("reset-output").hidden = !outputDir;
}
$("reset-output").addEventListener("click", () => {
  outputDir = "";
  refreshOutput();
});
const updateProgress = (pct) => {
  $("bar").style.width = `${pct}%`;
  $("percent").textContent = `${Math.round(pct)}%`;
};
const setBusy = (isBusy) => {
  busy = isBusy;
  $("start").disabled = isBusy;
  $("cancel").disabled = !isBusy;
  setStatus(isBusy ? "RUNNING" : "READY");
  document
    .querySelectorAll(
      "#pick, #output, #reset-output, #pick-python, .fields select, .fields input, #two, #python",
    )
    .forEach((el) => {
      el.disabled = isBusy;
    });
};

$("pick").addEventListener("click", async () => {
  try {
    const file = await open({
      multiple: false,
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3", "flac", "m4a", "aiff", "ogg"],
        },
      ],
    });
    if (file) setInput(file);
  } catch (error) {
    log("ERROR: " + error);
  }
});
$("drop").addEventListener("dragover", (e) => {
  e.preventDefault();
  $("drop").classList.add("hover");
});
$("drop").addEventListener("dragleave", () =>
  $("drop").classList.remove("hover"),
);
$("drop").addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("hover");
});
// Native OS drag-and-drop paths are delivered through Tauri's window event API.
(async () => {
  await window.__TAURI__.webviewWindow
    .getCurrentWebviewWindow()
    .onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths?.length)
        setInput(event.payload.paths[0]);
    });
})().catch((error) => log("Drag and drop unavailable: " + error));
$("shifts").addEventListener(
  "input",
  () => ($("shifts-value").textContent = $("shifts").value),
);
$("output").addEventListener("click", async () => {
  try {
    const folder = await open({ directory: true, multiple: false });
    if (folder) {
      outputDir = folder;
      refreshOutput();
    }
  } catch (error) {
    log("ERROR: " + error);
  }
});
$("start").addEventListener("click", async () => {
  if (busy) return;
  const input = $("drop").dataset.path;
  if (!input) {
    log("ERROR: Choose an audio file first.");
    return;
  }
  const job = {
    input,
    output: outputDir,
    python: $("python").value.trim(),
    model: $("model").value,
    device: $("device").value,
    shifts: Number($("shifts").value),
    format: $("format").value,
    twoStems: $("two").checked,
  };
  setBusy(true);
  saveSettings();
  try {
    updateProgress(0);
    $("progress-label").textContent = "Starting Demucs…";
    log("Starting: " + input);
    await invoke("start_job", { job });
  } catch (e) {
    setBusy(false);
    setStatus("ERROR");
    $("progress-label").textContent = "Could not start separation";
    log("ERROR: " + e);
  }
});
$("cancel").addEventListener("click", async () => {
  try {
    await invoke("cancel_job");
    log("Stop requested…");
  } catch (e) {
    log("ERROR: " + e);
  }
});
$("open-output").addEventListener("click", async () => {
  try {
    const path = outputDir || sourceOutput();
    if (!path) {
      log("Choose an audio file first.");
      return;
    }
    await invoke("open_output", { path });
  } catch (e) {
    log("ERROR: " + e);
  }
});
$("clear").addEventListener("click", () => ($("log").textContent = ""));
async function initialize() {
  await listen("job-event", ({ payload }) => {
    if (payload.kind === "log") {
      log(payload.message);
    }
    if (payload.kind === "status" || payload.kind === "progress") {
      $("progress-label").textContent = payload.message;
      if (typeof payload.progress === "number")
        updateProgress(payload.progress);
    }
    if (payload.kind === "done") {
      setBusy(false);
      updateProgress(100);
      setStatus("COMPLETE");
      $("progress-label").textContent = "Separation complete";
      log("✓ " + payload.message);
    }
    if (payload.kind === "error") {
      setBusy(false);
      setStatus("ERROR");
      $("progress-label").textContent = "Processing stopped";
      log("ERROR: " + payload.message);
    }
  });
  $("python").value = await invoke("default_python");
  restoreSettings();
  updateStems();
  setBusy(false);
  $("progress-label").textContent = "Waiting for audio";
}
initialize().catch((error) => {
  setStatus("ERROR");
  $("progress-label").textContent = "Engine connection failed";
  log("ERROR: " + error);
});

const settingIds = ["python", "model", "device", "shifts", "format", "two"];
function saveSettings() {
  try {
    const values = Object.fromEntries(
      settingIds.map((id) => [id, id === "two" ? $(id).checked : $(id).value]),
    );
    localStorage.setItem("stemix.settings", JSON.stringify(values));
  } catch (error) {
    log("Could not save settings: " + error);
  }
}
function restoreSettings() {
  try {
    const values = JSON.parse(localStorage.getItem("stemix.settings") || "{}");
    for (const id of settingIds) {
      if (id === "two" && typeof values[id] === "boolean")
        $(id).checked = values[id];
      else if (typeof values[id] === "string") {
        const el = $(id);
        if (
          el.tagName !== "SELECT" ||
          [...el.options].some((option) => option.value === values[id])
        )
          el.value = values[id];
      }
    }
    refreshOutput();
    $("shifts-value").textContent = $("shifts").value;
  } catch (error) {
    log("Could not restore settings: " + error);
  }
}
function updateStems() {
  const stems = $("two").checked
    ? ["Vocals", "Instrumental"]
    : $("model").value === "htdemucs_6s"
      ? ["Vocals", "Drums", "Bass", "Other", "Guitar", "Piano"]
      : ["Vocals", "Drums", "Bass", "Other"];
  $("stem-grid").replaceChildren(
    ...stems.map((name) => {
      const tile = document.createElement("div");
      const label = document.createElement("b");
      label.textContent = name;
      tile.textContent = "♫";
      tile.append(label);
      return tile;
    }),
  );
}
for (const id of settingIds)
  $(id).addEventListener("change", () => {
    updateStems();
    saveSettings();
  });
$("pick-python").addEventListener("click", async () => {
  try {
    const path = await open({
      multiple: false,
      filters: [{ name: "Python executable", extensions: ["exe"] }],
    });
    if (path) {
      $("python").value = path;
      saveSettings();
    }
  } catch (error) {
    log("ERROR: " + error);
  }
});
$("nav-separate").addEventListener("click", () => {
  $("drop").scrollIntoView({ behavior: "smooth", block: "center" });
  $("pick").focus({ preventScroll: true });
});
$("nav-engine").addEventListener("click", () => {
  $("engine-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  $("python").focus({ preventScroll: true });
});
