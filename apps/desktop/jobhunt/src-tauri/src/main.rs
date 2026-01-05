#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct EngineState {
  child: Mutex<Option<CommandChild>>,
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(EngineState {
      child: Mutex::new(None),
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
      tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
          match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
              print!("[engine stdout] {}", String::from_utf8_lossy(&bytes));
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(bytes) => {
              eprint!("[engine stderr] {}", String::from_utf8_lossy(&bytes));
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
        if let Some(child) = window
          .app_handle()
          .state::<EngineState>()
          .child
          .lock()
          .unwrap()
          .take()
        {
          let _ = child.kill();
          println!("[engine] killed");
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri app");

    
}




