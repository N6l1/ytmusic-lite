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
    var root = document.head || document.documentElement;
    if (!root) return; // document-start: no root yet — retried via observer/DCL
    var style = document.createElement('style');
    style.id = 'ytm-lite-style';
    style.textContent = css;
    root.appendChild(style);
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
  var STK = CFG.storageKeys || {};
  function sGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function sSet(k, v) { try { localStorage.setItem(k, v == null ? '' : v); } catch (e) {} }

  // Page -> Rust via the Tauri EVENT system. (Custom commands can't be granted
  // to a remote origin's ACL; core events can, so we use events.)
  function emit(event, payload) {
    try {
      if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit) {
        window.__TAURI__.event.emit(event, payload || {});
        return true;
      }
    } catch (e) {}
    return false;
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
      if (dstate.sig !== 'CLEARED') { dstate.sig = 'CLEARED'; emit('ytmlite://clear'); }
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
    emit('ytmlite://presence', {
      playing: playing,
      title: title,
      artist: artist,
      art: art,
      position: position,
      duration: duration,
      clientId: sGet(STK.discordClientId),
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
      video.addEventListener(ev, function () { dstate.sig = ''; scheduleDiscord(); applySink(); });
    });
    scheduleDiscord();
    applySink();
  }
  window.__ytmLite.reportDiscord = reportDiscord; // manual trigger for debugging

  /* -------------------------------------------------------------------------
   * 5c. SETTINGS PANEL — gear button + modal, injected as a fixed overlay so it
   *     never depends on YT Music's markup. Two settings:
   *       • Discord Application ID (per-user; drives Rich Presence)
   *       • Audio output device (routes playback via HTMLMediaElement.setSinkId)
   * ---------------------------------------------------------------------- */
  // Chromium hides audio-output device names/ids (and refuses non-default
  // setSinkId) until the page holds media permission. Requesting it once unlocks
  // both; we stop the stream immediately and never keep a mic open. Only called
  // when you actually use the output-device feature.
  var sinkUnlocked = false;
  function unlockDevices() {
    if (sinkUnlocked) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve();
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      s.getTracks().forEach(function (t) { t.stop(); }); // release the mic at once
      sinkUnlocked = true;
    }).catch(function () {});
  }

  function applySink() {
    var target = sGet(STK.audioSink) || 'default';
    var media = document.querySelectorAll('video, audio');
    var need = [];
    for (var i = 0; i < media.length; i++) {
      var m = media[i];
      if (typeof m.setSinkId === 'function' && m.__ytmSink !== target) need.push(m);
    }
    if (!need.length) return;
    // 'default' needs no permission; a specific device does.
    var pre = target === 'default' ? Promise.resolve() : unlockDevices();
    pre.then(function () {
      need.forEach(function (el) {
        el.setSinkId(target).then(function () { el.__ytmSink = target; }).catch(function () {});
      });
    });
  }
  window.__ytmLite.applySink = applySink;

  function settingsCSS() {
    return '#ytml-gear{position:fixed;right:16px;bottom:88px;z-index:2147483000;width:40px;height:40px;' +
      'border-radius:50%;background:#212121;color:#fff;display:flex;align-items:center;justify-content:center;' +
      'font-size:20px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.5);opacity:.55;transition:opacity .15s}' +
      '#ytml-gear:hover{opacity:1}' +
      '#ytml-ov{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.6);display:none;' +
      'align-items:center;justify-content:center}#ytml-ov.open{display:flex}' +
      '#ytml-panel{background:#212121;color:#fff;width:min(440px,92vw);border-radius:12px;padding:22px;' +
      'font-family:Roboto,system-ui,Arial,sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.6)}' +
      '#ytml-panel h2{margin:0 0 4px;font-size:18px;font-weight:600}' +
      '#ytml-panel .sub{color:#aaa;font-size:12px;margin:0 0 16px}' +
      '#ytml-panel label{display:block;font-size:13px;color:#ddd;margin:16px 0 6px;font-weight:500}' +
      '#ytml-panel input,#ytml-panel select{width:100%;box-sizing:border-box;background:#121212;color:#fff;' +
      'border:1px solid #383838;border-radius:6px;padding:9px 10px;font-size:13px}' +
      '#ytml-panel .hint{font-size:11px;color:#8a8a8a;margin-top:5px;line-height:1.4}' +
      '#ytml-panel .status{font-size:12px;color:#5cc85c;min-height:15px;margin-top:6px}' +
      '#ytml-panel .foot{display:flex;justify-content:flex-end;margin-top:20px}' +
      '#ytml-panel button{background:#cd0020;color:#fff;border:0;border-radius:6px;padding:9px 16px;' +
      'font-size:13px;font-weight:600;cursor:pointer}';
  }

  var settingsBuilt = false;
  function buildSettings() {
    if (settingsBuilt || !document.body) return;
    settingsBuilt = true;

    function mk(tag, props, kids) {
      var e = document.createElement(tag);
      if (props) Object.keys(props).forEach(function (k) {
        if (k === 'text') e.textContent = props[k];
        else if (k === 'class') e.className = props[k];
        else e.setAttribute(k, props[k]);
      });
      (kids || []).forEach(function (c) { e.appendChild(c); });
      return e;
    }

    var style = document.createElement('style');
    style.id = 'ytml-settings-style';
    style.textContent = settingsCSS();
    (document.head || document.documentElement).appendChild(style);

    var gear = document.createElement('div');
    gear.id = 'ytml-gear';
    gear.textContent = '⚙';
    gear.title = 'YTMusic Lite settings';
    document.body.appendChild(gear);

    // Built with DOM APIs, NOT innerHTML: YT Music enforces Trusted Types, which
    // makes any innerHTML assignment throw.
    var dcid = mk('input', { id: 'ytml-dcid', type: 'text', spellcheck: 'false', placeholder: 'e.g. 1527128686833307678' });
    var dcStatus = mk('div', { 'class': 'status', id: 'ytml-dc-status' });
    var sink = mk('select', { id: 'ytml-sink' });
    var sinkHint = mk('div', { 'class': 'hint', id: 'ytml-sink-hint' });
    var doneBtn = mk('button', { id: 'ytml-done', text: 'Done' });
    var panel = mk('div', { id: 'ytml-panel' }, [
      mk('h2', { text: 'YTMusic Lite — Settings' }),
      mk('p', { 'class': 'sub', text: 'Saved on this device.' }),
      mk('label', { text: 'Discord Application ID' }),
      dcid,
      mk('div', { 'class': 'hint', text: 'Create one at discord.com/developers, New Application copy its Application ID. Blank = Rich Presence off. Discord desktop must be running.' }),
      dcStatus,
      mk('label', { text: 'Audio output device' }),
      sink,
      sinkHint,
      mk('div', { 'class': 'hint', text: 'Routes YouTube Music to a specific device. Listing devices needs microphone permission — Chromium hides device names otherwise. It is requested only here, and the mic is released immediately.' }),
      mk('div', { 'class': 'foot' }, [doneBtn]),
    ]);
    var ov = mk('div', { id: 'ytml-ov' }, [panel]);
    document.body.appendChild(ov);

    function openPanel() {
      dcid.value = sGet(STK.discordClientId);
      dcStatus.textContent = '';
      populateSinks(sink, sinkHint);
      ov.classList.add('open');
    }
    function closePanel() { ov.classList.remove('open'); }
    gear.addEventListener('click', openPanel);
    doneBtn.addEventListener('click', closePanel);
    ov.addEventListener('click', function (e) { if (e.target === ov) closePanel(); });

    var idT;
    dcid.addEventListener('input', function () {
      clearTimeout(idT);
      idT = setTimeout(function () {
        var v = dcid.value.trim();
        sSet(STK.discordClientId, v);
        dstate.sig = ''; reportDiscord(); // push the new id to Rust immediately
        dcStatus.textContent = v ? 'Saved ✓' : 'Rich Presence disabled.';
      }, 400);
    });

    sink.addEventListener('change', function () {
      var opt = sink.options[sink.selectedIndex];
      sSet(STK.audioSink, sink.value);
      sSet(STK.audioSinkLabel, opt ? opt.textContent : '');
      applySink();
    });
  }

  function populateSinks(sel, hint) {
    var canSwitch = typeof HTMLMediaElement !== 'undefined' &&
      HTMLMediaElement.prototype && HTMLMediaElement.prototype.setSinkId;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    if (!canSwitch || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      var na = document.createElement('option');
      na.textContent = 'Not supported here';
      sel.appendChild(na);
      hint.textContent = 'This engine cannot switch output devices.';
      return;
    }
    var loading = document.createElement('option');
    loading.textContent = 'Detecting devices…';
    sel.appendChild(loading);
    // Unlock the real device list first (see unlockDevices).
    unlockDevices().then(function () {
      return navigator.mediaDevices.enumerateDevices();
    }).then(function (devs) {
      var saved = sGet(STK.audioSink);
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      var def = document.createElement('option');
      def.value = ''; def.textContent = 'System default';
      sel.appendChild(def);
      var labelled = false, n = 0;
      devs.forEach(function (d) {
        if (d.kind !== 'audiooutput') return;
        if (d.deviceId === 'default' || d.deviceId === 'communications' || !d.deviceId) return;
        n++;
        var o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || ('Output device ' + n);
        if (d.label) labelled = true;
        sel.appendChild(o);
      });
      sel.value = saved;
      hint.textContent = !n
        ? 'No selectable output devices were found.'
        : (labelled ? '' : 'Device names unavailable — selecting still works.');
    }).catch(function () { hint.textContent = 'Could not list output devices.'; });
  }

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
    buildSettings();
    applySink();
  }
  // Tidy up the Discord activity when the window/page goes away.
  window.addEventListener('beforeunload', function () { emit('ytmlite://clear'); });
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
