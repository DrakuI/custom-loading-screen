/**
 * Loading Screen System: file and media helpers.
 * Fork notice (Apache-2.0 §4b): rewritten in 2026 for Foundry VTT v14. Adds wildcard patterns, several entries per
 * field, audio resolution, the volume fade shared by the loading music and the custom screens, time parsing and
 * segment playback with fades. The original file only browsed a single folder.
 *
 * A media field holds one or more entries separated by ";" or line breaks. Each entry is one of:
 * - a file:            worlds/my-world/loading/tavern.webp
 * - a folder:          worlds/my-world/loading            (every matching file inside it)
 * - a wildcard:        worlds/my-world/loading/tavern-*.webp, loading/*.{webp,jpg}, loading/[a-c]*
 * - folder wildcards:  worlds/my-world/loading/*\/*.webp, worlds/my-world/loading/**  (any depth)
 * Matching is case-sensitive, like the Foundry server.
 */

/** Top-level folders served from the core public directory. */
const PUBLIC_ROOTS = ["icons/", "sounds/", "ui/", "cards/", "canvas/", "toolclips/", "nue/", "docs/", "fonts/"];

/** Safety limits for client-side folder walking. */
const MAX_DIRECTORIES = 200;
const MAX_DEPTH = 6;

/**
 * File extensions accepted for a media kind, with leading dots.
 * @param {"image"|"audio"} kind
 * @returns {string[]}
 */
export function extensionsFor(kind) {
  const keys = kind === "audio"
    ? Object.keys(CONST.AUDIO_FILE_EXTENSIONS)
    : [...Object.keys(CONST.IMAGE_FILE_EXTENSIONS), ...Object.keys(CONST.VIDEO_FILE_EXTENSIONS)];
  return keys.map(k => `.${k}`);
}

/**
 * Lower-case extension of a path or URL, with its dot, or an empty string.
 * @param {string} path
 * @returns {string}
 */
export function extensionOf(path) {
  const clean = String(path).split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot > clean.lastIndexOf("/") ? clean.slice(dot).toLowerCase() : "";
}

/**
 * Is this path a video file?
 * @param {string} path
 * @returns {boolean}
 */
export function isVideo(path) {
  return Object.keys(CONST.VIDEO_FILE_EXTENSIONS).includes(extensionOf(path).slice(1));
}

/**
 * Split a media field into trimmed entries.
 * @param {string} spec
 * @returns {string[]}
 */
export function splitSpec(spec) {
  return String(spec ?? "").split(/[;\n\r]+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Does a path or segment contain wildcard syntax?
 * @param {string} text
 * @returns {boolean}
 */
export function hasWildcard(text) {
  return /[*?[]/.test(text) || /\{[^{}]*,[^{}]*\}/.test(text);
}

/**
 * Expand {a,b} alternatives into separate patterns. Braces without a comma are kept literally.
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]*,[^{}]*)\}/);
  if ( !match ) return [pattern];
  const [whole, inner] = match;
  const index = match.index;
  const results = [];
  for ( const alternative of inner.split(",") ) {
    const next = pattern.slice(0, index) + alternative + pattern.slice(index + whole.length);
    results.push(...expandBraces(next));
  }
  return results;
}

/**
 * Convert a glob for a single path segment into a regular expression.
 * Supports *, ? and [...] classes (with ! or ^ for negation).
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let source = "";
  for ( let i = 0; i < glob.length; i++ ) {
    const c = glob[i];
    if ( c === "*" ) source += "[^/]*";
    else if ( c === "?" ) source += "[^/]";
    else if ( c === "[" ) {
      const end = glob.indexOf("]", i + 2);
      if ( end === -1 ) {
        source += "\\[";
        continue;
      }
      let cls = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
      if ( (cls[0] === "!") || (cls[0] === "^") ) cls = `^${cls.slice(1)}`;
      source += `[${cls}]`;
      i = end;
    }
    else source += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * Decode a URI component without throwing on malformed input.
 * @param {string} text
 * @returns {string}
 */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Last segment of a path, decoded.
 * @param {string} path
 * @returns {string}
 */
function basename(path) {
  return safeDecode(String(path).replace(/\/+$/, "").split("/").pop());
}

/**
 * Determine where a path is stored and how to browse it.
 * @param {string} path
 * @returns {{source: string|null, target: string, bucket?: string}}
 */
export function sourceFor(path) {
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  if ( /^https?:\/\//i.test(path) ) {
    const s3 = FilePicker.matchS3URL?.(path);
    if ( s3?.groups ) return {source: "s3", target: safeDecode(s3.groups.key), bucket: s3.groups.bucket};
    return {source: null, target: path};
  }
  const target = safeDecode(path.replace(/^\/+/, ""));
  const isPublic = PUBLIC_ROOTS.some(root => target.startsWith(root) || (target === root.slice(0, -1)));
  if ( isPublic ) return {source: "public", target};
  return {source: "data", target};
}

/**
 * Browse a location, returning null when it does not exist or cannot be read.
 * @param {string} source
 * @param {string} target
 * @param {object} options
 * @returns {Promise<{dirs: string[], files: string[]}|null>}
 */
async function tryBrowse(source, target, options) {
  try {
    return await foundry.applications.apps.FilePicker.implementation.browse(source, target, options);
  } catch {
    return null;
  }
}

/**
 * Collect a set of folders and every folder below them, within the safety limits.
 * @param {string} source
 * @param {string[]} roots
 * @param {object} options
 * @returns {Promise<string[]>}
 */
async function descendants(source, roots, options) {
  const found = [...roots];
  let frontier = [...roots];
  for ( let depth = 0; (depth < MAX_DEPTH) && frontier.length && (found.length < MAX_DIRECTORIES); depth++ ) {
    const next = [];
    for ( const dir of frontier ) {
      const result = await tryBrowse(source, dir, options);
      for ( const sub of result?.dirs ?? [] ) {
        const decoded = safeDecode(sub);
        if ( found.includes(decoded) ) continue;
        found.push(decoded);
        next.push(decoded);
        if ( found.length >= MAX_DIRECTORIES ) break;
      }
      if ( found.length >= MAX_DIRECTORIES ) break;
    }
    frontier = next;
  }
  return found;
}

/**
 * Resolve a pattern with wildcards in folder names by walking the folders on the client.
 * @param {string} source
 * @param {string[]} segments
 * @param {object} options
 * @returns {Promise<string[]>}
 */
async function walk(source, segments, options) {
  let dirs = [""];
  const last = segments.length - 1;
  for ( let i = 0; i < last; i++ ) {
    const segment = segments[i];
    if ( segment === "**" ) {
      dirs = await descendants(source, dirs, options);
      continue;
    }
    if ( !hasWildcard(segment) ) {
      dirs = dirs.map(d => (d ? `${d}/${segment}` : segment));
      continue;
    }
    const rx = globToRegExp(segment);
    const next = [];
    for ( const dir of dirs ) {
      const result = await tryBrowse(source, dir, options);
      for ( const sub of result?.dirs ?? [] ) {
        if ( rx.test(basename(sub)) ) next.push(safeDecode(sub));
      }
      if ( next.length >= MAX_DIRECTORIES ) break;
    }
    dirs = next;
  }

  const final = segments[last];
  const fileDirs = final === "**" ? await descendants(source, dirs, options) : dirs;
  const rx = ((final === "**") || (final === "")) ? null : globToRegExp(final);
  const files = [];
  for ( const dir of fileDirs ) {
    const result = await tryBrowse(source, dir, options);
    for ( const file of result?.files ?? [] ) {
      if ( !rx || rx.test(basename(file)) ) files.push(file);
    }
  }
  return files;
}

/**
 * Resolve a single entry (after brace expansion) into file paths.
 * @param {string} entry
 * @param {string[]} extensions
 * @returns {Promise<string[]>}
 */
async function resolveEntry(entry, extensions) {
  const {source, target, bucket} = sourceFor(entry);
  const wildcard = hasWildcard(target) || target.split("/").includes("**");

  // A single file is used as given
  if ( !wildcard && extensions.includes(extensionOf(target)) ) return [entry];
  if ( !source ) return [];

  const options = {extensions};
  if ( bucket ) options.bucket = bucket;
  const segments = target.replace(/\/+$/, "").split("/");
  const folderWildcard = segments.slice(0, -1).some(s => (s === "**") || hasWildcard(s));

  // A folder: every matching file inside it
  if ( !wildcard ) return (await tryBrowse(source, target, options))?.files ?? [];

  // Wildcards only in the file name are matched by the server
  if ( !folderWildcard && (segments.at(-1) !== "**") ) {
    return (await tryBrowse(source, target, {...options, wildcard: true}))?.files ?? [];
  }

  // Wildcards in folder names are walked on the client
  return walk(source, segments, options);
}

/**
 * Resolve a media field into a de-duplicated list of file paths.
 * @param {string} spec                 The field value
 * @param {"image"|"audio"} [kind]      The kind of media to keep
 * @returns {Promise<string[]>}
 */
export async function resolveMedia(spec, kind="image") {
  const extensions = extensionsFor(kind);
  const results = [];
  for ( const raw of splitSpec(spec) ) {
    for ( const entry of expandBraces(raw) ) {
      try {
        results.push(...await resolveEntry(entry, extensions));
      } catch(err) {
        console.warn(`Loading Screen | Could not resolve "${entry}"`, err);
      }
    }
  }
  return Array.from(new Set(results));
}

/**
 * Ramp the volume of an audio or video element. Timer based, so it also completes in background tabs.
 * @param {HTMLMediaElement} media
 * @param {number} target       Target volume between 0 and 1
 * @param {number} duration     Duration in milliseconds
 * @returns {Promise<void>}
 */
export function fadeAudio(media, target, duration) {
  return new Promise(resolve => {
    const from = media.volume;
    if ( !(duration > 0) || (from === target) ) {
      media.volume = target;
      return resolve();
    }
    const start = performance.now();
    const id = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / duration);
      media.volume = Math.clamp(from + ((target - from) * t), 0, 1);
      if ( t < 1 ) return;
      window.clearInterval(id);
      resolve();
    }, 40);
  });
}

/* -------------------------------------------- */
/*  Times                                       */
/* -------------------------------------------- */

/**
 * Seconds from a time written as seconds ("83.5"), minutes and seconds ("1:23.5") or hours, minutes and seconds
 * ("1:02:03"). A comma works as the decimal separator. Numbers are returned as they are.
 * @param {string|number|null|undefined} value
 * @returns {number}    NaN for empty or invalid input
 */
export function parseTime(value) {
  if ( typeof value === "number" ) return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? "").trim().replace(",", ".");
  if ( !text ) return NaN;
  const parts = text.split(":");
  if ( (parts.length > 3) || parts.some(p => !/^\d*\.?\d*$/.test(p) || (p === "") || (p === ".")) ) return NaN;
  return parts.reduce((total, part) => (total * 60) + Number(part), 0);
}

/**
 * Write seconds as m:ss.s, or h:mm:ss.s from one hour on.
 * @param {number} seconds
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatTime(seconds, decimals=1) {
  if ( !Number.isFinite(seconds) ) return "";
  const factor = 10 ** decimals;
  const total = Math.round(Math.max(0, seconds) * factor) / factor;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toFixed(decimals).padStart(decimals ? decimals + 3 : 2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/* -------------------------------------------- */
/*  Media Segments                              */
/* -------------------------------------------- */

/** Interval of the segment volume envelope, in milliseconds. */
const SEGMENT_TICK_MS = 50;

/**
 * Resolve once a media element knows its duration.
 * @param {HTMLMediaElement} media
 * @param {number} [timeout=15000]
 * @returns {Promise<boolean>}    False when loading failed or timed out
 */
export function whenMetadata(media, timeout=15000) {
  if ( media.readyState >= HTMLMediaElement.HAVE_METADATA ) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = ok => {
      window.clearTimeout(timer);
      media.removeEventListener("loadedmetadata", onMeta);
      media.removeEventListener("error", onError);
      resolve(ok);
    };
    const onMeta = () => done(true);
    const onError = () => done(false);
    const timer = window.setTimeout(() => done(false), timeout);
    media.addEventListener("loadedmetadata", onMeta);
    media.addEventListener("error", onError);
  });
}

/**
 * Resolve once a media element finished seeking, or after a timeout.
 * @param {HTMLMediaElement} media
 * @param {number} [timeout=5000]
 * @returns {Promise<void>}
 */
function whenSeeked(media, timeout=5000) {
  if ( !media.seeking ) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      window.clearTimeout(timer);
      media.removeEventListener("seeked", done);
      media.removeEventListener("error", done);
      resolve();
    };
    const timer = window.setTimeout(done, timeout);
    media.addEventListener("seeked", done);
    media.addEventListener("error", done);
  });
}

/**
 * Plays part of an audio or video element, from a start position to an end position, with fades that follow the
 * playback position, so they stay in step with the media when it buffers. A timer drives the volume, which keeps
 * working in background tabs that play sound.
 */
export class MediaSegment {
  /**
   * @param {HTMLMediaElement} media
   * @param {object} [segment]
   * @param {number} [segment.start=0]        Seconds into the file where playback begins
   * @param {number} [segment.end=0]          Seconds where playback stops; 0, or a value not after the start, means
   *                                          the end of the file
   * @param {number} [segment.fadeIn=0]       Seconds of fade-in after the start
   * @param {number} [segment.fadeOut=0]      Seconds of fade-out before the end
   * @param {number} [segment.volume=1]       Volume between the fades, from 0 to 1
   * @param {HTMLElement} [segment.picture]   Element whose opacity follows the fades
   * @param {Function} [segment.onEnd]        Called once when playback reaches the end
   */
  constructor(media, {start=0, end=0, fadeIn=0, fadeOut=0, volume=1, picture=null, onEnd=null}={}) {
    this.media = media;
    this.start = Math.max(0, Number(start) || 0);
    this.end = Number(end) > this.start ? Number(end) : 0;
    this.fadeIn = Math.max(0, Number(fadeIn) || 0);
    this.fadeOut = Math.max(0, Number(fadeOut) || 0);
    this.volume = Math.clamp(Number(volume) || 0, 0, 1);
    this.picture = picture;
    this.onEnd = onEnd;
    media.addEventListener("ended", this.#onEnded);
  }

  /** @type {number|null} */
  #timer = null;

  /** Multiplier applied by a release, from 1 down to 0. */
  #gain = 1;

  /** @type {Promise<void>|null} */
  #released = null;

  #done = false;

  #onEnded = () => this.#finish();

  /* -------------------------------------------- */

  /**
   * Position where playback stops: the segment end, or the end of the file once its duration is known.
   * @type {number}
   */
  get stopAt() {
    const duration = Number.isFinite(this.media.duration) ? this.media.duration : Infinity;
    return this.end ? Math.min(this.end, duration) : duration;
  }

  /**
   * Seconds of the segment; Infinity while the file duration is unknown.
   * @type {number}
   */
  get length() {
    return Math.max(0, this.stopAt - this.start);
  }

  /**
   * The segment reached its end, was released or was disposed.
   * @type {boolean}
   */
  get done() {
    return this.#done;
  }

  /* -------------------------------------------- */

  /**
   * Fade level at a playback position, from 0 to 1.
   * @param {number} t    Seconds into the file
   * @returns {number}
   */
  envelope(t) {
    let level = 1;
    if ( this.fadeIn > 0 ) level = Math.min(level, (t - this.start) / this.fadeIn);
    const stop = this.stopAt;
    if ( (this.fadeOut > 0) && Number.isFinite(stop) ) level = Math.min(level, (stop - t) / this.fadeOut);
    return Math.clamp(level, 0, 1);
  }

  /**
   * Load the duration and move to the start of the segment.
   * @returns {Promise<void>}   Rejects when the file cannot be loaded
   */
  async prepare() {
    const media = this.media;
    if ( !await whenMetadata(media) ) throw new Error(`Could not load "${media.currentSrc || media.src}"`);
    if ( Math.abs(media.currentTime - this.start) > 0.05 ) {
      media.currentTime = this.start;
      await whenSeeked(media);
    }
    this.#apply();
  }

  /**
   * Start or resume playback, optionally from a position inside the segment.
   * @param {number} [from]     Seconds into the file
   * @returns {Promise<void>}   Rejects like HTMLMediaElement#play, for example with NotAllowedError
   */
  async play(from) {
    if ( this.#done ) return;
    const media = this.media;
    if ( from !== undefined ) {
      const position = Math.max(this.start, from);
      if ( position >= this.stopAt ) return this.#finish();
      if ( Math.abs(media.currentTime - position) > 0.25 ) media.currentTime = position;
    }
    this.#apply();
    await media.play();
    if ( this.#done ) {
      media.pause();
      return;
    }
    this.#timer ??= window.setInterval(() => this.#tick(), SEGMENT_TICK_MS);
  }

  /**
   * Change the volume between the fades.
   * @param {number} volume
   */
  setVolume(volume) {
    this.volume = Math.clamp(Number(volume) || 0, 0, 1);
    if ( !this.#done ) this.#apply();
  }

  /**
   * Fade the sound out from wherever playback is, then pause. The end callback is not called.
   * @param {number} [ms=0]
   * @returns {Promise<void>}
   */
  release(ms=0) {
    if ( this.#released ) return this.#released;
    if ( this.#done ) return (this.#released = Promise.resolve());
    const from = this.#gain;
    const begin = performance.now();
    this.#released = new Promise(resolve => {
      const step = () => {
        const k = ms > 0 ? Math.min(1, (performance.now() - begin) / ms) : 1;
        this.#gain = from * (1 - k);
        if ( !this.#done ) this.#apply();
        if ( k < 1 ) return;
        window.clearInterval(id);
        this.#stop();
        resolve();
      };
      const id = window.setInterval(step, SEGMENT_TICK_MS);
      step();
    });
    return this.#released;
  }

  /**
   * Stop at once and detach from the element.
   */
  dispose() {
    this.#stop();
    this.media.removeEventListener("ended", this.#onEnded);
  }

  /* -------------------------------------------- */

  #tick() {
    if ( this.#done ) return;
    const media = this.media;
    if ( media.ended || (media.currentTime >= (this.stopAt - 0.02)) ) return this.#finish();
    this.#apply();
  }

  /**
   * Set the volume and the picture opacity for the current position.
   */
  #apply() {
    const level = this.envelope(this.media.currentTime);
    this.media.volume = Math.clamp(this.volume * level * this.#gain, 0, 1);
    if ( this.picture ) this.picture.style.opacity = String(Math.round(level * 1000) / 1000);
  }

  #finish() {
    if ( this.#done ) return;
    if ( this.picture ) this.picture.style.opacity = String(this.envelope(this.stopAt));
    this.#stop();
    this.onEnd?.();
  }

  #stop() {
    this.#done = true;
    if ( this.#timer !== null ) window.clearInterval(this.#timer);
    this.#timer = null;
    if ( !this.media.paused ) this.media.pause();
  }
}

/* -------------------------------------------- */

/**
 * Draws items in random order without repeats until every item was used, then reshuffles.
 * The first item of a new round never repeats the last item of the previous one.
 */
export class ShuffleBag {
  /**
   * @param {string[]} items
   */
  constructor(items=[]) {
    this.items = Array.from(new Set(items));
    this.queue = [];
    this.last = null;
  }

  /**
   * Replace the item pool, keeping the last drawn item for the repeat check.
   * @param {string[]} items
   */
  setItems(items) {
    this.items = Array.from(new Set(items));
    this.queue = this.queue.filter(i => this.items.includes(i));
  }

  /**
   * Draw the next item.
   * @returns {string|null}
   */
  next() {
    if ( !this.items.length ) return null;
    if ( this.items.length === 1 ) return (this.last = this.items[0]);
    if ( !this.queue.length ) {
      this.queue = [...this.items];
      for ( let i = this.queue.length - 1; i > 0; i-- ) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
      }
      if ( this.queue[0] === this.last ) this.queue.push(this.queue.shift());
    }
    this.last = this.queue.shift();
    return this.last;
  }
}
