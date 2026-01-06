#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// If you're on Rust 1.70+ you can use OnceLock instead, but Mutex<Option<..>> is fine.
#[derive(Default)]
struct EngineInfo {
  port: Option<u16>,
  shutdown_token: Option<String>,
}

struct EngineState {
  child: Mutex<Option<CommandChild>>,
  info: Mutex<EngineInfo>,
}

fn parse_port_from_line(line: &str) -> Option<u16> {
  // Expected log: "engine listening on http://127.0.0.1:38471 ..."
  let needle = "http://127.0.0.1:";
  let idx = line.find(needle)? + needle.len();
  let rest = &line[idx..];
  let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
  if digits.is_empty() { return None; }
  digits.parse::<u16>().ok()
}

fn parse_shutdown_token_from_line(line: &str) -> Option<String> {
  // Expected log: "shutdown_token=...."
  let needle = "shutdown_token=";
  let idx = line.find(needle)? + needle.len();
  Some(line[idx..].trim().to_string())
}

async fn request_engine_shutdown(port: u16, token: &str) -> Result<(), String> {
  // reqwest is the easiest; add it to Cargo.toml (see below).
  let url = format!("http://127.0.0.1:{}/shutdown", port);

  let client = reqwest::Client::new();
  let resp = client
    .post(url)
    .header("X-Shutdown-Token", token)
    .send()
    .await
    .map_err(|e| e.to_string())?;

  if resp.status().is_success() {
    Ok(())
  } else {
    Err(format!("shutdown returned HTTP {}", resp.status()))
  }
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(EngineState {
      child: Mutex::new(None),
      info: Mutex::new(EngineInfo::default()),
    })
    .setup(|app| {
      let data_dir = app.path().app_data_dir().unwrap();
      std::fs::create_dir_all(&data_dir).unwrap();

      let mut cmd = app
        .shell()
        .sidecar("engine")
        .expect("failed to create sidecar");

      cmd = cmd
        .current_dir(&data_dir)
        .env("JOBHUNT_DATA_DIR", data_dir.to_string_lossy().to_string());

      let (mut rx, child) = cmd.spawn().expect("failed to spawn engine");

      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
          match event {
            CommandEvent::Stdout(bytes) => {
              let s = String::from_utf8_lossy(&bytes).to_string();
              print!("[engine stdout] {}", s);

              // Parse port/token from stdout
              if let Some(port) = parse_port_from_line(&s) {
                let state = app_handle.state::<EngineState>();
                let mut info = state.info.lock().unwrap();
                info.port = Some(port);
              }
              if let Some(tok) = parse_shutdown_token_from_line(&s) {
                let state = app_handle.state::<EngineState>();
                let mut info = state.info.lock().unwrap();
                info.shutdown_token = Some(tok);
              }
            }
            CommandEvent::Stderr(bytes) => {
              let s = String::from_utf8_lossy(&bytes).to_string();
              eprint!("[engine stderr] {}", s);

              // Sometimes logs go to stderr, so parse here too
              if let Some(port) = parse_port_from_line(&s) {
                let state = app_handle.state::<EngineState>();
                let mut info = state.info.lock().unwrap();
                info.port = Some(port);
              }
              if let Some(tok) = parse_shutdown_token_from_line(&s) {
                let state = app_handle.state::<EngineState>();
                let mut info = state.info.lock().unwrap();
                info.shutdown_token = Some(tok);
              }
            }
            other => {
              println!("[engine] {:?}", other);
            }
          }
        }
      });

      app.state::<EngineState>().child.lock().unwrap().replace(child);

      println!("[engine] started");
      Ok(())
    })
    .on_window_event(|window, event| {
      if matches!(event, tauri::WindowEvent::Destroyed) {
        let app = window.app_handle();

        // Grab child + info while we're still on this thread
        let child_opt = app.state::<EngineState>().child.lock().unwrap().take();
        let state = app.state::<EngineState>();
        let info = state.info.lock().unwrap();
        let port = info.port;
        let token = info.shutdown_token.clone();
        drop(info);

        if let Some(child) = child_opt {
          // Attempt graceful shutdown first
          tauri::async_runtime::spawn(async move {
            let mut graceful_ok = false;

            if let (Some(p), Some(t)) = (port, token.as_deref()) {
              match request_engine_shutdown(p, t).await {
                Ok(_) => {
                  println!("[engine] shutdown requested");
                  graceful_ok = true;
                }
                Err(e) => {
                  eprintln!("[engine] shutdown request failed: {}", e);
                }
              }
            } else {
              eprintln!("[engine] shutdown info missing (port/token), falling back to kill");
            }

            // Give it a moment to exit cleanly, then fall back to kill
            // (no need for anything fancy here)
            if !graceful_ok {
              let _ = child.kill();
              println!("[engine] killed");
            }
          });
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri app");
}




