#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct EngineInfo {
  port: Option<u16>,
  shutdown_token: Option<String>,
}

struct EngineState {
  child: Mutex<Option<CommandChild>>,
  info: Mutex<EngineInfo>,
  allow_close: Mutex<bool>,
}

fn parse_port_from_line(line: &str) -> Option<u16> {
  let needle = "http://127.0.0.1:";
  let idx = line.find(needle)? + needle.len();
  let rest = &line[idx..];
  let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
  if digits.is_empty() {
    return None;
  }
  digits.parse::<u16>().ok()
}

fn parse_shutdown_token_from_line(line: &str) -> Option<String> {
  let needle = "shutdown_token=";
  let idx = line.find(needle)? + needle.len();
  Some(line[idx..].trim().to_string())
}

async fn request_engine_shutdown(port: u16, token: &str) -> Result<(), String> {
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
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_shell::init())
    .manage(EngineState {
      child: Mutex::new(None),
      info: Mutex::new(EngineInfo::default()),
      allow_close: Mutex::new(false),
    })
    .setup(|app| {
      let data_dir = app.path().app_data_dir().expect("app_data_dir");
      std::fs::create_dir_all(&data_dir).expect("create data dir");

      let mut cmd = app
        .shell()
        .sidecar("engine")
        .expect("failed to create sidecar");

      cmd = cmd
        .current_dir(&data_dir)
        .env("JOBHUNT_DATA_DIR", data_dir.to_string_lossy().to_string());

      let (mut rx, child) = cmd.spawn().expect("failed to spawn engine");

      // store child
      app.state::<EngineState>()
        .child
        .lock()
        .unwrap()
        .replace(child);

      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
          match event {
            CommandEvent::Stdout(bytes) => {
              let s = String::from_utf8_lossy(&bytes).to_string();
              print!("[engine stdout] {}", s);

              let state = app_handle.state::<EngineState>();
              if let Some(port) = parse_port_from_line(&s) {
                state.info.lock().unwrap().port = Some(port);
              }
              if let Some(tok) = parse_shutdown_token_from_line(&s) {
                state.info.lock().unwrap().shutdown_token = Some(tok);
              }
            }
            CommandEvent::Stderr(bytes) => {
              let s = String::from_utf8_lossy(&bytes).to_string();
              eprint!("[engine stderr] {}", s);

              let state = app_handle.state::<EngineState>();
              if let Some(port) = parse_port_from_line(&s) {
                state.info.lock().unwrap().port = Some(port);
              }
              if let Some(tok) = parse_shutdown_token_from_line(&s) {
                state.info.lock().unwrap().shutdown_token = Some(tok);
              }
            }
            other => {
              println!("[engine] {:?}", other);
            }
          }
        }
      });

      println!("[engine] started");
      Ok(())
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        let app_handle = window.app_handle().clone();
        let label = window.label().to_string();

        // If we're already closing (programmatic close), don't block it again.
        {
          let state = app_handle.state::<EngineState>();
          let allow = state.allow_close.lock().unwrap();
          if *allow {
            return; // let Tauri close normally
          }
          api.prevent_close();
        }

        // Pull state data out synchronously
        let state = app_handle.state::<EngineState>();
        let child_opt = state.child.lock().unwrap().take();

        let (port, token) = {
          let info = state.info.lock().unwrap();
          (info.port, info.shutdown_token.clone())
        };

        tauri::async_runtime::spawn(async move {
          if let Some(child) = child_opt {
            let mut graceful_ok = false;

            if let (Some(p), Some(t)) = (port, token.as_deref()) {
              match request_engine_shutdown(p, t).await {
                Ok(_) => {
                  println!("[engine] shutdown requested");
                  graceful_ok = true;
                }
                Err(e) => eprintln!("[engine] shutdown request failed: {}", e),
              }
            }

            if !graceful_ok {
              let _ = child.kill();
              println!("[engine] killed");
            }
          }

          // Allow the next CloseRequested to proceed.
          {
            let state = app_handle.state::<EngineState>();
            *state.allow_close.lock().unwrap() = true;
          }

          // Close the same window that was requested.
          if let Some(w) = app_handle.get_webview_window(&label) {
            let _ = w.close();
          }
        });
      }
    })

    .run(tauri::generate_context!())
    .expect("error while running tauri app");
}
