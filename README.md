# YTMusic Lite

A super-lightweight **YouTube Music** desktop player for Windows, built with
**Tauri v2** (Rust + the system's built-in **WebView2**). No Electron, no bundled
Chromium — it reuses the Edge WebView2 runtime that ships with Windows, so idle
RAM is typically well under ~100 MB.

It opens a single window pointed straight at `https://music.youtube.com` and
makes it lean:

| Goal | How |
|------|-----|
| Audio only, no video download | Auto-selects the **"Song"** tab + blocks `mime=video` media segments while audio-only is on |
| No ads / telemetry | `fetch` / `XMLHttpRequest` / `sendBeacon` to known ad & logging hosts are short-circuited (204) before hitting the network |
| Small cover art | Google image URLs are rewritten down to 128 px (`=w544-h544` → `=w128-h128`) |
| No animation cost | Injected CSS zeroes every animation/transition and removes the GPU-heavy "ambient" background |
| Idle when hidden | Chromium auto-throttles background timers when minimized; we floor our own timers to 1 s too. Audio keeps playing (it uses no JS timers) |
| Low audio quality | Best-effort auto-select of **Low** (account setting; see notes) |
| Single instance | 2nd launch just focuses the running window |
| Tray + media keys | Tray menu Play/Pause/Next/Prev + Windows media keys |
| Remembers window | Size/position restored between launches |

---

## Install (Windows — no building required)

Just want to use it? You don't need any of the developer tools below.

1. Go to the [**Releases**](../../releases/latest) page.
2. Download **`YTMusic Lite_0.1.0_x64-setup.exe`**.
3. Run it. Windows SmartScreen may warn that it's from an unknown publisher
   (the app isn't code-signed) — click **More info → Run anyway**.
4. Launch **YTMusic Lite** from the Start menu or desktop, then sign into your
   Google account in the window and play something.

Your **sign-in is remembered** — once you log into Google, the session is stored
in the app's own WebView2 profile and restored on every launch, so you won't have
to log in again.

Requirements: 64-bit Windows 10/11. The **WebView2 runtime** is used for
rendering; it ships with Windows 11 and recent Windows 10, and if it's missing
the installer downloads it automatically. No Rust/Node needed to *run* the app —
those are only for building it yourself (below).

> Prefer no installer? The Releases page also has the portable
> `ytmusic-lite.exe` — just download and double-click it, no install.

---

## 1. Prerequisites (one-time, only to build from source)

This machine already has **Node.js** and the **WebView2 runtime**. You still need
the Rust toolchain and the MSVC C++ build tools to compile a Windows binary.

### a) Microsoft C++ Build Tools (the MSVC linker Rust needs)
Install "Desktop development with C++". Easiest via winget:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

(Or download "Build Tools for Visual Studio" and check **Desktop development with
C++**.) This is a multi-GB install and may need a reboot.

### b) Rust (via rustup)
```powershell
winget install --id Rustlang.Rustup -e
# then open a NEW terminal so PATH updates, and confirm:
rustc --version
cargo --version
```
rustup selects the `x86_64-pc-windows-msvc` toolchain by default, which is what we want.

### c) WebView2 runtime
Already present on this machine (Windows 11). Nothing to do. On machines that lack
it, the installer we build is configured to download it automatically on first run.

### d) Node dependencies (already installed here)
```powershell
cd C:\Users\saad\ytmusic-lite
npm install        # installs @tauri-apps/cli (Node-only, no Rust needed)
```

---

## 2. Run it (dev)

```powershell
cd C:\Users\saad\ytmusic-lite
npm run dev          # = tauri dev
```

The first `cargo` build downloads and compiles the Rust dependencies (a few
minutes, one time). After that, launches are fast. Sign in to your Google account
in the window like any browser, and play something.

## 3. Build the installer (.exe / .msi)

```powershell
cd C:\Users\saad\ytmusic-lite
npm run build        # = tauri build
```

Outputs land in `src-tauri\target\release\`:

| File | Path |
|------|------|
| Standalone exe | `src-tauri\target\release\YTMusic Lite.exe` |
| NSIS installer | `src-tauri\target\release\bundle\nsis\YTMusic Lite_0.1.0_x64-setup.exe` |
| MSI installer | `src-tauri\target\release\bundle\msi\YTMusic Lite_0.1.0_x64_en-US.msi` |

> The first `tauri build` downloads the WiX (MSI) and NSIS bundler tooling
> automatically. If you only want one format, edit `bundle.targets` in
> `src-tauri/tauri.conf.json` (e.g. `["nsis"]`).

### (Re)generating the app icon
The icon set in `src-tauri/icons/` is already generated. To change it, replace
`app-icon.png` (1024×1024) and run:
```powershell
npm run icon         # = tauri icon app-icon.png
```

---

## 4. Where the fragile bits live — **`src-tauri/injected/config.js`**

Everything that depends on YouTube Music's HTML is isolated in **one file**:
`src-tauri/injected/config.js`. It's the only place you should need to edit when
YT Music changes. `inject.js` next to it is the machinery and rarely needs
touching. Both are embedded into the binary at compile time, so **after editing
either file you must rebuild** (`npm run dev` / `npm run build`).

`config.js` holds: transport-button selectors, the Song/Video toggle selector,
blocked ad/telemetry hosts and path fragments, the max thumbnail size, the
low-quality label regex, and on/off toggles for each feature.

Turn on `debug: true` in `config.js` to see `[ytm-lite]` logs in DevTools
(right-click → Inspect works in a `tauri dev` build).

---

## 5. What can break (and how to fix it)

YouTube Music is a single-page app Google changes without notice. The **only**
parts coupled to its markup are the **CSS selectors** in `config.js`. Each setting
is a *list* of fallback selectors, tried in order, so a minor rename usually still
finds the element.

- **Play/Pause/Next/Prev do nothing** → the player-bar button selectors changed.
  In DevTools, inspect the bottom player bar, find the new button
  id/class, and update `selectors.playPause` / `next` / `prev`.
- **Video still downloads / audio-only not applied** → the "Song" tab selector
  changed. Inspect the Song/Video switch on the now-playing screen and update
  `selectors.songTab`. (Video media-segment blocking also depends on the URL
  still being `videoplayback?...&mime=video/...`; if Google changes that, adjust
  `isVideoSegment` in `inject.js`.)
- **Ads/telemetry reappear** → add the new hostname to `blockHosts` or a URL
  fragment to `blockPaths`. Watch the Network tab to spot them. (Blocking is
  conservative on purpose — it never touches audio segments or the core
  `youtubei` API, only ad/log endpoints.)
- **Cover art not shrinking** → Google changed its image URL scheme; update the
  `=w..-h..` / `=s..` regexes in `rewriteThumb` (in `inject.js`) and/or
  `maxThumbPx`.

### Two things that are **not** selector problems

- **Google may block sign-in in an embedded webview** ("This browser or app may
  not be secure"). WebView2 uses an Edge/Chromium user-agent so this usually
  works, but if Google ever blocks it, sign-in has to be done in a way Google
  trusts. This is a Google policy, not a selector bug.
- **Audio quality "Low" is an account setting stored server-side.** It only needs
  setting **once, ever** — it then follows your Google account on every device.
  The app makes a best-effort automatic pass (`config.forceLowQuality`) and
  remembers success in `localStorage` so it never nags. If YT Music doesn't
  surface the quality control where the script looks, just set
  **Settings → Audio quality → Low** manually one time; you're done. You can also
  run `window.__ytmLite.setLowQuality()` in DevTools to trigger the attempt.

---

## 6. Project layout

```
ytmusic-lite/
├── package.json               # Tauri CLI + npm scripts (dev/build/icon)
├── app-icon.png               # 1024px source for `tauri icon`
├── dist/index.html            # placeholder; the window loads YT Music directly
└── src-tauri/
    ├── Cargo.toml             # Rust deps + size-optimized release profile
    ├── tauri.conf.json        # app id, window, bundle targets, icons
    ├── capabilities/default.json
    ├── icons/                 # generated icon set (ico/png/icns)
    ├── injected/
    │   ├── config.js          # <-- EDIT THIS when YT Music changes
    │   └── inject.js          # injection machinery (network block, CSS, controls)
    └── src/
        ├── main.rs
        └── lib.rs             # window, tray, media keys, single-instance, state
```

---

## 7. Notes on how it stays light

- **No bundled browser.** Tauri uses the OS WebView2; the Rust binary itself is a
  few MB. Idle memory is dominated by the WebView2 process, kept small by
  audio-only mode (no video decode/compositing) and disabled animations.
- **Release profile** (`Cargo.toml`) builds with `opt-level="z"`, LTO,
  `panic="abort"` and symbol stripping for the smallest binary.
- **Close = hide to tray.** Quit fully from the tray menu ("Quit"). This keeps
  playback going with a minimal footprint when you're not looking at it.
