/**
 * Loading Screen System: segment bars and timeline for the custom screen editor.
 * Fork notice (Apache-2.0 §4b): added in 2026 by Drakul for Foundry VTT v14.
 *
 * A segment bar shows the length of a video or audio file, the part that plays between two handles and its fades, and
 * plays that part as a preview. Music files also show their waveform. The timeline draws, to scale, when each part of
 * a custom screen happens.
 */

import {MediaSegment, formatTime, parseTime, whenMetadata} from "./compat.js?v=20261124c";

/** Shortest segment the handles allow, in seconds. */
const MIN_SEGMENT = 0.5;

/** Largest audio file decoded for a waveform. */
const WAVE_MAX_BYTES = 40 * 1024 * 1024;

/** Sample rate used to decode waveforms; enough for peak levels. */
const WAVE_RATE = 8000;

/** Number of peak levels kept per waveform. */
const PEAK_COUNT = 1200;

/**
 * Waveform peaks by file path, shared by every bar.
 * @type {Map<string, Promise<Float32Array|null>>}
 */
const PEAKS = new Map();

/**
 * Peak levels of an audio file, from 0 to 1, or null when it cannot be read.
 * @param {string} src
 * @returns {Promise<Float32Array|null>}
 */
function loadPeaks(src) {
  let entry = PEAKS.get(src);
  if ( !entry ) {
    entry = decodePeaks(src).catch(err => {
      console.debug(`Loading Screen | No waveform for "${src}"`, err);
      return null;
    });
    PEAKS.set(src, entry);
  }
  return entry;
}

/**
 * @param {string} src
 * @returns {Promise<Float32Array|null>}
 */
async function decodePeaks(src) {
  const controller = new AbortController();
  const response = await fetch(src, {signal: controller.signal});
  if ( !response.ok ) return null;
  if ( Number(response.headers.get("content-length")) > WAVE_MAX_BYTES ) {
    controller.abort();
    return null;
  }
  const data = await response.arrayBuffer();
  if ( data.byteLength > WAVE_MAX_BYTES ) return null;
  const buffer = await new OfflineAudioContext(1, 1, WAVE_RATE).decodeAudioData(data);
  const channels = Array.from({length: buffer.numberOfChannels}, (_, i) => buffer.getChannelData(i));
  const peaks = new Float32Array(PEAK_COUNT);
  let loudest = 0;
  for ( let i = 0; i < PEAK_COUNT; i++ ) {
    const from = Math.floor((i * buffer.length) / PEAK_COUNT);
    const to = Math.max(from + 1, Math.floor(((i + 1) * buffer.length) / PEAK_COUNT));
    let peak = 0;
    for ( const samples of channels ) {
      for ( let j = from; j < to; j++ ) {
        const v = Math.abs(samples[j]);
        if ( v > peak ) peak = v;
      }
    }
    peaks[i] = peak;
    if ( peak > loudest ) loudest = peak;
  }
  if ( loudest > 0 ) for ( let i = 0; i < PEAK_COUNT; i++ ) peaks[i] /= loudest;
  return peaks;
}

/**
 * Create an element with a class.
 * @param {string} tag
 * @param {string} className
 * @returns {HTMLElement}
 */
function make(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

/**
 * Seconds written for the timeline: whole seconds when round, else one decimal.
 * @param {number} seconds
 * @returns {string}
 */
function shortTime(seconds) {
  return formatTime(seconds, Math.abs(seconds - Math.round(seconds)) < 0.05 ? 0 : 1);
}

/* -------------------------------------------- */
/*  Segment Bar                                 */
/* -------------------------------------------- */

/**
 * The bar of one file: drag the handles (or click the bar, or use the arrow keys on a handle) to choose where playback
 * starts and stops. The segment lives in four form fields (start, end, fadeIn, fadeOut) named after the kind; the bar
 * writes them and sends a change event once a drag ends.
 */
export class TrimBar {
  /**
   * @param {HTMLElement} root                Element with .ls-trim-track, .ls-trim-play and .ls-trim-status
   * @param {object} options
   * @param {"media"|"music"} options.kind    Prefix of the field names; "media" also shows the video frames
   * @param {HTMLElement} options.scope       Element holding the fields
   * @param {() => number} options.volume     Preview volume on this client
   * @param {Record<string, string>} options.labels   Localized texts: start, end, play, stop, loading, unavailable, status
   * @param {(duration: number) => void} [options.onLength]   Called when the file duration is known (NaN on failure)
   */
  constructor(root, {kind, scope, volume, labels, onLength}) {
    this.root = root;
    this.kind = kind;
    this.volume = volume;
    this.labels = labels;
    this.onLength = onLength ?? null;
    this.fields = {
      start: scope.querySelector(`[name="${kind}.start"]`),
      end: scope.querySelector(`[name="${kind}.end"]`),
      fadeIn: scope.querySelector(`[name="${kind}.fadeIn"]`),
      fadeOut: scope.querySelector(`[name="${kind}.fadeOut"]`)
    };
    this.#build();
    this.#bind();
    this.render();
  }

  /** File shown by the bar. */
  src = "";

  /** File duration in seconds; NaN until known. */
  duration = NaN;

  /** @type {HTMLMediaElement|null} */
  media = null;

  /** @type {MediaSegment|null} */
  #preview = null;

  /** @type {{edge: string, pointerId: number}|null} */
  #drag = null;

  /** @type {Set<string>} Edges moved since the last change event */
  #changed = new Set();

  /** @type {Float32Array|null} */
  #peaks = null;

  /** Identifies the current file load, so late results of an older one are ignored. */
  #token = null;

  #loading = false;
  #raf = 0;

  /** @type {number|null} Frame to show once the current seek finishes */
  #pendingFrame = null;

  /** @type {ResizeObserver|null} */
  #resize = null;

  /** @type {Function[]} */
  #listeners = [];

  /* -------------------------------------------- */

  #build() {
    const track = this.track = this.root.querySelector(".ls-trim-track");
    track.replaceChildren();
    if ( this.kind === "music" ) {
      this.wave = make("canvas", "ls-trim-wave");
      this.wave.setAttribute("aria-hidden", "true");
      track.append(this.wave);
    }
    this.range = make("div", "ls-trim-range");
    this.rampIn = make("div", "ls-trim-ramp ls-trim-ramp-in");
    this.rampOut = make("div", "ls-trim-ramp ls-trim-ramp-out");
    this.range.append(this.rampIn, this.rampOut);
    this.head = make("div", "ls-trim-head");
    this.head.hidden = true;
    const handle = edge => {
      const el = make("div", "ls-trim-handle");
      el.dataset.edge = edge;
      el.setAttribute("role", "slider");
      el.setAttribute("aria-label", this.labels[edge]);
      el.dataset.tooltip = this.labels[edge];
      return el;
    };
    this.handles = {start: handle("start"), end: handle("end")};
    track.append(this.range, this.head, this.handles.start, this.handles.end);
    this.status = this.root.querySelector(".ls-trim-status");
    this.playButton = this.root.querySelector(".ls-trim-play");
    this.previewBox = this.root.querySelector(".ls-trim-preview");
  }

  #bind() {
    const on = (target, type, fn, options) => {
      if ( !target ) return;
      target.addEventListener(type, fn, options);
      this.#listeners.push(() => target.removeEventListener(type, fn, options));
    };
    on(this.track, "pointerdown", event => this.#onPointerDown(event));
    on(this.track, "pointermove", event => this.#onPointerMove(event));
    for ( const type of ["pointerup", "pointercancel", "lostpointercapture"] ) {
      on(this.track, type, event => this.#onPointerUp(event));
    }
    on(this.track, "keydown", event => this.#onKeyDown(event));
    on(this.playButton, "click", event => {
      event.preventDefault();
      if ( this.#preview ) this.stop();
      else this.play();
    });
    for ( const [edge, field] of Object.entries(this.fields) ) {
      on(field, "input", () => this.render());
      on(field, "change", () => {
        this.render();
        if ( (edge === "start") || (edge === "end") ) this.#scrub(edge);
      });
    }
    if ( this.wave ) {
      this.#resize = new ResizeObserver(() => this.#drawWave());
      this.#resize.observe(this.track);
    }
  }

  /* -------------------------------------------- */

  /**
   * Show a file. An empty path clears the bar.
   * @param {string} src
   */
  setSource(src) {
    src = String(src ?? "").trim();
    if ( (src === this.src) && (this.media || !src) ) return;
    this.stop();
    this.#unload();
    this.src = src;
    this.duration = NaN;
    this.#peaks = null;
    this.#drawWave();
    const token = this.#token = {};
    if ( !src ) {
      this.#loading = false;
      this.render();
      this.onLength?.(NaN);
      return;
    }
    const media = this.media = (this.kind === "media") ? this.#createVideo() : new Audio();
    media.preload = "metadata";
    media.src = src;
    this.#loading = true;
    this.render();
    whenMetadata(media).then(ok => {
      if ( this.#token !== token ) return;
      this.#loading = false;
      this.duration = (ok && Number.isFinite(media.duration)) ? media.duration : NaN;
      this.render();
      this.#scrub("start");
      this.onLength?.(this.duration);
      if ( !ok || (this.kind !== "music") ) return;
      loadPeaks(src).then(peaks => {
        if ( this.#token !== token ) return;
        this.#peaks = peaks;
        this.#drawWave();
      });
    });
  }

  /**
   * @returns {HTMLVideoElement}
   */
  #createVideo() {
    const video = make("video", "ls-trim-video");
    video.muted = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.addEventListener("seeked", () => {
      if ( this.#pendingFrame === null ) return;
      const t = this.#pendingFrame;
      this.#pendingFrame = null;
      video.currentTime = t;
    });
    this.previewBox?.replaceChildren(video);
    return video;
  }

  #unload() {
    const media = this.media;
    this.media = null;
    this.#pendingFrame = null;
    if ( !media ) return;
    media.pause();
    media.removeAttribute("src");
    media.load();
    media.remove?.();
  }

  /* -------------------------------------------- */

  /**
   * The segment as playback will use it: an end that is empty or not after the start means the end of the file.
   * @returns {{start: number, end: number, fadeIn: number, fadeOut: number}}
   */
  #segment() {
    const max = Number.isFinite(this.duration) ? this.duration : Infinity;
    let start = parseTime(this.fields.start?.value);
    if ( !Number.isFinite(start) ) start = 0;
    start = Math.clamp(start, 0, max);
    let end = parseTime(this.fields.end?.value);
    if ( !Number.isFinite(end) || (end <= start) ) end = max;
    end = Math.min(end, max);
    const fadeIn = Math.max(0, Number(this.fields.fadeIn?.value) || 0);
    const fadeOut = Math.max(0, Number(this.fields.fadeOut?.value) || 0);
    return {start, end, fadeIn, fadeOut};
  }

  /**
   * Redraw the range, the fades, the handles and the status line from the fields.
   */
  render() {
    const d = this.duration;
    const known = Number.isFinite(d) && (d > 0);
    this.root.classList.toggle("ls-trim-ready", known);
    if ( this.playButton ) this.playButton.disabled = !known;
    for ( const el of Object.values(this.handles) ) el.tabIndex = known ? 0 : -1;
    if ( !known ) {
      let text = "";
      if ( this.src ) text = this.#loading ? this.labels.loading : this.labels.unavailable;
      if ( this.status ) this.status.textContent = text;
      return;
    }
    const {start, end, fadeIn, fadeOut} = this.#segment();
    const pct = t => `${(Math.clamp(t / d, 0, 1) * 100).toFixed(3)}%`;
    const span = Math.max(end - start, 1e-6);
    this.range.style.left = pct(start);
    this.range.style.width = pct(end - start);
    this.rampIn.style.width = `${(Math.min(1, fadeIn / span) * 100).toFixed(3)}%`;
    this.rampOut.style.width = `${(Math.min(1, fadeOut / span) * 100).toFixed(3)}%`;
    this.handles.start.style.left = pct(start);
    this.handles.end.style.left = pct(end);
    this.#aria(this.handles.start, start, 0, Math.max(0, end - MIN_SEGMENT));
    this.#aria(this.handles.end, end, Math.min(d, start + MIN_SEGMENT), d);
    if ( this.status ) {
      this.status.textContent = this.labels.status
        .replace("{start}", formatTime(start))
        .replace("{end}", formatTime(end))
        .replace("{length}", formatTime(end - start))
        .replace("{total}", formatTime(d));
    }
  }

  /**
   * @param {HTMLElement} el
   * @param {number} value
   * @param {number} min
   * @param {number} max
   */
  #aria(el, value, min, max) {
    el.setAttribute("aria-valuemin", min.toFixed(1));
    el.setAttribute("aria-valuemax", max.toFixed(1));
    el.setAttribute("aria-valuenow", value.toFixed(1));
    el.setAttribute("aria-valuetext", formatTime(value));
  }

  /* -------------------------------------------- */
  /*  Editing                                     */
  /* -------------------------------------------- */

  /**
   * File position under a pointer.
   * @param {number} clientX
   * @returns {number}
   */
  #timeAt(clientX) {
    const rect = this.track.getBoundingClientRect();
    return Math.clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1) * this.duration;
  }

  /**
   * Move one edge of the segment, keeping the segment at least MIN_SEGMENT long. An end at the end of the file is
   * written as empty, so it follows the file.
   * @param {"start"|"end"} edge
   * @param {number} t
   */
  #setEdge(edge, t) {
    const d = this.duration;
    const {start, end} = this.#segment();
    if ( edge === "start" ) {
      this.fields.start.value = formatTime(Math.clamp(t, 0, Math.max(0, end - MIN_SEGMENT)));
    }
    else {
      const value = Math.clamp(t, Math.min(d, start + MIN_SEGMENT), d);
      this.fields.end.value = (value >= (d - 0.05)) ? "" : formatTime(value);
    }
    this.#changed.add(edge);
    this.render();
  }

  /**
   * Tell the form about the edges that moved.
   */
  #commit() {
    for ( const edge of this.#changed ) this.fields[edge]?.dispatchEvent(new Event("change", {bubbles: true}));
    this.#changed.clear();
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerDown(event) {
    if ( (event.button !== 0) || !Number.isFinite(this.duration) ) return;
    let edge = event.target.closest?.(".ls-trim-handle")?.dataset.edge;
    if ( !edge ) {
      const t = this.#timeAt(event.clientX);
      const {start, end} = this.#segment();
      edge = Math.abs(t - start) <= Math.abs(t - end) ? "start" : "end";
      this.#setEdge(edge, t);
    }
    this.#drag = {edge, pointerId: event.pointerId};
    this.track.setPointerCapture(event.pointerId);
    this.handles[edge].focus({preventScroll: true});
    this.#scrub(edge);
    event.preventDefault();
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerMove(event) {
    if ( !this.#drag || (event.pointerId !== this.#drag.pointerId) ) return;
    this.#setEdge(this.#drag.edge, this.#timeAt(event.clientX));
    this.#scrub(this.#drag.edge);
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerUp(event) {
    if ( !this.#drag || (event.pointerId !== this.#drag.pointerId) ) return;
    this.#drag = null;
    if ( this.track.hasPointerCapture(event.pointerId) ) this.track.releasePointerCapture(event.pointerId);
    this.#commit();
  }

  /**
   * Arrow keys move a focused handle by a tenth of a second (Shift: one second), Page keys by five seconds, Home and
   * End to the ends of the file. The keys stop here, so they do not pan the canvas.
   * @param {KeyboardEvent} event
   */
  #onKeyDown(event) {
    const edge = event.target.closest?.(".ls-trim-handle")?.dataset.edge;
    if ( !edge || !Number.isFinite(this.duration) ) return;
    const {start, end} = this.#segment();
    const current = edge === "start" ? start : end;
    const step = event.shiftKey ? 1 : 0.1;
    let next;
    switch ( event.key ) {
      case "ArrowLeft": case "ArrowDown": next = current - step; break;
      case "ArrowRight": case "ArrowUp": next = current + step; break;
      case "PageDown": next = current - 5; break;
      case "PageUp": next = current + 5; break;
      case "Home": next = 0; break;
      case "End": next = this.duration; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#setEdge(edge, next);
    this.#scrub(edge);
    this.#commit();
  }

  /**
   * Show the video frame at an edge of the segment.
   * @param {"start"|"end"} edge
   */
  #scrub(edge) {
    const video = this.media;
    if ( !(video instanceof HTMLVideoElement) || this.#preview || !Number.isFinite(this.duration) ) return;
    const {start, end} = this.#segment();
    const t = edge === "end" ? Math.max(0, end - 0.05) : start;
    if ( video.seeking ) this.#pendingFrame = t;
    else video.currentTime = t;
  }

  /* -------------------------------------------- */
  /*  Preview                                     */
  /* -------------------------------------------- */

  /**
   * Play the segment with its fades, on this client only.
   * @returns {Promise<void>}
   */
  async play() {
    const media = this.media;
    if ( !media || this.#preview || !Number.isFinite(this.duration) ) return;
    const {start, end, fadeIn, fadeOut} = this.#segment();
    const segment = this.#preview = new MediaSegment(media, {
      start,
      end: end < this.duration ? end : 0,
      fadeIn,
      fadeOut,
      volume: this.volume(),
      picture: media instanceof HTMLVideoElement ? media : null,
      onEnd: () => this.stop()
    });
    this.#setPlaying(true);
    try {
      media.muted = false;
      await segment.prepare();
      if ( this.#preview !== segment ) return;
      await segment.play();
      this.#follow(segment);
    } catch(err) {
      console.warn("Loading Screen | Could not preview the segment", err);
      if ( this.#preview === segment ) this.stop();
    }
  }

  /**
   * Stop the preview and show the start frame again.
   */
  stop() {
    const segment = this.#preview;
    if ( !segment ) return;
    this.#preview = null;
    segment.dispose();
    cancelAnimationFrame(this.#raf);
    if ( this.media instanceof HTMLVideoElement ) {
      this.media.muted = true;
      this.media.style.opacity = "";
    }
    this.#setPlaying(false);
    this.#scrub("start");
  }

  /**
   * Apply a changed volume to a running preview.
   */
  updateVolume() {
    this.#preview?.setVolume(this.volume());
  }

  /**
   * @param {boolean} playing
   */
  #setPlaying(playing) {
    this.root.classList.toggle("ls-trim-playing", playing);
    this.head.hidden = !playing;
    const button = this.playButton;
    if ( !button ) return;
    const label = playing ? this.labels.stop : this.labels.play;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    button.querySelector("i")?.classList.replace(playing ? "fa-play" : "fa-stop", playing ? "fa-stop" : "fa-play");
  }

  /**
   * Move the playhead with playback.
   * @param {MediaSegment} segment
   */
  #follow(segment) {
    const step = () => {
      if ( this.#preview !== segment ) return;
      const d = this.duration;
      this.head.style.left = `${(Math.clamp(segment.media.currentTime / d, 0, 1) * 100).toFixed(3)}%`;
      this.#raf = requestAnimationFrame(step);
    };
    step();
  }

  /* -------------------------------------------- */

  #drawWave() {
    const canvas = this.wave;
    if ( !canvas ) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if ( canvas.width !== width ) canvas.width = width;
    if ( canvas.height !== height ) canvas.height = height;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    const peaks = this.#peaks;
    if ( !peaks || !width || !height ) return;
    context.fillStyle = getComputedStyle(canvas).color;
    const middle = height / 2;
    const column = Math.max(1, Math.round(ratio));
    for ( let x = 0; x < width; x += column ) {
      const from = Math.floor((x / width) * peaks.length);
      const to = Math.max(from + 1, Math.floor(((x + column) / width) * peaks.length));
      let peak = 0;
      for ( let i = from; i < Math.min(to, peaks.length); i++ ) peak = Math.max(peak, peaks[i]);
      const h = Math.max(ratio, peak * (height - (2 * ratio)));
      context.fillRect(x, middle - (h / 2), column, h);
    }
  }

  /**
   * Stop the preview, release the file and remove the listeners.
   */
  destroy() {
    this.stop();
    this.#token = null;
    this.#unload();
    this.#resize?.disconnect();
    for ( const off of this.#listeners.splice(0) ) off();
  }
}

/* -------------------------------------------- */
/*  Timeline                                    */
/* -------------------------------------------- */

/**
 * Draw a screen's timeline to scale: the video, image or black screen, the move to the screen's scene, the camera move,
 * the hold, the forward to the destination, the music and the macros.
 * @param {HTMLElement} el
 * @param {import("./custom-screens.js").CustomScreenTimeline} t
 * @param {object} labels                 Localized texts
 * @param {Record<string, string>} labels.kinds   Names of the media kinds: video, image, black
 * @param {string} labels.stage           Tooltip of the move to the screen's own scene
 * @param {string} labels.forward         Name of the destination
 * @param {string} labels.camera
 * @param {string} labels.reveal          Shown instead of the camera when it does not move
 * @param {string} labels.hold
 * @param {string} labels.music
 * @param {string} labels.unknown         Added to a length that is still an estimate
 * @param {(uuid: string) => string} labels.macro   Name of a macro
 * @param {boolean} cameraMoves
 */
export function renderTimeline(el, t, labels, cameraMoves) {
  const total = t.total;
  const pct = s => `${(Math.clamp(s / total, 0, 1) * 100).toFixed(3)}%`;
  const escape = foundry.utils.escapeHTML;
  const block = (className, from, to, text, tip) => {
    const b = make("div", `ls-tl-block ${className}`);
    b.style.left = pct(from);
    b.style.width = pct(Math.max(0, to - from));
    const span = make("span", "ls-tl-text");
    span.textContent = text;
    b.append(span);
    b.dataset.tooltip = escape(tip ?? text);
    return b;
  };

  // Screen
  const screen = make("div", "ls-tl-lane ls-tl-screen");
  const shownText = `${labels.kinds[t.kind]} ${shortTime(t.shown)}${t.known ? "" : ` (${labels.unknown})`}`;
  const media = block(`ls-tl-${t.kind}`, 0, t.shown, shownText);
  media.classList.toggle("ls-tl-estimate", !t.known);
  const revealText = `${cameraMoves ? labels.camera : labels.reveal} ${shortTime(t.camera)}`;
  screen.append(media);
  if ( t.shownStage !== false ) screen.append(block("ls-tl-camera", t.moments.media, t.moments.end, revealText));
  if ( t.hold > 0 ) {
    screen.append(block("ls-tl-hold", t.moments.end, t.moments.forward, `${labels.hold} ${shortTime(t.hold)}`));
  }
  if ( t.forward ) screen.append(block("ls-tl-forward", t.moments.forward, t.close, `→ ${labels.forward}`));
  if ( t.stage ) {
    const mark = make("div", "ls-tl-stage");
    mark.dataset.tooltip = escape(labels.stage);
    const icon = make("i", "fa-solid fa-map");
    icon.inert = true;
    mark.append(icon);
    screen.append(mark);
  }
  const lanes = [screen];

  // Music
  if ( t.music ) {
    const lane = make("div", "ls-tl-lane ls-tl-music-lane");
    const known = Number.isFinite(t.music.until);
    const until = known ? t.music.until : total;
    const length = until - t.music.at;
    const music = block("ls-tl-music", t.music.at, until, `${labels.music} ${shortTime(length)}`);
    music.classList.toggle("ls-tl-estimate", !known);
    lane.append(music);
    lanes.push(lane);
  }

  // Macros
  if ( t.macros.length ) {
    const lane = make("div", "ls-tl-lane ls-tl-macros");
    for ( const macro of t.macros ) {
      const mark = make("div", "ls-tl-macro");
      mark.style.left = pct(macro.at);
      mark.dataset.tooltip = escape(`${labels.macro(macro.uuid)} · ${shortTime(macro.at)}`);
      lane.append(mark);
    }
    lanes.push(lane);
  }

  // Scale
  const axis = make("div", "ls-tl-axis");
  const zero = make("span", "");
  zero.textContent = shortTime(0);
  const end = make("span", "");
  end.textContent = shortTime(total);
  axis.append(zero, end);
  el.replaceChildren(...lanes, axis);
}
