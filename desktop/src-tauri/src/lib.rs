use serde::Deserialize;
use std::{
    sync::{Arc, RwLock},
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State, WebviewWindow,
};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InteractiveRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl InteractiveRegion {
    fn is_valid(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
    }

    fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

#[derive(Clone, Default)]
struct InteractiveRegionState(Arc<RwLock<Vec<InteractiveRegion>>>);

fn should_ignore_cursor(regions: &[InteractiveRegion], x: f64, y: f64) -> bool {
    !regions.is_empty() && !regions.iter().any(|region| region.contains(x, y))
}

const CREDENTIAL_SERVICE: &str = "com.kolvid.danmaku-overlay";

fn valid_credential_key(key: &str) -> bool {
    key == "client-id"
        || key
            .strip_prefix("room-owner:")
            .is_some_and(|code| code.len() == 8 && code.chars().all(|ch| ch.is_ascii_digit()))
}

fn credential_entry(key: &str) -> Result<keyring::Entry, String> {
    if !valid_credential_key(key) {
        return Err("不允許的安全儲存鍵".into());
    }
    keyring::Entry::new(CREDENTIAL_SERVICE, key).map_err(|_| "無法開啟系統安全儲存".into())
}

/// Secrets stay in the operating-system credential vault and never enter web storage.
#[tauri::command]
fn credential_set(key: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 {
        return Err("安全資料長度不正確".into());
    }
    credential_entry(&key)?
        .set_password(&value)
        .map_err(|_| "無法寫入系統安全儲存".into())
}

#[tauri::command]
fn credential_get(key: String) -> Result<Option<String>, String> {
    match credential_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("無法讀取系統安全儲存".into()),
    }
}

#[tauri::command]
fn credential_delete(key: String) -> Result<(), String> {
    match credential_entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("無法刪除系統安全資料".into()),
    }
}

#[tauri::command]
fn set_interactive_regions(
    state: State<'_, InteractiveRegionState>,
    regions: Vec<InteractiveRegion>,
) -> Result<(), String> {
    let valid_regions = regions
        .into_iter()
        .filter(|region| region.is_valid())
        .collect();
    *state.0.write().map_err(|_| "互動區域狀態鎖定失敗")? = valid_regions;
    Ok(())
}

/// Poll the global cursor through Tauri itself. This remains active while the
/// overlay ignores pointer events, unlike WebView mouseenter/mouseleave.
fn monitor_cursor_regions(window: WebviewWindow, state: InteractiveRegionState) {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        // Tao cannot query the global cursor on Wayland. Keep the window
        // interactive rather than risking an overlay the user can never click.
        return;
    }

    thread::spawn(move || {
        let mut last_ignore = None;
        loop {
            let cursor = match window.cursor_position() {
                Ok(position) => position,
                Err(_) => {
                    let _ = window.set_ignore_cursor_events(false);
                    last_ignore = Some(false);
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            let origin = match window.inner_position() {
                Ok(position) => position,
                Err(_) => {
                    let _ = window.set_ignore_cursor_events(false);
                    last_ignore = Some(false);
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            let scale = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
            let client_x = (cursor.x - f64::from(origin.x)) / scale;
            let client_y = (cursor.y - f64::from(origin.y)) / scale;
            let ignore = state
                .0
                .read()
                .map(|regions| should_ignore_cursor(&regions, client_x, client_y))
                .unwrap_or(false);

            if last_ignore != Some(ignore) {
                if window.set_ignore_cursor_events(ignore).is_err() {
                    break;
                }
                last_ignore = Some(ignore);
            }
            thread::sleep(Duration::from_millis(16));
        }
    });
}

/// Reset the floating ball position to default (top-right corner)
#[tauri::command]
fn reset_ball_position(window: WebviewWindow) -> Result<(), String> {
    window
        .emit("reset-ball-position", ())
        .map_err(|e| e.to_string())
}

/// Toggle danmaku visibility (from system tray)
#[tauri::command]
fn toggle_danmaku(window: WebviewWindow) -> Result<(), String> {
    window.emit("toggle-danmaku", ()).map_err(|e| e.to_string())
}

/// Show the overlay window
#[tauri::command]
fn show_overlay(window: WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

/// Quit the application
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(InteractiveRegionState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Some(window) = app.get_webview_window("overlay") {
                let state = app.state::<InteractiveRegionState>().inner().clone();
                monitor_cursor_regions(window, state);
            }

            // System tray
            let toggle_item =
                MenuItem::with_id(app, "toggle", "顯示/隱藏彈幕", true, None::<&str>)?;
            let reset_item = MenuItem::with_id(app, "reset", "重置懸浮球位置", true, None::<&str>)?;
            let defaults_item =
                MenuItem::with_id(app, "defaults", "恢復預設設定", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[&toggle_item, &reset_item, &defaults_item, &quit_item],
            )?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("彈幕 Overlay")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => {
                        if let Some(window) = app.get_webview_window("overlay") {
                            let _ = window.emit("toggle-danmaku", ());
                        }
                    }
                    "reset" => {
                        if let Some(window) = app.get_webview_window("overlay") {
                            let _ = window.emit("reset-ball-position", ());
                        }
                    }
                    "defaults" => {
                        if let Some(window) = app.get_webview_window("overlay") {
                            let _ = window.emit("reset-settings", ());
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_interactive_regions,
            credential_set,
            credential_get,
            credential_delete,
            reset_ball_position,
            toggle_danmaku,
            show_overlay,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{should_ignore_cursor, valid_credential_key, InteractiveRegion};

    #[test]
    fn secure_storage_only_accepts_client_and_room_owner_keys() {
        assert!(valid_credential_key("client-id"));
        assert!(valid_credential_key("room-owner:12345678"));
        assert!(!valid_credential_key("room-owner:AB12CD34"));
        assert!(!valid_credential_key("room-owner:short"));
        assert!(!valid_credential_key("../../secret"));
    }

    #[test]
    fn interactive_region_contains_edges_but_not_outside_points() {
        let region = InteractiveRegion {
            x: 10.0,
            y: 20.0,
            width: 30.0,
            height: 40.0,
        };
        assert!(region.contains(10.0, 20.0));
        assert!(region.contains(40.0, 60.0));
        assert!(!region.contains(40.1, 60.0));
        assert!(!region.contains(40.0, 60.1));
    }

    #[test]
    fn interactive_region_rejects_non_finite_or_empty_values() {
        let empty = InteractiveRegion {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 1.0,
        };
        let infinite = InteractiveRegion {
            x: f64::INFINITY,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        assert!(!empty.is_valid());
        assert!(!infinite.is_valid());
    }

    #[test]
    fn empty_region_state_fails_open_instead_of_locking_the_window() {
        assert!(!should_ignore_cursor(&[], 500.0, 500.0));
    }

    #[test]
    fn cursor_is_ignored_only_outside_reported_regions() {
        let regions = [InteractiveRegion {
            x: 10.0,
            y: 20.0,
            width: 30.0,
            height: 40.0,
        }];
        assert!(!should_ignore_cursor(&regions, 20.0, 30.0));
        assert!(should_ignore_cursor(&regions, 100.0, 100.0));
    }
}
