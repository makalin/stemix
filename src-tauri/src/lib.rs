use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{Emitter, State};

const ENGINE_SCRIPT: &str = include_str!("separate.py");

#[cfg(windows)]
fn completion_beep() {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBeep(kind: u32) -> i32;
    }
    // Native sound works even when the WebView is minimized or unfocused.
    unsafe {
        MessageBeep(0x40);
    }
}

#[cfg(not(windows))]
fn completion_beep() {}

#[derive(Default)]
struct ProcessState {
    child: Arc<Mutex<Option<std::process::Child>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    input: String,
    output: String,
    python: String,
    model: String,
    device: String,
    shifts: u8,
    format: String,
    two_stems: bool,
}

#[derive(Deserialize, Serialize, Clone)]
struct JobEvent {
    kind: String,
    message: String,
    progress: Option<f64>,
}

fn emit(app: &tauri::AppHandle, kind: &str, message: impl Into<String>, progress: Option<f64>) {
    let _ = app.emit(
        "job-event",
        JobEvent {
            kind: kind.into(),
            message: message.into(),
            progress,
        },
    );
}

fn valid_python(p: &str) -> bool {
    let path = Path::new(p);
    path.is_file()
        && path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("python.exe"))
}

#[tauri::command]
fn default_python() -> String {
    r"C:\AI\Demucs\.venv\Scripts\python.exe".into()
}

fn output_directory(input: &Path, selected: &str) -> Result<PathBuf, String> {
    let output = if selected.is_empty() {
        input
            .parent()
            .ok_or("Source audio has no parent directory")?
            .join("stems")
    } else {
        PathBuf::from(selected)
    };
    if !output.is_absolute() {
        return Err("Output directory must be an absolute path".into());
    }
    Ok(output)
}

#[tauri::command]
fn start_job(
    app: tauri::AppHandle,
    state: State<'_, ProcessState>,
    job: Job,
) -> Result<(), String> {
    if !valid_python(&job.python) {
        return Err("Select an existing python.exe from your Demucs virtual environment".into());
    }
    if !Path::new(&job.input).is_file() {
        return Err("Input audio file not found".into());
    }
    let output = output_directory(Path::new(&job.input), &job.output)?;
    if !["htdemucs_ft", "htdemucs", "htdemucs_6s", "mdx_extra"].contains(&job.model.as_str()) {
        return Err("Unsupported model".into());
    }
    if !["cuda", "cpu"].contains(&job.device.as_str()) {
        return Err("Unsupported device".into());
    }
    if !(1..=10).contains(&job.shifts) {
        return Err("Shifts must be 1–10".into());
    }
    if !["int24", "float32", "mp3"].contains(&job.format.as_str()) {
        return Err("Unsupported format".into());
    }
    let mut guard = state.child.lock().map_err(|_| "Process lock error")?;
    if guard.is_some() {
        return Err("A separation job is already running".into());
    }
    std::fs::create_dir_all(&output)
        .map_err(|e| format!("Could not create output directory: {e}"))?;
    let mut args = vec![
        "-u".to_string(),
        "-c".into(),
        ENGINE_SCRIPT.into(),
        "-d".into(),
        job.device,
        "-n".into(),
        job.model,
        "--shifts".into(),
        job.shifts.to_string(),
        "-o".into(),
        output.to_string_lossy().into_owned(),
    ];
    match job.format.as_str() {
        "int24" => args.push("--int24".into()),
        "float32" => args.push("--float32".into()),
        "mp3" => args.push("--mp3".into()),
        _ => unreachable!(),
    }
    if job.two_stems {
        args.extend(["--two-stems".into(), "vocals".into()]);
    }
    args.push(job.input);
    let mut cmd = Command::new(&job.python);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start Demucs: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *guard = Some(child);
    drop(guard);
    let shared = state.child.clone();
    thread::spawn(move || {
        emit(&app, "status", "Separation started", Some(0.0));
        let app_err = app.clone();
        let err_thread = thread::spawn(move || {
            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr);
                let mut bytes = Vec::new();
                loop {
                    bytes.clear();
                    match reader.read_until(b'\r', &mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            for segment in bytes.split(|b| *b == b'\n') {
                                let line = String::from_utf8_lossy(segment).trim().to_string();
                                if line.is_empty() {
                                    continue;
                                }
                                emit(&app_err, "log", line, None);
                            }
                        }
                    }
                }
            }
        });
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(event) = line
                    .strip_prefix("STEMIX_EVENT ")
                    .and_then(|json| serde_json::from_str::<JobEvent>(json).ok())
                    .filter(|event| {
                        event.kind == "progress"
                            && event.progress.is_none_or(|value| {
                                value.is_finite() && (0.0..=99.0).contains(&value)
                            })
                    })
                {
                    emit(&app, "progress", event.message, event.progress);
                } else {
                    emit(&app, "log", line, None);
                }
            }
        }
        let _ = err_thread.join();
        let mut guard = shared.lock().unwrap();
        let status = guard.as_mut().and_then(|child| child.wait().ok());
        *guard = None;
        drop(guard);
        match status {
            Some(s) if s.success() => {
                completion_beep();
                emit(&app, "done", "Separation complete", Some(100.0));
            }
            Some(s) => emit(&app, "error", format!("Demucs exited with {s}"), None),
            None => emit(
                &app,
                "error",
                "Process ended unexpectedly or was cancelled",
                None,
            ),
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_job(state: State<'_, ProcessState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|_| "Process lock error")?;
    if let Some(child) = guard.as_mut() {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_output(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.is_dir() {
        return Err("Output directory not found".into());
    }
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessState::default())
        .invoke_handler(tauri::generate_handler![
            default_python,
            start_job,
            cancel_job,
            open_output
        ])
        .run(tauri::generate_context!())
        .expect("error running Stemix");
}

#[cfg(test)]
mod tests {
    use super::output_directory;
    use std::path::Path;

    #[test]
    fn each_music_project_keeps_its_own_output() {
        let base = std::env::temp_dir().join("Stemix test projects");
        for project in ["kflay", "Another project"] {
            let folder = base.join(project);
            assert_eq!(
                output_directory(&folder.join("track.wav"), "").unwrap(),
                folder.join("stems")
            );
        }
    }

    #[test]
    fn explicit_output_overrides_the_source_folder() {
        let base = std::env::temp_dir();
        let selected = base.join("Selected output");
        assert_eq!(
            output_directory(&base.join("project/track.wav"), &selected.to_string_lossy()).unwrap(),
            selected
        );
    }

    #[test]
    fn relative_output_does_not_depend_on_the_working_directory() {
        assert!(output_directory(Path::new("track.wav"), "").is_err());
        assert!(
            output_directory(&std::env::temp_dir().join("track.wav"), "relative-output").is_err()
        );
    }
}
