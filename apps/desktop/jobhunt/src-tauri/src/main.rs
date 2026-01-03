#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager};

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      // If you want to spawn the sidecar immediately, do it here.
      // NOTE: In Tauri v2, it's usually best to call sidecars from JS via the shell plugin,
      // but you *can* trigger it here too if you prefer.

      // Example: just log that setup ran
      let _window = app.get_webview_window("main").unwrap();
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}


