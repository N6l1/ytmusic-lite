/* =============================================================================
 * YTMusic Lite — EDITABLE CONFIG
 * -----------------------------------------------------------------------------
 * This is the ONE file to edit when YouTube Music changes its page structure
 * and something stops working (see README "What can break"). After editing,
 * rebuild with `npm run tauri build` (the file is embedded at compile time).
 *
 * Everything below is attached to window.YTM_CFG and read by inject.js.
 * ===========================================================================*/
window.YTM_CFG = {
  /* ---- DOM selectors ------------------------------------------------------
   * Each entry is a LIST of candidate selectors, tried in order, so we can
   * survive small markup changes by listing a few fallbacks. */
  selectors: {
    // Player-bar transport buttons (bottom of the window).
    playPause: [
      'ytmusic-player-bar #play-pause-button',
      'ytmusic-player-bar .play-pause-button',
      '#play-pause-button',
      'tp-yt-paper-icon-button.play-pause-button',
    ],
    next: [
      'ytmusic-player-bar .next-button',
      'ytmusic-player-bar tp-yt-paper-icon-button.next-button',
      '.next-button',
    ],
    prev: [
      'ytmusic-player-bar .previous-button',
      'ytmusic-player-bar tp-yt-paper-icon-button.previous-button',
      '.previous-button',
    ],

    // The "Song / Video" switch shown on the now-playing screen. Clicking the
    // "Song" tab makes YT Music stream audio only (no video download).
    songTab: [
      'ytmusic-player-page #tabsContent .tab-header[tab-id="SONG"]',
      'ytmusic-player-page tp-yt-paper-tab[aria-label="Song"]',
      'tp-yt-paper-tab[tab-id="SONG"]',
      '.song-video-toggle [aria-label="Song"]',
    ],

    // The <video> element that carries the audio (and, if not audio-only, the
    // video). We hide it via CSS but never pause it, so audio keeps playing.
    videoEl: ['ytmusic-player video', 'video.html5-main-video', 'video'],
  },

  /* ---- Network blocking ---------------------------------------------------
   * Requests whose hostname equals one of these (or is a subdomain) are
   * answered with an empty 204 before they ever hit the network. These are
   * ads / telemetry / logging endpoints — NOT anything needed for playback. */
  blockHosts: [
    // Third-party ad + analytics domains ONLY. Do NOT add first-party Google/
    // YouTube hosts here: several of them (e.g. jnn-pa.googleapis.com, which
    // issues the attestation/"po_token" now REQUIRED to serve audio) will break
    // playback if blocked. If you add hosts, verify a song still plays.
    'doubleclick.net',
    'googleadservices.com',
    'googlesyndication.com',
    'pagead2.googlesyndication.com',
    'static.doubleclick.net',
    'ad.doubleclick.net',
    'google-analytics.com',
    'googletagmanager.com',
    'googletagservices.com',
  ],

  /* Path fragments (matched anywhere in the URL) that are also blocked. Kept
   * deliberately narrow — only ad/tracking paths, nothing the player relies on. */
  blockPaths: [
    '/pagead/',
    '/ptracking',
  ],

  /* ---- Video-stream blocking (only while audio-only mode is ON) -----------
   * We only ever block segments whose mime starts with "video". Audio segments
   * are always allowed, so playback is never harmed. */
  blockVideoStreams: false, // OFF by default: audio-only "Song" mode already
                            // stops video downloads. Blocking video segments
                            // outright can stall the player on music videos, so
                            // we don't. Flip to true only if you've confirmed
                            // playback still works for you.

  /* ---- Thumbnail / cover-art downscaling ----------------------------------
   * Google image URLs carry the requested size in the path (e.g. =w544-h544).
   * We rewrite any request larger than maxThumbPx down to maxThumbPx, which
   * dramatically cuts image bytes and decode cost. Set to 0 to disable. */
  maxThumbPx: 128,

  /* ---- Audio quality ------------------------------------------------------
   * Best-effort: on first run, try to set account audio quality to "Low".
   * YT Music's quality UI is account-level and moves around, so this is a
   * hook you may need to point at the right control (see setLowQuality in
   * inject.js). Once done we remember it in localStorage and never retry. */
  forceLowQuality: true,
  lowQualityLabelRegex: '^(low|niedrig|bajo|basse|低)', // matched case-insensitively

  /* ---- Behavior toggles ---------------------------------------------------*/
  audioOnlyByDefault: true, // click the "Song" tab automatically
  disableAnimations: true, // inject CSS that kills all animation/transition
  hideVideoElement: true, // CSS-hide the <video> to save compositing/GPU
  throttleWhenHidden: true, // slow our own timers when the window is hidden

  /* ---- Discord Rich Presence --------------------------------------------
   * Shows "Listening to YouTube Music" + the current song in your Discord
   * activity (like Spotify). Requires a Discord Application ID set in
   * src-tauri/src/lib.rs (DISCORD_CLIENT_ID) and the Discord desktop app
   * running. These selectors read the now-playing track from the player bar. */
  discord: {
    enabled: true,
    title: [
      'ytmusic-player-bar .title.ytmusic-player-bar',
      'ytmusic-player-bar .title',
      'ytmusic-player-bar yt-formatted-string.title',
    ],
    artist: [
      'ytmusic-player-bar .byline.ytmusic-player-bar',
      'ytmusic-player-bar .byline',
      'ytmusic-player-bar yt-formatted-string.byline',
    ],
    art: [
      'ytmusic-player-bar img.image',
      'ytmusic-player-bar .thumbnail img',
      'ytmusic-player-bar #thumbnail img',
    ],
  },

  /* localStorage keys used to remember one-time actions across launches. */
  storageKeys: {
    qualitySet: 'ytmLite.lowQualitySet.v1',
  },

  debug: false, // set true to see [ytm-lite] logs in DevTools console
};
