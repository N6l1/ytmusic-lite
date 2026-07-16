/* =============================================================================
 * YTMusic Lite — INJECTED LOGIC  (runs at document-start on every page load)
 * -----------------------------------------------------------------------------
 * Do NOT put selectors or tunables here — those live in config.js. This file is
 * the machinery that reads window.YTM_CFG and applies it.
 * ===========================================================================*/
(function () {
  'use strict';
  var CFG = window.YTM_CFG || {};
  var SEL = CFG.selectors || {};

  var state = { hidden: false };
  // Public control surface used by the Rust side (tray + media keys).
  window.__ytmLite = window.__ytmLite || {};
  window.__ytmLite.audioOnly = !!CFG.audioOnlyByDefault;

  function log() {
    if (CFG.debug) {
      try { console.log.apply(console, ['[ytm-lite]'].concat([].slice.call(arguments))); } catch (e) {}
    }
  }

  /* -------------------------------------------------------------------------
   * DOM helpers
   * ---------------------------------------------------------------------- */
  function pick(list) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      try {
        var el = document.querySelector(list[i]);
        if (el) return el;
      } catch (e) {}
    }
    return null;
  }
  function clickFirst(list) {
    var el = pick(list);
    if (el) { el.click(); return true; }
    return false;
  }

  /* -------------------------------------------------------------------------
   * 1. NETWORK BLOCKING  (fetch / XHR / sendBeacon)  +  thumbnail downscaling
   *    Installed before the page's own scripts run.
   * ---------------------------------------------------------------------- */
  var blockHosts = CFG.blockHosts || [];
  var blockPaths = CFG.blockPaths || [];

  function absUrl(u) {
    try { return new URL(u, location.href); } catch (e) { return null; }
  }
  function isBlocked(u) {
    var url = absUrl(u);
    if (!url) return false;
    var host = url.hostname;
    for (var i = 0; i < blockHosts.length; i++) {
      var b = blockHosts[i];
      // allow entries that include a path fragment (e.g. "youtube.com/pagead")
      if (b.indexOf('/') !== -1) { if ((host + url.pathname).indexOf(b) !== -1) return true; }
      else if (host === b || host.slice(-(b.length + 1)) === '.' + b) return true;
    }
    var full = url.pathname + url.search;
    for (var j = 0; j < blockPaths.length; j++) {
      if (full.indexOf(blockPaths[j]) !== -1) return true;
    }
    return false;
  }
  // Block video media segments ONLY when audio-only mode is on. Audio segments
  // (mime=audio/*) are always allowed so playback is never harmed.
  function isVideoSegment(u) {
    if (!CFG.blockVideoStreams || !window.__ytmLite.audioOnly) return false;
    var url = absUrl(u);
    if (!url) return false;
    if (url.pathname.indexOf('videoplayback') === -1) return false;
    var mime = url.searchParams.get('mime') || '';
    return mime.indexOf('video') === 0;
  }

  // Cover art / thumbnails: Google image URLs encode the size in the path,
  // e.g. "=w544-h544-l90-rj" or "=s1200". Cap them at CFG.maxThumbPx.
  var maxThumb = CFG.maxThumbPx || 0;
  function rewriteThumb(u) {
    if (!maxThumb || typeof u !== 'string') return u;
    if (u.indexOf('googleusercontent.com') === -1 && u.indexOf('ggpht.com') === -1) return u;
    return u
      .replace(/=w(\d+)-h(\d+)/g, function (m, w, h) {
        if (+w <= maxThumb && +h <= maxThumb) return m;
        return '=w' + maxThumb + '-h' + maxThumb;
      })
      .replace(/=s(\d+)/g, function (m, s) {
        return +s <= maxThumb ? m : '=s' + maxThumb;
      });
  }

  // --- fetch ---
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url);
        if (url) {
          if (isBlocked(url) || isVideoSegment(url)) {
            log('block fetch', url);
            return Promise.resolve(new Response(null, { status: 204, statusText: 'No Content' }));
          }
          var nu = rewriteThumb(url);
          if (nu !== url) {
            input = (typeof input === 'string') ? nu : new Request(nu, input);
          }
        }
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
  }

  // --- XMLHttpRequest ---
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url && (isBlocked(url) || isVideoSegment(url))) {
        log('block xhr', url);
        // Redirect to an empty data: URL so the request completes instantly.
        arguments[0] = 'GET';
        arguments[1] = 'data:text/plain,';
      } else if (url) {
        var nu = rewriteThumb(url);
        if (nu !== url) arguments[1] = nu;
      }
    } catch (e) {}
    return _open.apply(this, arguments);
  };

  // --- sendBeacon (analytics) ---
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try { if (isBlocked(url)) { log('block beacon', url); return true; } } catch (e) {}
      return _beacon(url, data);
    };
  }

  // --- <img>.src downscaling ---
  if (maxThumb) {
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (d && d.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true,
          enumerable: d.enumerable,
          get: d.get,
          set: function (v) { d.set.call(this, rewriteThumb(v)); },
        });
      }
    } catch (e) {}
  }

  /* -------------------------------------------------------------------------
   * 2. CSS INJECTION  (kill animations, hide ambient glow + video surface)
   * ---------------------------------------------------------------------- */
  function injectCSS() {
    if (document.getElementById('ytm-lite-style')) return;
    var css = '';
    if (CFG.disableAnimations) {
      css +=
        '*,*::before,*::after{' +
        'animation-duration:0s !important;animation-delay:0s !important;' +
        'transition-duration:0s !important;transition-delay:0s !important;' +
        'scroll-behavior:auto !important}';
    }
    // Ambient / immersive animated background is a big GPU cost — remove it.
    css +=
      '#ambient,#ambient-blur,.ambient-slider,ytmusic-player-page #ambient,' +
      'tp-yt-iron-image#ambient,.blur-background{display:none !important}';
    if (CFG.hideVideoElement) {
      // Keep the <video> in the DOM (player logic needs it) but stop painting it.
      css += 'ytmusic-player .html5-video-container,ytmusic-player video{opacity:0 !important}';
    }
    var style = document.createElement('style');
    style.id = 'ytm-lite-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  // documentElement exists at document-start; head arrives a moment later.
  injectCSS();
  document.addEventListener('DOMContentLoaded', injectCSS);

  /* -------------------------------------------------------------------------
   * 3. AUDIO-ONLY ("Song") MODE  — click the Song tab whenever it appears.
   * ---------------------------------------------------------------------- */
  function selectSong() {
    if (!window.__ytmLite.audioOnly) return;
    var el = pick(SEL.songTab);
    if (!el) return;
    var selected = el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('tab-selected') !== null ||
      /(^|\s)selected(\s|$)/.test(el.className);
    if (!selected) { log('select Song tab'); el.click(); }
  }

  /* -------------------------------------------------------------------------
   * 4. LOW AUDIO QUALITY  — best-effort, once, remembered forever.
   *    NOTE: YT Music audio quality is an ACCOUNT setting stored server-side,
   *    so it only ever needs setting once (it then follows your account on
   *    every device). We try to select "Low" in any quality control that is
   *    reachable in the current DOM; if YT Music doesn't surface one we log a
   *    hint and you set it manually in Settings once. See README.
   * ---------------------------------------------------------------------- */
  function alreadyLow() {
    try { return localStorage.getItem(CFG.storageKeys.qualitySet) === '1'; } catch (e) { return false; }
  }
  function markLow() {
    try { localStorage.setItem(CFG.storageKeys.qualitySet, '1'); } catch (e) {}
  }
  function setLowQuality(force) {
    if (!CFG.forceLowQuality) return false;
    if (!force && alreadyLow()) return false;
    var re = new RegExp(CFG.lowQualityLabelRegex || '^low', 'i');
    // Look through visible menu/radio items for one labelled "Low".
    var candidates = document.querySelectorAll(
      'tp-yt-paper-radio-button,[role="radio"],[role="menuitemradio"],' +
      'ytmusic-menu-service-item-renderer,tp-yt-paper-item,.item'
    );
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var label = (c.getAttribute('aria-label') || c.textContent || '').trim();
      if (label && re.test(label)) {
        log('set audio quality Low via', label);
        c.click();
        markLow();
        return true;
      }
    }
    log('quality control not found — set "Audio quality: Low" once in Settings (see README)');
    return false;
  }
  window.__ytmLite.setLowQuality = function () { return setLowQuality(true); };

  /* -------------------------------------------------------------------------
   * 5. TRANSPORT CONTROLS  (called by tray + media keys via Rust eval)
   * ---------------------------------------------------------------------- */
  window.__ytmLite.playPause = function () { return clickFirst(SEL.playPause); };
  window.__ytmLite.next = function () { return clickFirst(SEL.next); };
  window.__ytmLite.prev = function () { return clickFirst(SEL.prev); };
  window.__ytmLite.setAudioOnly = function (on) {
    window.__ytmLite.audioOnly = !!on;
    if (on) selectSong();
  };

  /* -------------------------------------------------------------------------
   * 5b. DISCORD RICH PRESENCE reporter
   *     Reads the now-playing track and pushes it to Rust (which talks to the
   *     Discord IPC pipe). We only send on real changes — track / play-state /
   *     seek — never per-second, to stay under Discord's rate limit.
   * ---------------------------------------------------------------------- */
  var DSC = CFG.discord || {};
  var dstate = { sig: '', timer: 0, videoHooked: null };

  function tauriInvoke(cmd, args) {
    try {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        return window.__TAURI__.core.invoke(cmd, args);
      }
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        return window.__TAURI_INTERNALS__.invoke(cmd, args);
      }
    } catch (e) {}
  }

  function textOf(list) {
    var el = pick(list);
    return el ? (el.getAttribute('title') || el.textContent || '').trim() : '';
  }

  function reportDiscord() {
    if (!DSC.enabled) return;
    var video = pick(SEL.videoEl);
    var title = textOf(DSC.title);
    if (!title) {
      // Nothing loaded — clear presence once.
      if (dstate.sig !== 'CLEARED') { dstate.sig = 'CLEARED'; tauriInvoke('clear_presence'); }
      return;
    }
    // Byline is "Artist • Album • Year" — keep the artist (first segment).
    var artist = textOf(DSC.artist).split('•')[0].trim();
    var art = '';
    var img = pick(DSC.art);
    if (img) art = img.currentSrc || img.src || '';
    var playing = !!(video && !video.paused && !video.ended);
    var position = video && isFinite(video.currentTime) ? video.currentTime : 0;
    var duration = video && isFinite(video.duration) ? video.duration : 0;

    // Signature omits position so ticking doesn't spam; play/seek events resend.
    var sig = [title, artist, playing ? 1 : 0].join('');
    if (sig === dstate.sig) return;
    dstate.sig = sig;
    tauriInvoke('update_presence', {
      playing: playing,
      title: title,
      artist: artist,
      art: art,
      position: position,
      duration: duration,
    });
  }

  function scheduleDiscord() {
    if (dstate.timer) return;
    dstate.timer = setTimeout(function () { dstate.timer = 0; reportDiscord(); }, 700);
  }

  // Attach video listeners so play/pause/seek/track-change push an update.
  function hookDiscordVideo() {
    if (!DSC.enabled) return;
    var video = pick(SEL.videoEl);
    if (!video || dstate.videoHooked === video) return;
    dstate.videoHooked = video;
    ['play', 'pause', 'ended', 'seeked', 'loadedmetadata'].forEach(function (ev) {
      video.addEventListener(ev, function () { dstate.sig = ''; scheduleDiscord(); });
    });
    scheduleDiscord();
  }
  window.__ytmLite.reportDiscord = reportDiscord; // manual trigger for debugging

  /* -------------------------------------------------------------------------
   * 6. TIMER THROTTLING WHEN HIDDEN
   *    Chromium already throttles background timers & pauses rAF when the doc
   *    is hidden (audio keeps playing natively). We add a belt-and-suspenders
   *    clamp: while hidden, newly created sub-second timers are floored to 1s.
   *    Audio playback uses no JS timers, so this is safe.
   * ---------------------------------------------------------------------- */
  if (CFG.throttleWhenHidden) {
    var _setInterval = window.setInterval;
    var _setTimeout = window.setTimeout;
    function clamp(delay) {
      if (state.hidden && (typeof delay !== 'number' || delay < 1000)) return 1000;
      return delay;
    }
    window.setInterval = function (fn, delay) {
      var a = [].slice.call(arguments); a[1] = clamp(delay);
      return _setInterval.apply(window, a);
    };
    window.setTimeout = function (fn, delay) {
      var a = [].slice.call(arguments); a[1] = clamp(delay);
      return _setTimeout.apply(window, a);
    };
    document.addEventListener('visibilitychange', function () {
      state.hidden = document.hidden;
      log('visibility', state.hidden ? 'hidden' : 'visible');
      if (!state.hidden) { injectCSS(); selectSong(); }
    });
  }

  /* -------------------------------------------------------------------------
   * 7. DRIVER — keep our tweaks applied as YT Music re-renders (SPA).
   *    A single MutationObserver + a bounded startup poll, then we idle.
   * ---------------------------------------------------------------------- */
  function apply() {
    injectCSS();
    selectSong();
    if (!alreadyLow()) setLowQuality(false);
    hookDiscordVideo();
    scheduleDiscord();
  }
  // Tidy up the Discord activity when the window/page goes away.
  window.addEventListener('beforeunload', function () { tauriInvoke('clear_presence'); });
  var mo = new MutationObserver(function () {
    // Debounced via rAF-ish micro throttle to avoid churn.
    if (mo._t) return;
    mo._t = _rafFallback(function () { mo._t = 0; apply(); });
  });
  function _rafFallback(cb) {
    return (window.requestAnimationFrame || function (f) { return setTimeout(f, 100); })(cb);
  }
  function start() {
    try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    apply();
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);

  log('YTMusic Lite injected');
})();
