//! YTMusic Lite — a minimal Tauri v2 wrapper around music.youtube.com.
//!
//! Everything YouTube-Music-specific (selectors, blocked hosts, injected CSS)
//! lives in `injected/config.js`. The Rust side only:
//!   * opens ONE window pointed straight at music.youtube.com,
//!   * injects our config + logic scripts before the page loads,
//!   * enforces single-instance, tray, media keys and window-state.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_window_state::{StateFlags, WindowExt};

const WINDOW_LABEL: &str = "main";
const HOME_URL: &str = "https://music.youtube.com";

// Discord Rich Presence ("Listening to YouTube Music" in your Discord activity).
// The Application ID is NOT hardcoded — each user enters their own in the in-app
// Settings panel (gear icon). It's saved in the page's localStorage and rides
// along in every presence event, so the app ships with the feature dormant until
// an ID is set. See README section "Discord Rich Presence".

// The two injected scripts are embedded at compile time. Edit the files in
// `injected/` and rebuild to change behavior or fix selectors.
const CONFIG_JS: &str = include_str!("../injected/config.js");
const INJECT_JS: &str = include_str!("../injected/inject.js");

/// Run a small snippet against the page (used by the tray + media keys).
fn control(app: &tauri::AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.eval(js);
    }
}

/// Bring the main window back to the foreground.
fn focus_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Holds the live Discord IPC connection plus the currently-configured
/// Application ID (set by the user in the Settings panel, carried in events).
#[derive(Default)]
struct Discord {
    client: Mutex<Option<DiscordIpcClient>>,
    client_id: Mutex<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lightweight diagnostic log (temp\ytmlite-rpc.log). Helps trace the Discord
/// pipeline without DevTools in a release build.
fn dlog(msg: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("ytmlite-rpc.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {}", now_ms(), msg);
    }
}

/// Payload emitted by the injected page script on the `ytmlite://presence` event.
#[derive(serde::Deserialize)]
struct PresencePayload {
    playing: bool,
    title: String,
    artist: String,
    art: Option<String>,
    position: Option<f64>,
    duration: Option<f64>,
    #[serde(rename = "clientId", default)]
    client_id: String,
}

/// Discord requires each presence string to be 2..=128 chars. Clamp/pad safely.
fn fit(s: &str) -> String {
    let t = s.trim();
    let mut out: String = if t.is_empty() { "—".to_string() } else { t.to_string() };
    if out.chars().count() < 2 {
        out.push(' ');
    }
    if out.chars().count() > 128 {
        out = out.chars().take(128).collect();
    }
    out
}

/// Publishes a Spotify-style "Listening to …" activity to the local Discord app.
/// Driven by the `ytmlite://presence` event emitted from the page.
fn set_presence(app: &tauri::AppHandle, p: PresencePayload) {
    let client_id = p.client_id.trim().to_string();
    dlog(&format!(
        "presence playing={} title={:?} id={}chars",
        p.playing,
        p.title,
        client_id.len()
    ));
    let discord = app.state::<Discord>();

    // If the configured Application ID changed (or was cleared), drop any
    // existing connection so we reconnect with the new one.
    {
        let mut cur = discord.client_id.lock().unwrap();
        if *cur != client_id {
            *cur = client_id.clone();
            *discord.client.lock().unwrap() = None;
        }
    }
    if client_id.is_empty() {
        *discord.client.lock().unwrap() = None;
        return; // no Application ID set yet — feature dormant
    }

    let mut guard = discord.client.lock().unwrap();
    // (Re)establish the IPC connection if needed. If Discord isn't running this
    // just fails quietly and we retry on the next update.
    if guard.is_none() {
        match DiscordIpcClient::new(&client_id) {
            Ok(mut c) => match c.connect() {
                Ok(_) => {
                    dlog("discord connected");
                    *guard = Some(c);
                }
                Err(e) => dlog(&format!("discord connect FAILED: {e}")),
            },
            Err(e) => dlog(&format!("discord client new FAILED: {e}")),
        }
    }
    let client = match guard.as_mut() {
        Some(c) => c,
        None => return,
    };

    let details = fit(&p.title);
    let state = fit(&p.artist);
    let art_url = p.art.filter(|u| u.starts_with("http"));
    let has_time = p.playing
        && p.duration.map(|d| d > 0.0).unwrap_or(false)
        && p.position.map(|q| q >= 0.0).unwrap_or(false);
    let (start, end) = if has_time {
        let s = now_ms() - (p.position.unwrap() * 1000.0) as i64;
        (s, s + (p.duration.unwrap() * 1000.0) as i64)
    } else {
        (0, 0)
    };

    // Build the activity. Strings must outlive the Activity (it borrows them),
    // so everything is kept in scope here. Build a fresh one per send attempt
    // because Activity borrows and set_activity consumes it.
    let build = || {
        let mut act = Activity::new()
            .activity_type(ActivityType::Listening)
            .details(&details)
            .state(&state);
        if let Some(url) = art_url.as_deref() {
            act = act.assets(Assets::new().large_image(url).large_text("YouTube Music"));
        }
        if has_time {
            act = act.timestamps(Timestamps::new().start(start).end(end));
        }
        act
    };

    match client.set_activity(build()) {
        Ok(_) => dlog("set_activity OK"),
        Err(e) => {
            dlog(&format!("set_activity err: {e}; reconnecting"));
            // Pipe likely died (Discord restarted). Reconnect once and retry.
            if client.reconnect().is_ok() {
                let _ = client.set_activity(build());
            } else {
                *guard = None;
            }
        }
    }
}

/// Clears the Discord activity (nothing playing, or app closing).
fn clear_presence(app: &tauri::AppHandle) {
    let discord = app.state::<Discord>();
    let mut guard = discord.client.lock().unwrap();
    if let Some(client) = guard.as_mut() {
        let _ = client.clear_activity();
    }
}

pub fn run() {
    // Media-key shortcuts. Built once so the handler can compare against them.
    let sc_playpause = Shortcut::new(None, Code::MediaPlayPause);
    let sc_next = Shortcut::new(None, Code::MediaTrackNext);
    let sc_prev = Shortcut::new(None, Code::MediaTrackPrevious);
    let sc_stop = Shortcut::new(None, Code::MediaStop);
    let (h_pp, h_next, h_prev, h_stop) = (
        sc_playpause.clone(),
        sc_next.clone(),
        sc_prev.clone(),
        sc_stop.clone(),
    );

    tauri::Builder::default()
        // Single instance MUST be registered first: a second launch calls this
        // callback in the already-running process and then exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let js = if shortcut == &h_pp || shortcut == &h_stop {
                        "window.__ytmLite && window.__ytmLite.playPause()"
                    } else if shortcut == &h_next {
                        "window.__ytmLite && window.__ytmLite.next()"
                    } else if shortcut == &h_prev {
                        "window.__ytmLite && window.__ytmLite.prev()"
                    } else {
                        return;
                    };
                    control(app, js);
                })
                .build(),
        )
        .manage(Discord::default())
        .setup(move |app| {
            // ---- Discord Rich Presence: listen for now-playing events from the
            // page. Custom commands can't be granted to a remote origin's ACL, but
            // the core event system can — so the injected script emits events. ----
            let h_pres = app.handle().clone();
            app.listen_any("ytmlite://presence", move |event| {
                match serde_json::from_str::<PresencePayload>(event.payload()) {
                    Ok(p) => set_presence(&h_pres, p),
                    Err(e) => dlog(&format!("bad presence payload: {e}")),
                }
            });
            let h_clear = app.handle().clone();
            app.listen_any("ytmlite://clear", move |_| clear_presence(&h_clear));

            // Pin the WebView2 profile (cookies, localStorage — i.e. your signed-in
            // Google session) to a fixed folder instead of relying on Tauri's default
            // derivation. This guarantees the login survives Tauri upgrades, identifier
            // tweaks, or moving the exe. It resolves to the SAME path Tauri already used
            // (%LOCALAPPDATA%\com.ytmlite.app), so existing sign-ins are preserved.
            let data_dir = app
                .path()
                .app_local_data_dir()
                .expect("resolve app local data dir");

            // ---- Main window: load YT Music directly, inject our scripts ----
            let win = WebviewWindowBuilder::new(
                app,
                WINDOW_LABEL,
                WebviewUrl::External(HOME_URL.parse().expect("valid url")),
            )
            .title("YTMusic Lite")
            .inner_size(1000.0, 720.0)
            .min_inner_size(480.0, 320.0)
            .data_directory(data_dir)
            .initialization_script(CONFIG_JS)
            .initialization_script(INJECT_JS)
            .build()?;

            // Restore the last saved size/position (no-op on first launch).
            let _ = win.restore_state(StateFlags::all());

            // Close button hides to tray instead of quitting.
            let win_evt = win.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win_evt.hide();
                }
            });

            // ---- System tray with transport controls ----
            let handle = app.handle();
            let i_play = MenuItem::with_id(handle, "play_pause", "Play / Pause", true, None::<&str>)?;
            let i_next = MenuItem::with_id(handle, "next", "Next", true, None::<&str>)?;
            let i_prev = MenuItem::with_id(handle, "prev", "Previous", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(handle)?;
            let i_show = MenuItem::with_id(handle, "show", "Show / Hide window", true, None::<&str>)?;
            let i_quit = MenuItem::with_id(handle, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                handle,
                &[&i_play, &i_next, &i_prev, &sep, &i_show, &i_quit],
            )?;

            let mut tray = TrayIconBuilder::with_id("tray")
                .tooltip("YTMusic Lite")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "play_pause" => control(app, "window.__ytmLite && window.__ytmLite.playPause()"),
                    "next" => control(app, "window.__ytmLite && window.__ytmLite.next()"),
                    "prev" => control(app, "window.__ytmLite && window.__ytmLite.prev()"),
                    "show" => {
                        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                focus_window(app);
                            }
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        focus_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            let _tray = tray.build(handle)?;

            // ---- Register Windows media keys ----
            app.global_shortcut().register_multiple(vec![
                sc_playpause.clone(),
                sc_next.clone(),
                sc_prev.clone(),
                sc_stop.clone(),
            ])?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running YTMusic Lite");
}
