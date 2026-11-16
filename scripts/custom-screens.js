/**
 * Loading Screen System: custom loading screens.
 * Fork notice (Apache-2.0 §4b): added in 2026 by Drakul for Foundry VTT v14.
 *
 * A custom screen is a saved sequence shown instead of the default design: a full-screen video segment, an image or a
 * black screen on the loading overlay, optional music, then an optional camera move over a scene, with macros run at
 * chosen moments. A screen can have its own scene: playing it takes everyone there under the black screen. A scene can
 * use a screen in place of the default one; a GM can play one for everyone (everyone returns to the scene from before),
 * preview it alone, or play it on the way to another scene: the destination preloads while the screen plays and
 * everyone is forwarded to it when the screen ends. Escape or the stop button interrupts everything.
 */

import {MediaSegment, isVideo, parseTime} from "./compat.js?v=20261111c";

const MODULE_ID = "custom-loading-screen";

/** World setting holding the saved screens, keyed by id. */
export const SCREENS_SETTING = "customScreens";

/** World setting a GM writes to play a screen on every client. */
export const PLAY_SETTING = "customPlay";

/** Where the view sits inside the scene, as fractions of the room left over on each axis. */
export const ANCHORS = Object.freeze({
  "top-left": [0, 0],
  top: [0.5, 0],
  "top-right": [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  "bottom-left": [0, 1],
  bottom: [0.5, 1],
  "bottom-right": [1, 1]
});

/** How the camera zoom is chosen: fit the scene width, its height, the whole scene, or a fixed value. */
export const ZOOMS = Object.freeze(["width", "height", "scene", "custom"]);

/** Camera easings, mapped to CanvasAnimation easing names; null moves at constant speed. */
export const EASINGS = Object.freeze({inOut: "easeInOutCosine", out: "easeOutCubic", linear: null});

/**
 * Moments of a sequence: the screen appears, the scene appears (the overlay starts fading out and the camera starts),
 * the camera stops.
 */
export const MOMENTS = Object.freeze(["start", "media", "end"]);

/** What the music does when the screen ends before its segment: fade out, or play to the end of the segment. */
export const MUSIC_ENDS = Object.freeze(["fade", "finish"]);

/** How the last scene of a screen appears: the overlay fades out, or eyelids blink open over a blurred scene. */
export const REVEALS = Object.freeze(["fade", "blink"]);

/** How the screen covers the scene it starts over: the overlay fades in, or eyelids blink shut over a blurring scene. */
export const COVERS = Object.freeze(["fade", "blink"]);

/**
 * Size of the eye opening of the blink reveal, as the radii of an ellipse in percent of the screen.
 * @param {number} open     0 closed, 1 fully open
 * @returns {{"--ls-eye-w": string, "--ls-eye-h": string}}
 */
function eyeSize(open) {
  return {"--ls-eye-w": `${+(70 + (60 * (open ** 3))).toFixed(2)}%`, "--ls-eye-h": `${+(130 * open).toFixed(2)}%`};
}

/**
 * Register the eye opening sizes as percentages, so Web Animations interpolate them.
 */
function registerEyeSize() {
  for ( const name of ["--ls-eye-w", "--ls-eye-h"] ) {
    try {
      CSS.registerProperty({name, syntax: "<percentage>", inherits: false, initialValue: "0%"});
    } catch(err) {} // Already registered
  }
}

/** Seconds an image stays up when the screen has no duration. */
export const IMAGE_SECONDS = 6;

/** Video length the timeline assumes until the file reports its duration. */
const UNKNOWN_TIMELINE_S = 10;

/** Longest wait for a video to buffer before it starts. */
const BUFFER_TIMEOUT_MS = 8000;

/** Seconds a video may run past its segment before the sequence moves on anyway. */
const VIDEO_GRACE_S = 10;

/** Longest the driver waits for its own preload of a scene before switching to it. */
const PRELOAD_WAIT_MS = 20000;

/** Longest a client waits for a scene move, after the driver's preload wait, before going on over the current scene. */
const ARRIVAL_WAIT_MS = 45000;

/** Longest the driver waits for every connected client to report a scene drawn, counted from its own report. */
const SYNC_WAIT_MS = 15000;

/** User flag where a client reports the scene it has drawn, or the end of its preload, for a playback. */
const READY_FLAG = "customReady";

/** Key reported when a client has preloaded the scenes of a playback. */
const PRELOADED = "preloaded";

/** Milliseconds past its length that the blink shut may run late before the screen goes on anyway. */
const COVER_GRACE_MS = 4000;

/** Longest the reveal of a destination waits for a cinematic cut-in on screen to end. */
const CUTIN_WAIT_MS = 30000;

/** Fade used when a sequence is stopped or cut short. */
const RELEASE_MS = 300;

/** A click this soon after the click that turned the sound on does not also skip. */
const SOUND_CLICK_GRACE_MS = 600;

/** Seconds added to the expected length of a sequence before the safety timer ends it. */
const SAFETY_MARGIN_S = 60;

/** Video length assumed by the safety timer until the video reports its duration. */
const UNKNOWN_VIDEO_S = 600;

/** Name Foundry gives to camera pan animations. */
const PAN_ANIMATION = "canvas.animatePan";

/**
 * @typedef {object} CustomScreenMacro
 * @property {string} uuid        Macro UUID; empty rows are ignored
 * @property {string} when        One of MOMENTS
 * @property {number} delay       Seconds after the moment
 */

/**
 * @typedef {object} CustomScreenSegment
 * @property {boolean} enabled
 * @property {string} src               File path
 * @property {number} volume            Multiplied by each client's Music volume
 * @property {number} start             Seconds into the file where playback begins
 * @property {number} end               Seconds where it stops; 0 means the end of the file
 * @property {number} fadeIn            Seconds of fade-in (sound, and picture for a video or image)
 * @property {number} fadeOut           Seconds of fade-out before the end
 */

/**
 * @typedef {CustomScreenSegment} CustomScreenMusic
 * @property {string} when              One of MOMENTS
 * @property {number} delay             Seconds after the moment
 * @property {string} onEnd             One of MUSIC_ENDS
 */

/**
 * @typedef {object} CustomScreenData
 * @property {string} id
 * @property {string} name
 * @property {number} fadeIn            Seconds of the overlay fade-in
 * @property {number} fadeOut           Seconds of the overlay fade-out, when the scene appears
 * @property {number} duration          Seconds of an image (0: IMAGE_SECONDS) or of the black screen (0: the fade-in)
 * @property {string} scene             Scene the camera moves over when the screen is played; empty: the viewed one
 * @property {string} destination       Scene everyone is forwarded to when the screen ends, for a scene change
 * @property {boolean} skippable        Players may skip with a click or Escape
 * @property {boolean} firstLoad        Also used when Foundry opens or reloads on the scene
 * @property {CustomScreenSegment} media   Video or image; a video plays its segment
 * @property {CustomScreenMusic} music
 * @property {object} camera
 * @property {boolean} camera.enabled
 * @property {string} camera.from       Key of ANCHORS
 * @property {string} camera.to         Key of ANCHORS
 * @property {string} camera.zoom       One of ZOOMS
 * @property {number} camera.scale      Zoom used when camera.zoom is "custom"
 * @property {number} camera.duration   Seconds of the camera move
 * @property {string} camera.easing     Key of EASINGS
 * @property {boolean} hideInterface    Hide the interface and block input until the sequence ends
 * @property {number} interfaceDelay    Seconds the screen holds after the camera stops, before it ends or forwards
 * @property {CustomScreenMacro[]} macros
 */

/* -------------------------------------------- */
/*  Data                                        */
/* -------------------------------------------- */

/**
 * A finite number clamped to a range, or the fallback for empty and invalid input.
 * @param {*} value
 * @param {number} fallback
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
function toNumber(value, fallback, min=-Infinity, max=Infinity) {
  if ( (value === null) || (value === undefined) || (value === "") ) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.clamp(n, min, max) : fallback;
}

/**
 * Seconds from a number or a written time ("1:23.5"); 0 for empty and invalid input.
 * @param {*} value
 * @returns {number}
 */
function toTime(value) {
  const t = parseTime(value);
  return Number.isFinite(t) ? Math.round(Math.clamp(t, 0, 86400) * 1000) / 1000 : 0;
}

/**
 * Media of a screen saved before segments existed: a path, a volume and a duration that cut the video.
 * @param {object} data
 * @returns {object}
 */
function legacyMedia(data) {
  return {enabled: true, src: data.media, volume: data.volume, end: isVideo(data.media) ? data.duration : 0};
}

/**
 * Fill in and clean a screen. Macro rows without a macro are kept, so an editor can show them. Screens saved before
 * segments and music existed are converted.
 * @param {object} [data]
 * @returns {CustomScreenData}
 */
export function normalizeScreen(data={}) {
  const legacy = typeof data.media === "string";
  const media = legacy ? legacyMedia(data) : (data.media ?? {});
  const music = data.music ?? {};
  const camera = data.camera ?? {};
  const macros = Array.isArray(data.macros) ? data.macros : Object.values(data.macros ?? {});
  return {
    id: String(data.id || foundry.utils.randomID()),
    name: String(data.name ?? "").trim(),
    fadeIn: toNumber(data.fadeIn ?? data.fade, 1.5, 0, 30),
    fadeOut: toNumber(data.fadeOut ?? data.fade, 1.5, 0, 30),
    duration: toNumber((legacy && isVideo(data.media)) ? 0 : data.duration, 0, 0, 3600),
    scene: String(data.scene ?? "").trim(),
    destination: String(data.destination ?? "").trim(),
    showStage: data.showStage !== false,
    reveal: {
      style: REVEALS.includes(data.reveal?.style) ? data.reveal.style : "fade",
      blinks: Math.round(toNumber(data.reveal?.blinks, 2, 1, 5)),
      duration: toNumber(data.reveal?.duration, 4.5, 1, 30),
      blur: toNumber(data.reveal?.blur, 10, 0, 40)
    },
    cover: {
      style: COVERS.includes(data.cover?.style) ? data.cover.style : "fade",
      blinks: Math.round(toNumber(data.cover?.blinks, 2, 1, 5)),
      duration: toNumber(data.cover?.duration, 4.5, 1, 30),
      blur: toNumber(data.cover?.blur, 10, 0, 40)
    },
    skippable: data.skippable === true,
    firstLoad: data.firstLoad === true,
    media: {
      enabled: media.enabled !== false,
      src: String(media.src ?? "").trim(),
      volume: toNumber(media.volume, 1, 0, 1),
      start: toTime(media.start),
      end: toTime(media.end),
      fadeIn: toNumber(media.fadeIn, 0, 0, 60),
      fadeOut: toNumber(media.fadeOut, 0, 0, 60)
    },
    music: {
      enabled: music.enabled !== false,
      src: String(music.src ?? "").trim(),
      volume: toNumber(music.volume, 0.8, 0, 1),
      start: toTime(music.start),
      end: toTime(music.end),
      fadeIn: toNumber(music.fadeIn, 2, 0, 60),
      fadeOut: toNumber(music.fadeOut, 3, 0, 60),
      when: MOMENTS.includes(music.when) ? music.when : "start",
      delay: toNumber(music.delay, 0, 0, 600),
      onEnd: MUSIC_ENDS.includes(music.onEnd) ? music.onEnd : "fade"
    },
    camera: {
      enabled: camera.enabled !== false,
      from: Object.hasOwn(ANCHORS, camera.from) ? camera.from : "top",
      to: Object.hasOwn(ANCHORS, camera.to) ? camera.to : "bottom",
      zoom: ZOOMS.includes(camera.zoom) ? camera.zoom : "width",
      scale: toNumber(camera.scale, 1, 0.05, 5),
      duration: toNumber(camera.duration, 20, 0.5, 600),
      easing: Object.hasOwn(EASINGS, camera.easing) ? camera.easing : "inOut"
    },
    hideInterface: data.hideInterface !== false,
    interfaceDelay: toNumber(data.interfaceDelay, 0, 0, 600),
    macros: macros.map(m => ({
      uuid: String(m?.uuid ?? "").trim(),
      when: MOMENTS.includes(m?.when) ? m.when : "end",
      delay: toNumber(m?.delay, 0, 0, 600)
    }))
  };
}

/**
 * What the overlay shows: a video, an image, or black.
 * @param {CustomScreenData} screen
 * @returns {"video"|"image"|"black"}
 */
export function mediaKind(screen) {
  const {enabled, src} = screen.media;
  if ( !enabled || !src ) return "black";
  return isVideo(src) ? "video" : "image";
}

/**
 * Does the screen play music?
 * @param {CustomScreenData} screen
 * @returns {boolean}
 */
export function hasMusic(screen) {
  return screen.music.enabled && !!screen.music.src;
}

/**
 * Seconds an image or the black screen stays up. The overlay is always fully faded in before the scene appears.
 * @param {CustomScreenData} screen
 * @returns {number}
 */
export function shownSeconds(screen) {
  const seconds = (mediaKind(screen) === "image") ? (screen.duration || IMAGE_SECONDS) : screen.duration;
  return Math.max(seconds, coverSeconds(screen));
}

/**
 * Seconds until the screen fully covers the scene it starts over: its fade-in, or the blink shut.
 * @param {CustomScreenData} screen
 * @returns {number}
 */
export function coverSeconds(screen) {
  return (screen.cover.style === "blink") ? screen.cover.duration : screen.fadeIn;
}

/**
 * Is the screen forwarded to a destination at the end?
 * @param {CustomScreenData} screen
 * @returns {boolean}
 */
export function forwards(screen) {
  return !!screen.destination && (screen.destination !== screen.scene);
}

/**
 * Is the screen's own scene shown? Without it, the black screen goes straight on to the destination.
 * @param {CustomScreenData} screen
 * @returns {boolean}
 */
export function showsStage(screen) {
  return screen.showStage || !forwards(screen);
}

/**
 * Seconds of the last reveal of a screen: its fade-out, or the blink.
 * @param {CustomScreenData} screen
 * @returns {number}
 */
export function lastRevealSeconds(screen) {
  return (screen.reveal.style === "blink") ? screen.reveal.duration : screen.fadeOut;
}

/**
 * Keyframes of an eyelid blink: from closed, each blink opens a little wider and closes again, then the eyes open.
 * @param {number} blinks
 * @returns {{offset: number, open: number}[]}   open goes from 0 (closed) to 1 (fully open)
 */
export function blinkFrames(blinks) {
  const steps = [[0, 0]];
  for ( let i = 0; i < blinks; i++ ) {
    const open = 0.14 + (0.32 * (blinks > 1 ? i / (blinks - 1) : 0));
    steps.push([1.5, open], [0.25, open], [0.6, 0], [0.35, 0]);
  }
  steps.push([2.2, 1]);
  const total = steps.reduce((sum, [w]) => sum + w, 0);
  let at = 0;
  return steps.map(([w, open]) => {
    at += w;
    return {offset: Math.min(1, at / total), open};
  });
}

/** Seconds of one blink of the first cover: closing, shut, opening again. Real blinks take about a third of a second. */
const BLINK_S = Object.freeze({close: 0.09, shut: 0.06, open: 0.15});

/** Seconds of the last closing of the first cover, and of staying shut before the screen is plain black. */
const FALL_S = Object.freeze({close: 0.45, shut: 0.25});

/**
 * Keyframes of eyelids blinking shut: from open, quick blinks, each opening again less wide, then the eyes fall shut.
 * The blinks keep their real speed; the time left goes to the open stretches between them.
 * @param {number} blinks
 * @param {number} seconds    Length of the whole cover
 * @returns {{offset: number, open: number}[]}   open goes from 0 (closed) to 1 (fully open)
 */
export function closeFrames(blinks, seconds) {
  const blink = BLINK_S.close + BLINK_S.shut + BLINK_S.open;
  const fixed = (blinks * blink) + FALL_S.close + FALL_S.shut;
  const hold = Math.max(0.15, (seconds - fixed) / (blinks + 1));
  const steps = [[0, 1], [hold, 1]];
  for ( let i = 0; i < blinks; i++ ) {
    const open = 0.75 - (0.45 * (blinks > 1 ? i / (blinks - 1) : 0));
    steps.push([BLINK_S.close, 0], [BLINK_S.shut, 0], [BLINK_S.open, open], [hold, open]);
  }
  steps.push([FALL_S.close, 0], [FALL_S.shut, 0]);
  const total = steps.reduce((sum, [w]) => sum + w, 0);
  let at = 0;
  return steps.map(([w, open]) => {
    at += w;
    return {offset: Math.min(1, at / total), open};
  });
}

/**
 * Seconds of a segment once the file duration is known.
 * @param {CustomScreenSegment} segment
 * @param {number} duration     File duration in seconds; NaN when unknown
 * @returns {number}            NaN when unknown
 */
export function segmentLength(segment, duration) {
  if ( !Number.isFinite(duration) ) return NaN;
  const end = segment.end > segment.start ? Math.min(segment.end, duration) : duration;
  return Math.max(0, end - segment.start);
}

/**
 * @typedef {object} CustomScreenTimeline
 * @property {"video"|"image"|"black"} kind
 * @property {number} shown         Seconds of the video, image or black screen
 * @property {boolean} known        False while the video length is unknown; shown is then an estimate
 * @property {boolean} stage        Everyone is first taken to the screen's own scene; its loading time is not counted
 * @property {boolean} forward      Everyone is forwarded to the destination after the hold
 * @property {boolean} shownStage   The screen's own scene appears; otherwise the black screen goes on to the destination
 * @property {number} camera        Seconds from the scene appearing until the camera stops
 * @property {number} hold          Seconds the screen holds after the camera
 * @property {number} away          Seconds of the cover and the reveal around the forward, without its loading time
 * @property {number} close         Seconds from the start until the screen ends
 * @property {Record<string, number>} moments   Seconds of each moment from the start, and of the forward
 * @property {{at: number, until: number, length: number, fades: boolean}|null} music
 *           Music start and stop; until is NaN while its length is unknown
 * @property {{at: number, uuid: string, when: string}[]} macros
 * @property {number} total         Seconds the timeline spans
 */

/**
 * When each part of a screen happens, measured from the moment it appears.
 * @param {CustomScreenData} screen
 * @param {object} [lengths]
 * @param {number} [lengths.media]    Seconds of the video file; NaN when unknown
 * @param {number} [lengths.music]    Seconds of the music file; NaN when unknown
 * @returns {CustomScreenTimeline}
 */
export function timelineOf(screen, {media=NaN, music=NaN}={}) {
  const kind = mediaKind(screen);
  let shown = shownSeconds(screen);
  let known = true;
  if ( kind === "video" ) {
    const length = segmentLength(screen.media, media);
    known = Number.isFinite(length);
    shown = known ? length : UNKNOWN_TIMELINE_S;
  }
  const forward = forwards(screen);
  const shownStage = showsStage(screen);
  const reveal = forward ? screen.fadeOut : lastRevealSeconds(screen);
  const camera = !shownStage ? 0 : (screen.camera.enabled ? Math.max(screen.camera.duration, reveal) : reveal);
  const hold = shownStage ? screen.interfaceDelay : 0;
  const away = forward ? (shownStage ? screen.fadeIn : 0) + lastRevealSeconds(screen) : 0;
  const moments = {start: 0, media: shown, end: shown + camera, forward: shown + camera + hold};
  const close = moments.forward + away;

  let track = null;
  if ( hasMusic(screen) ) {
    const m = screen.music;
    const at = moments[m.when] + m.delay;
    const length = segmentLength(m, music);
    const fades = m.onEnd === "fade";
    if ( !fades || (at < close) ) {
      let until = at + length;
      if ( fades ) until = Number.isFinite(until) ? Math.min(until, close + m.fadeOut) : close + m.fadeOut;
      track = {at, until, length, fades};
    }
  }

  const macros = screen.macros.filter(m => m.uuid).map(m => ({at: moments[m.when] + m.delay, uuid: m.uuid, when: m.when}));
  const ends = [close, ...macros.map(m => m.at)];
  if ( track ) ends.push(Number.isFinite(track.until) ? track.until : track.at + UNKNOWN_TIMELINE_S);
  return {kind, shown, known, stage: !!screen.scene, forward, shownStage, camera, hold, away, close, moments, music: track, macros,
    total: Math.max(...ends, 1)};
}

/**
 * The saved custom screens.
 */
export class CustomScreens {
  /**
   * Every saved screen, sorted by name.
   * @returns {CustomScreenData[]}
   */
  static all() {
    const stored = game.settings.get(MODULE_ID, SCREENS_SETTING) ?? {};
    return Object.entries(stored)
      .map(([id, data]) => normalizeScreen({...data, id}))
      .sort((a, b) => this.label(a).localeCompare(this.label(b), game.i18n.lang));
  }

  /**
   * A saved screen by id or, failing that, by name (case-insensitive).
   * @param {string} key
   * @returns {CustomScreenData|null}
   */
  static get(key) {
    if ( !key || (typeof key !== "string") ) return null;
    const all = this.all();
    const lower = key.toLowerCase();
    return all.find(s => s.id === key) ?? all.find(s => s.name.toLowerCase() === lower) ?? null;
  }

  /**
   * Replace the saved screens. Macro rows without a macro are dropped.
   * @param {CustomScreenData[]} screens
   * @returns {Promise<void>}
   */
  static async save(screens) {
    const stored = {};
    for ( const screen of screens ) {
      const clean = normalizeScreen(screen);
      clean.macros = clean.macros.filter(m => m.uuid);
      stored[clean.id] = clean;
    }
    await game.settings.set(MODULE_ID, SCREENS_SETTING, stored);
  }

  /**
   * Name to display for a screen.
   * @param {CustomScreenData|null} screen
   * @returns {string}
   */
  static label(screen) {
    return screen?.name || game.i18n.localize("LOADING_SCREEN.Custom.Untitled");
  }

  /**
   * Choices for a select element, id to name.
   * @returns {Record<string, string>}
   */
  static choices() {
    return Object.fromEntries(this.all().map(s => [s.id, this.label(s)]));
  }
}

/* -------------------------------------------- */
/*  Camera                                      */
/* -------------------------------------------- */

/**
 * Canvas view that lines the screen up with a part of the viewed scene.
 * Along an axis where the scene is smaller than the screen, the view is centered.
 * @param {string} anchor                         Key of ANCHORS
 * @param {CustomScreenData["camera"]} camera
 * @returns {{x: number, y: number, scale: number}}
 */
export function cameraView(anchor, camera) {
  const d = canvas.dimensions;
  const rect = d.sceneRect;
  const [width, height] = canvas.screenDimensions ?? [window.innerWidth, window.innerHeight];
  let scale;
  switch ( camera.zoom ) {
    case "height": scale = height / rect.height; break;
    case "scene": scale = Math.min(width / rect.width, height / rect.height); break;
    case "custom": scale = camera.scale; break;
    default: scale = width / rect.width;
  }
  scale = Math.clamp(scale, d.scale.min, d.scale.max);
  const [fx, fy] = Object.hasOwn(ANCHORS, anchor) ? ANCHORS[anchor] : ANCHORS.center;
  const place = (start, length, half, f) => {
    if ( length <= (2 * half) ) return start + (length / 2);
    return start + half + (f * (length - (2 * half)));
  };
  return {
    x: place(rect.x, rect.width, width / (2 * scale), fx),
    y: place(rect.y, rect.height, height / (2 * scale), fy),
    scale
  };
}


/* -------------------------------------------- */
/*  Session                                     */
/* -------------------------------------------- */

/**
 * Stop a media element and drop its source.
 * @param {HTMLMediaElement|null} media
 */
function unload(media) {
  if ( !media ) return;
  media.pause();
  media.removeAttribute("src");
  media.load();
}

/**
 * One playback of a custom screen on this client: media on the overlay, then the reveal with the camera move, then a
 * hold for what the macros show, then, with a destination, a black cover while everyone is forwarded to it; the
 * destination appears once a cinematic cut-in on screen has ended. Before anything plays, every client preloads the
 * screen's scene and the destination behind the black overlay. When a playback for everyone moves scenes, each client
 * reports in its user flags when its preload ends and when each scene is drawn; the driver gives each start, through
 * the play setting, once every connected client has reported or SYNC_WAIT_MS has passed, so all begin and reveal
 * together.
 * Music plays alongside from a chosen moment. Scene moves are made by one client, the driver (the active GM's client,
 * or the previewing client, which only moves its own view); every client keeps its overlay up until the scene it waits
 * for is drawn. Macros run on the active GM's client, or on the previewing client.
 */
export class CustomSession {
  /**
   * @param {object} manager                    The LoadingScreenManager
   * @param {Scene|null} scene                  The scene being loaded, or the viewed one
   * @param {CustomScreenData} screen
   * @param {object} [options]
   * @param {boolean} [options.preview=false]   Shown on this client only; its macros run here and are told so
   * @param {boolean} [options.manual=false]    Played without loading a scene
   * @param {string|null} [options.stage]       Id of the scene the camera moves over, reached under the black screen
   * @param {string|null} [options.forward]     Id of the scene to go to when the screen ends
   * @param {string|null} [options.run]         Id of a playback for everyone, which synchronizes its scene reveals
   */
  constructor(manager, scene, screen, {preview=false, manual=false, stage=null, forward=null, run=null}={}) {
    this.manager = manager;
    this.scene = scene ?? null;
    this.screen = screen;
    this.preview = preview;
    this.manual = manual || preview;
    this.custom = true;

    /** @type {string|null} Scene the camera moves over */
    this.stageTo = stage ? String(stage) : null;

    /** @type {string|null} Scene this client goes to when the screen ends */
    this.forwardTo = forward ? String(forward) : null;

    /** @type {string|null} Playback for everyone whose scene reveals are synchronized */
    this.run = (!preview && run) ? String(run) : null;

    /** @type {string|null} Scene of the screen, kept after the move to it */
    this.stageGate = this.stageTo;

    this.startedAt = performance.now();
    const away = !!this.stageTo && !(canvas.ready && (canvas.scene?.id === this.stageTo));
    this.readyAt = (this.manual && !away) ? this.startedAt : null;

    /** @type {"media"|"camera"|"hold"|"forward"|"done"} */
    this.phase = "media";
    this.closed = false;
    this.disposed = false;

    /** @type {HTMLElement|null} */
    this.element = null;

    /** @type {HTMLVideoElement|null} */
    this.video = null;

    /** @type {MediaSegment|null} */
    this.mediaSegment = null;

    /** @type {MediaSegment|null} */
    this.musicSegment = null;
  }

  /** @type {Set<number>} Timers that end with the session */
  #timeouts = new Set();

  /** @type {Set<number>} Delayed macros; they still run after a normal end, not after dispose or stop */
  #macroTimers = new Set();

  /** @type {Set<number>} Delayed music start; kept after a normal end when the music plays to its end */
  #musicTimers = new Set();

  /** @type {Function[]} */
  #listeners = [];

  /** @type {number|null} */
  #safety = null;

  /** @type {string|null} Scene this client waits for */
  #awaiting = null;

  /** @type {number|null} Gives up waiting for a scene */
  #arrival = null;

  /** @type {Map<string, Promise<void>>} Preloads started by the driver */
  #preloads = new Map();

  /** @type {Set<string>} Scenes the driver gave the start for */
  #go = new Set();

  /** @type {Map<string, Function[]>} Waiting for the start of a scene */
  #goWaiters = new Map();

  /** @type {Set<string>} Scenes this client reported */
  #reported = new Set();

  /** @type {Set<string>} Scenes the driver collects reports for */
  #collecting = new Set();

  /** When the current overlay started to fade in, from performance.now(). */
  #coveredFrom = 0;

  /** When the current fade-out of the overlay ends, from performance.now(). */
  #fadeEnds = null;

  /** @type {number|null} */
  #holdTimer = null;

  /** @type {HTMLElement|null} */
  #picture = null;

  /** @type {Animation|null} */
  #overlayAnimation = null;

  /** @type {Animation|null} Blur on the canvas element during the blink reveal; it ends at no blur */
  #blur = null;

  /** @type {HTMLButtonElement|null} */
  #stopButton = null;

  /** @type {Promise<boolean>} */
  #musicReady = Promise.resolve(false);

  #musicStarted = false;

  /** When the music was meant to start, from performance.now(). */
  #musicAt = 0;

  /** @type {Set<"video"|"music">} Sound the browser refused to start */
  #soundPending = new Set();

  /** @type {HTMLElement|null} */
  #soundHint = null;

  #soundAt = -Infinity;
  #mediaDone = false;
  #revealed = false;
  #cameraDone = false;
  #arrived = false;
  #ownsInterface = false;

  /** @type {{x: number, y: number, scale: number}|null} */
  #target = null;

  /* -------------------------------------------- */

  /**
   * Build the overlay, start the media and move to the screen's scene.
   * @returns {Promise<void>}
   */
  async start() {
    const s = this.screen;
    const el = this.#mountOverlay({first: true});
    const kind = mediaKind(s);
    if ( kind === "video" ) this.#mountVideo(el);
    else if ( kind === "image" ) this.#mountImage(el);
    this.#listen(window, "keydown", event => this.#onKeyDown(event), {capture: true});
    document.body.classList.toggle("ls-block-notifications", !!game.settings.get(MODULE_ID, "blockNotifications"));
    if ( s.hideInterface ) this.#hideInterface();
    this.#mountStopButton();
    this.#armSafety();
    await this.#preloadScenes();
    if ( this.closed ) return;
    this.startedAt = performance.now();
    if ( hasMusic(s) ) {
      this.manager.stopLingeringAudio(400);
      this.#prepareMusic();
    }
    if ( this.stageTo ) {
      const there = this.#at(this.stageTo);
      this.#goTo(this.stageTo);
      if ( there ) this.#report(this.stageTo);
    }
    this.#armSafety();
    this.#runMoment("start");
    await this.#playMedia();
  }

  /* -------------------------------------------- */

  /**
   * A scene finished drawing. While a scene move is pending, only the scene waited for counts.
   */
  markReady() {
    if ( this.closed ) return;
    const awaiting = this.#awaiting;
    if ( awaiting ) {
      if ( !this.#at(awaiting) ) return;
      this.#awaiting = null;
      this.#clearArrival();
    }
    if ( this.phase === "forward" ) return this.#arrive();
    if ( awaiting ) this.#report(awaiting);
    this.readyAt ??= performance.now();
    this.#maybeReveal();
  }

  /* -------------------------------------------- */

  /**
   * The canvas is torn down for another scene. Keep playing when it is the scene this session waits for.
   * @param {Scene} next
   * @returns {boolean}     Whether this session handles the scene change
   */
  onTransition(next) {
    if ( this.closed || !this.#awaiting || (next?.id !== this.#awaiting) ) return false;
    this.scene = next;
    if ( this.phase !== "forward" ) this.readyAt = null;
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Move on to the next phase: end the media, finish the camera move, or end the hold.
   */
  skip() {
    if ( this.closed ) return;
    if ( !this.#mediaDone ) return this.#endMedia();
    if ( !this.#revealed ) return; // Waiting for the scene
    if ( !this.#cameraDone ) {
      foundry.canvas.animation.CanvasAnimation.terminateAnimation(PAN_ANIMATION);
      if ( this.#target && canvas.ready ) canvas.pan(this.#target);
      return this.#finishCamera();
    }
    if ( this.phase !== "hold" ) return;
    if ( this.#holdTimer !== null ) {
      window.clearTimeout(this.#holdTimer);
      this.#timeouts.delete(this.#holdTimer);
    }
    this.#afterHold();
  }

  /* -------------------------------------------- */

  /**
   * End the sequence: fade the overlay out if it is still up and give the interface back. Delayed macros still run;
   * music fades out or plays to the end of its segment.
   */
  close() {
    if ( this.closed ) return;
    this.closed = true;
    this.phase = "done";
    this.#awaiting = null;
    this.#stopTimers();
    if ( this.#revealed && !this.#cameraDone ) {
      foundry.canvas.animation.CanvasAnimation.terminateAnimation(PAN_ANIMATION);
    }
    this.#fadeOut();
    this.#endMusic(false);
    this.#restoreInterface();
    this.#dropSoundHint();
    this.#removeStopButton();
    this.#unlisten();
    if ( this.manager.session === this ) this.manager.session = null;
  }

  /* -------------------------------------------- */

  /**
   * Interrupt everything at once: overlay, media, music, camera, pending macros and scene moves. The scene stays the one
   * this client shows.
   */
  stop() {
    if ( this.closed ) return;
    this.closed = true;
    this.disposed = true;
    this.phase = "done";
    this.#awaiting = null;
    this.#stopTimers();
    for ( const id of this.#macroTimers ) window.clearTimeout(id);
    this.#macroTimers.clear();
    if ( this.#revealed && !this.#cameraDone ) {
      foundry.canvas.animation.CanvasAnimation.terminateAnimation(PAN_ANIMATION);
    }
    this.#endMusic(true);
    this.#cancelBlur();
    this.#fadeOut(RELEASE_MS);
    this.#restoreInterface();
    this.#dropSoundHint();
    this.#removeStopButton();
    this.#unlisten();
    if ( this.manager.session === this ) this.manager.session = null;
  }

  /* -------------------------------------------- */

  /**
   * Remove everything at once, for example when another scene starts loading. Delayed macros are cancelled.
   */
  dispose() {
    this.closed = true;
    this.disposed = true;
    this.phase = "done";
    this.#awaiting = null;
    this.#stopTimers();
    for ( const id of this.#macroTimers ) window.clearTimeout(id);
    this.#macroTimers.clear();
    if ( this.#revealed && !this.#cameraDone ) {
      foundry.canvas.animation.CanvasAnimation.terminateAnimation(PAN_ANIMATION);
    }
    this.#endMusic(true);
    this.#cancelBlur();
    this.#releaseVideo(RELEASE_MS);
    this.element?.remove();
    this.element = null;
    this.#restoreInterface({instant: true});
    this.#dropSoundHint();
    this.#removeStopButton();
    this.#unlisten();
  }

  /* -------------------------------------------- */
  /*  Overlay and Media                           */
  /* -------------------------------------------- */

  /**
   * Add a black overlay that fades in over the canvas.
   * @returns {HTMLElement}
   */
  #mountOverlay({first=false}={}) {
    const el = this.element = document.createElement("div");
    el.id = "loading-screen-overlay";
    el.className = "loading-screen ls-custom";
    if ( this.screen.skippable ) el.classList.add("ls-custom-skippable");
    this.#listen(el, "click", () => this.#onClick());
    document.body.classList.add("loading-screen-active");
    document.body.append(el);
    this.#coveredFrom = performance.now();
    this.#fadeEnds = null;
    this.#coverMs = this.screen.fadeIn * 1000;
    this.#shut = null;
    if ( first && (this.screen.cover.style === "blink") ) {
      this.#overlayAnimation = el.animate([{opacity: 1}, {opacity: 1}], {duration: 1, fill: "both"});
      this.#closeUp(el);
    }
    else this.#overlayAnimation = el.animate([{opacity: 0}, {opacity: 1}],
      {duration: this.#coverMs, easing: "ease-in", fill: "both"});
    return el;
  }

  /** Milliseconds the current overlay takes to cover the scene. */
  #coverMs = 0;

  /**
   * Cover the scene by blinking shut: the overlay is opaque from the start with a transparent background, and a black
   * layer with an eye-shaped hole closes over the scene in blinks while the canvas blurs. Once shut, the layer goes and
   * the overlay is plain black; the blur comes off the canvas, which is hidden by then.
   * @param {HTMLElement} el
   */
  #closeUp(el) {
    const c = this.screen.cover;
    const ms = this.#coverMs = c.duration * 1000;
    const frames = closeFrames(c.blinks, c.duration);
    registerEyeSize();
    const lids = document.createElement("div");
    lids.className = "ls-eyelids";
    el.append(lids);
    const shut = lids.animate(frames.map(f => ({offset: f.offset, ...eyeSize(f.open)})),
      {duration: ms, easing: "linear", fill: "forwards"});
    el.classList.add("ls-blink");
    const board = canvas.app?.canvas ?? canvas.app?.view;
    if ( (c.blur > 0) && board ) {
      const blur = f => `blur(${+(c.blur * (f.offset ** 1.2)).toFixed(2)}px)`;
      this.#cancelBlur();
      this.#blur = board.animate(frames.map(f => ({offset: f.offset, filter: blur(f)})),
        {duration: ms, easing: "linear", fill: "forwards"});
    }
    // The animation's own end, not a timer: loading the next scenes can hold frames back, and the scene must not
    // change behind eyes that are still open. A timer well past the end covers an animation that never finishes.
    const done = () => {
      if ( this.element !== el ) return;
      lids.remove();
      el.classList.remove("ls-blink");
      this.#cancelBlur();
    };
    this.#shut = Promise.race([shut.finished.catch(() => null), this.#wait(ms + COVER_GRACE_MS)]).then(done);
  }

  /** @type {Promise<void>|null} Resolves once the eyelids of the first cover are shut */
  #shut = null;

  /**
   * Resolve once the current overlay has finished fading in.
   * @returns {Promise<void>}
   */
  #covered() {
    if ( this.#shut ) return this.#shut;
    const left = this.#coverMs - (performance.now() - this.#coveredFrom);
    return left > 0 ? this.#wait(left) : Promise.resolve();
  }

  /**
   * Fade the overlay out from its current opacity and remove it; the video fades along and is unloaded. A shorter fade
   * replaces a longer one in progress.
   * @param {number} [ms]   Defaults to the screen's fade-out
   * @returns {number}       Milliseconds until the overlay is gone
   */
  #fadeOut(ms=this.screen.fadeOut * 1000) {
    const el = this.element;
    if ( !el ) return 0;
    const ends = performance.now() + ms;
    if ( (this.#fadeEnds !== null) && (this.#fadeEnds <= ends) ) return Math.max(0, this.#fadeEnds - performance.now());
    this.#fadeEnds = ends;
    const from = Number(getComputedStyle(el).opacity);
    this.#overlayAnimation?.cancel();
    el.classList.add("fade-out");
    this.#overlayAnimation = el.animate([{opacity: Number.isFinite(from) ? from : 1}, {opacity: 0}],
      {duration: ms, easing: "ease-out", fill: "forwards"});
    this.#releaseVideo(ms);
    this.#removeOverlay(el, ms);
    return ms;
  }

  /**
   * The last reveal of the screen: the overlay fades out, or eyelids blink open while the scene behind comes into
   * focus. The overlay stays opaque; its background turns transparent and a black layer with an eye-shaped hole covers
   * the scene instead. The blur is a CSS filter on the canvas element rather than a backdrop filter on the overlay,
   * which performance settings such as Prime Performance's "Disable background blur effects" turn off.
   * @returns {number}       Milliseconds until the overlay is gone
   */
  #openUp() {
    const el = this.element;
    const r = this.screen.reveal;
    if ( (r.style !== "blink") || !el || (this.#fadeEnds !== null) ) return this.#fadeOut();
    const ms = r.duration * 1000;
    this.#fadeEnds = performance.now() + ms;
    this.#releaseVideo(RELEASE_MS);
    const frames = blinkFrames(r.blinks);
    registerEyeSize();
    const lids = document.createElement("div");
    lids.className = "ls-eyelids";
    el.append(lids);
    lids.animate(frames.map(f => ({offset: f.offset, ...eyeSize(f.open)})),
      {duration: ms, easing: "linear", fill: "forwards"});
    el.classList.add("ls-blink");
    const board = canvas.app?.canvas ?? canvas.app?.view;
    if ( (r.blur > 0) && board ) {
      const blur = f => `blur(${+(r.blur * (1 - f.offset) ** 1.5).toFixed(2)}px)`;
      this.#cancelBlur();
      this.#blur = board.animate(frames.map(f => ({offset: f.offset, filter: blur(f)})),
        {duration: ms, easing: "linear"});
    }
    this.#removeOverlay(el, ms);
    return ms;
  }

  /**
   * Take the blur of the blink reveal off the canvas.
   */
  #cancelBlur() {
    this.#blur?.cancel();
    this.#blur = null;
  }

  /**
   * Remove an overlay after a delay; the page leaves the loading state unless a newer overlay or session is up.
   * @param {HTMLElement} el
   * @param {number} ms
   */
  #removeOverlay(el, ms) {
    window.setTimeout(() => {
      el.remove();
      if ( this.element === el ) this.element = null;
      if ( this.element ) return; // A newer overlay of this session is up
      if ( this.manager.session && (this.manager.session !== this) ) return;
      document.body.classList.remove("loading-screen-active", "ls-block-notifications");
    }, ms);
  }

  /**
   * @param {HTMLElement} el
   */
  #mountVideo(el) {
    const video = this.video = document.createElement("video");
    video.className = "ls-custom-media";
    video.preload = "auto";
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.style.opacity = "0";
    video.src = this.screen.media.src;
    el.append(video);
    this.#listen(video, "error", () => {
      console.warn(`Loading Screen | Could not play "${this.screen.media.src}"`, video.error);
      this.#endMedia();
    });
    this.#listen(video, "loadedmetadata", () => this.#armSafety());
  }

  /**
   * @param {HTMLElement} el
   */
  #mountImage(el) {
    const image = this.#picture = document.createElement("div");
    image.className = "ls-custom-media ls-custom-image";
    image.style.backgroundImage = `url(${JSON.stringify(this.screen.media.src)})`;
    el.append(image);
  }

  /**
   * Show the media: a video plays its segment; an image or the black screen stays up for its duration.
   * @returns {Promise<void>}
   */
  async #playMedia() {
    if ( this.video ) return this.#playVideo();
    const seconds = shownSeconds(this.screen);
    if ( this.#picture ) this.#fadePicture(this.#picture, seconds);
    this.#after(seconds * 1000, () => this.#endMedia());
  }

  /**
   * Fade an image in and out over the time it is shown.
   * @param {HTMLElement} picture
   * @param {number} seconds
   */
  #fadePicture(picture, seconds) {
    const m = this.screen.media;
    const total = seconds * 1000;
    if ( !(total > 0) || (!m.fadeIn && !m.fadeOut) ) return;
    const fadeIn = Math.min(m.fadeIn * 1000, total);
    const fadeOut = Math.min(m.fadeOut * 1000, total - fadeIn);
    picture.animate([
      {opacity: fadeIn ? 0 : 1, offset: 0},
      {opacity: 1, offset: fadeIn / total},
      {opacity: 1, offset: (total - fadeOut) / total},
      {opacity: fadeOut ? 0 : 1, offset: 1}
    ], {duration: total, fill: "forwards"});
  }

  /**
   * Play the video segment, muted with an offer to turn the sound on when the browser refuses sound.
   * @returns {Promise<void>}
   */
  async #playVideo() {
    const m = this.screen.media;
    const video = this.video;
    const segment = this.mediaSegment = new MediaSegment(video, {
      start: m.start,
      end: m.end,
      fadeIn: m.fadeIn,
      fadeOut: m.fadeOut,
      volume: this.#volumeFor(m.volume),
      picture: video,
      onEnd: () => this.#endMedia()
    });
    try {
      await segment.prepare();
    } catch(err) {
      console.warn("Loading Screen | Custom screen video failed", err);
      return this.#endMedia();
    }
    if ( this.closed || this.#mediaDone ) return;
    await this.#buffered(video);
    if ( this.closed || this.#mediaDone ) return;
    video.muted = segment.volume <= 0;
    try {
      await segment.play();
    } catch(err) {
      if ( this.closed || this.#mediaDone ) return;
      if ( err?.name !== "NotAllowedError" ) return this.#endMedia();
      video.muted = true;
      try {
        await segment.play();
      } catch {
        return this.#endMedia();
      }
      if ( segment.volume > 0 ) this.#offerSound("video");
    }
    if ( this.closed || this.#mediaDone ) return;
    if ( Number.isFinite(segment.length) ) this.#after((segment.length + VIDEO_GRACE_S) * 1000, () => this.#endMedia());
    this.#armSafety();
  }

  /**
   * Resolve once the video can play through, fails, or the buffering wait runs out.
   * @param {HTMLVideoElement} video
   * @returns {Promise<void>}
   */
  #buffered(video) {
    if ( video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA ) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        window.clearTimeout(timer);
        video.removeEventListener("canplaythrough", done);
        video.removeEventListener("error", done);
        resolve();
      };
      const timer = window.setTimeout(done, BUFFER_TIMEOUT_MS);
      video.addEventListener("canplaythrough", done);
      video.addEventListener("error", done);
    });
  }

  /**
   * Volume on this client.
   * @param {number} volume   Volume of the screen
   * @returns {number}
   */
  #volumeFor(volume) {
    if ( game.audio?.globalMute ) return 0;
    const music = Number(game.settings.get("core", "globalPlaylistVolume") ?? 1);
    return Math.clamp(volume * (Number.isFinite(music) ? music : 1), 0, 1);
  }

  /**
   * Fade the video's sound out, then drop its source.
   * @param {number} ms
   */
  #releaseVideo(ms) {
    const video = this.video;
    if ( !video ) return;
    this.video = null;
    const segment = this.mediaSegment;
    if ( segment && !segment.done ) segment.release(ms).then(() => unload(video));
    else window.setTimeout(() => unload(video), ms);
  }

  #endMedia() {
    if ( this.#mediaDone || this.closed ) return;
    this.#mediaDone = true;
    this.#soundPending.delete("video");
    this.#refreshSoundHint();
    this.#maybeReveal();
  }

  /* -------------------------------------------- */
  /*  Scene Moves                                 */
  /* -------------------------------------------- */

  /**
   * The client that moves scenes: the previewing client for its own view, otherwise the active GM's client.
   * @returns {boolean}
   */
  #drives() {
    return this.preview || !!game.users.activeGM?.isSelf;
  }

  /**
   * This client shows a scene, fully drawn.
   * @param {string} id
   * @returns {boolean}
   */
  #at(id) {
    return canvas.ready && (canvas.scene?.id === id);
  }

  /**
   * Preload the screen's scene and the destination on this client, behind the black overlay, then, in a playback for
   * everyone, wait for the start that follows every client's preload.
   * @returns {Promise<void>}
   */
  async #preloadScenes() {
    for ( const id of [this.stageTo, this.forwardTo] ) {
      if ( !id || this.#preloads.has(id) || !game.scenes.get(id) ) continue;
      this.#preloads.set(id, Promise.resolve(game.scenes.preload(id))
        .catch(err => console.warn(`Loading Screen | Could not preload the scene ${id}`, err)));
    }
    if ( !this.#preloads.size ) return;
    await Promise.race([Promise.all(this.#preloads.values()), this.#wait(PRELOAD_WAIT_MS)]);
    if ( this.closed || !this.run ) return;
    this.#report(PRELOADED);
    await this.#started(PRELOADED);
  }

  /**
   * Take this client to a scene: wait until it is drawn, while the driver switches to it.
   * @param {string} id
   */
  #goTo(id) {
    if ( !this.#at(id) ) {
      this.#awaiting = id;
      this.#clearArrival();
      this.#arrival = this.#after(PRELOAD_WAIT_MS + ARRIVAL_WAIT_MS, () => this.#abandonMove());
    }
    if ( !this.#drives() ) return;
    this.#switchTo(id).catch(err => {
      console.error("Loading Screen | Could not change the scene", err);
      this.#abandonMove();
    });
  }

  /**
   * Switch to a scene once the overlay covers the canvas and the preload finished or ran out of time: a preview views
   * it, otherwise it is activated, which moves every client.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async #switchTo(id) {
    const scene = game.scenes.get(id);
    if ( !scene ) return this.#abandonMove();
    const viewing = canvas.scene?.id === id;
    if ( this.preview ? viewing : (scene.active && viewing) ) return;
    await this.#covered();
    const preload = this.#preloads.get(id);
    if ( preload ) await Promise.race([preload, this.#wait(PRELOAD_WAIT_MS)]);
    if ( this.closed ) return;
    if ( this.preview || scene.active ) await scene.view();
    else await scene.activate();
    if ( this.#at(id) ) this.markReady();
  }

  /**
   * The scene waited for did not arrive: go on over the scene this client shows.
   */
  #abandonMove() {
    if ( this.closed || !this.#awaiting ) return;
    console.warn("Loading Screen | The scene change did not happen; the custom screen goes on over the current scene");
    this.#awaiting = null;
    this.#clearArrival();
    this.scene = canvas.scene ?? null;
    if ( this.phase === "forward" ) return this.#arrive();
    if ( canvas.ready ) this.readyAt ??= performance.now();
    if ( this.stageGate ) this.#report(this.stageGate);
    this.#maybeReveal();
  }

  #clearArrival() {
    if ( this.#arrival === null ) return;
    window.clearTimeout(this.#arrival);
    this.#timeouts.delete(this.#arrival);
    this.#arrival = null;
  }

  /**
   * The hold ended: forward to the destination, or end.
   */
  #afterHold() {
    this.#holdTimer = null;
    if ( this.closed ) return;
    const id = this.forwardTo;
    const scene = id ? game.scenes.get(id) : null;
    const needed = !!scene && (!this.#at(id) || (this.#drives() && !this.preview && !scene.active));
    if ( !needed ) return this.close();
    this.phase = "forward";
    if ( !this.element || (this.#fadeEnds !== null) ) this.#mountOverlay();
    const there = this.#at(id);
    this.#goTo(id);
    if ( there ) this.#covered().then(() => this.#arrive());
  }

  /**
   * The destination is drawn: once a cinematic cut-in on screen has ended, reveal it and end.
   * @returns {Promise<void>}
   */
  async #arrive() {
    if ( this.#arrived || this.closed ) return;
    this.#arrived = true;
    if ( this.forwardTo ) {
      this.#report(this.forwardTo);
      await this.#started(this.forwardTo);
      if ( this.closed ) return;
    }
    await this.#cutinsDone();
    if ( this.closed ) return;
    this.#after(this.#openUp(), () => this.close());
  }

  /**
   * Resolve when no cinematic cut-in is on screen (Cinematic Cut-ins marks its overlay "active" while one plays), when
   * the session ends, or after CUTIN_WAIT_MS.
   * @returns {Promise<void>}
   */
  #cutinsDone() {
    const playing = () => !!document.querySelector("#cinematic-overlay.active");
    const until = performance.now() + CUTIN_WAIT_MS;
    return new Promise(resolve => {
      const check = () => {
        if ( this.closed || !playing() || (performance.now() > until) ) return resolve();
        window.setTimeout(check, 250);
      };
      check();
    });
  }

  /* -------------------------------------------- */
  /*  Synchronized Start                          */
  /* -------------------------------------------- */

  /**
   * Does revealing a scene wait for the driver's start?
   * @param {string} id
   * @returns {boolean}
   */
  #needsStart(id) {
    if ( !this.run ) return false;
    if ( id === PRELOADED ) return !!(this.stageGate || this.forwardTo);
    return (id === this.stageGate) || (id === this.forwardTo);
  }

  /**
   * Report that this client has drawn a scene of the playback. Without a start from the driver, go on after a while.
   * @param {string} id
   */
  #report(id) {
    if ( !this.#needsStart(id) || this.#reported.has(id) || this.closed ) return;
    this.#reported.add(id);
    game.user.setFlag(MODULE_ID, READY_FLAG, {run: this.run, scene: id})
      .catch(err => console.warn("Loading Screen | Could not report the scene as drawn", err));
    this.#after(SYNC_WAIT_MS + 5000, () => this.#onStart(id));
    if ( this.#drives() ) this.#collect(id);
  }

  /**
   * Driver: give the start once every connected client has reported the scene, or after SYNC_WAIT_MS.
   * @param {string} id
   */
  #collect(id) {
    if ( this.#collecting.has(id) ) return;
    this.#collecting.add(id);
    const reported = user => {
      const flag = user.getFlag(MODULE_ID, READY_FLAG);
      return (flag?.run === this.run) && (flag?.scene === id);
    };
    let done = false;
    const finish = () => {
      if ( done ) return;
      done = true;
      off();
      if ( this.closed ) return;
      this.#onStart(id);
      game.settings.set(MODULE_ID, PLAY_SETTING, {go: this.run, scene: id, nonce: foundry.utils.randomID()})
        .catch(err => console.warn("Loading Screen | Could not send the start", err));
    };
    const check = () => {
      if ( !done && game.users.filter(u => u.active).every(reported) ) finish();
    };
    const onUpdate = Hooks.on("updateUser", check);
    const onConnect = Hooks.on("userConnected", check);
    const timer = window.setTimeout(finish, SYNC_WAIT_MS);
    const off = () => {
      Hooks.off("updateUser", onUpdate);
      Hooks.off("userConnected", onConnect);
      window.clearTimeout(timer);
    };
    this.#listeners.push(off);
    check();
  }

  /**
   * The driver gave the start for a scene of this playback.
   * @param {{go?: string, scene?: string}} value
   */
  onStart(value) {
    if ( value?.go && (value.go === this.run) && value.scene ) this.#onStart(value.scene);
  }

  /**
   * @param {string} id
   */
  #onStart(id) {
    if ( this.#go.has(id) || this.closed ) return;
    this.#go.add(id);
    for ( const resolve of this.#goWaiters.get(id) ?? [] ) resolve();
    this.#goWaiters.delete(id);
    this.#maybeReveal();
  }

  /**
   * Resolve once the start for a scene is given, or at once when it needs none.
   * @param {string} id
   * @returns {Promise<void>}
   */
  #started(id) {
    if ( !this.#needsStart(id) || this.#go.has(id) ) return Promise.resolve();
    return new Promise(resolve => {
      const list = this.#goWaiters.get(id) ?? [];
      list.push(resolve);
      this.#goWaiters.set(id, list);
    });
  }

  /* -------------------------------------------- */
  /*  Music                                       */
  /* -------------------------------------------- */

  /**
   * Load the music so it starts on time.
   */
  #prepareMusic() {
    const m = this.screen.music;
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = m.src;
    const segment = this.musicSegment = new MediaSegment(audio, {
      start: m.start,
      end: m.end,
      fadeIn: m.fadeIn,
      fadeOut: m.fadeOut,
      volume: this.#volumeFor(m.volume),
      onEnd: () => {
        this.manager.forgetAudio(segment);
        this.#soundPending.delete("music");
        this.#refreshSoundHint();
        unload(audio);
      }
    });
    this.#musicReady = segment.prepare().then(() => true, err => {
      console.warn(`Loading Screen | Could not load the music "${m.src}"`, err);
      return false;
    });
  }

  /**
   * Start the music at its moment. After the screen ended, only music that plays to its end still starts.
   */
  #startMusic() {
    const segment = this.musicSegment;
    if ( !segment || segment.done || this.#musicStarted || this.disposed ) return;
    if ( this.closed && (this.screen.music.onEnd !== "finish") ) return;
    this.#musicStarted = true;
    this.#musicAt = performance.now();
    if ( this.closed ) this.manager.adoptAudio(segment);
    this.#musicReady.then(ok => {
      if ( !ok || segment.done || (segment.volume <= 0) ) return;
      const late = (performance.now() - this.#musicAt) / 1000;
      return segment.play(late > 0.3 ? segment.start + late : undefined);
    }).catch(err => {
      if ( segment.done ) return;
      if ( err?.name === "NotAllowedError" ) return this.#offerSound("music");
      console.warn(`Loading Screen | Could not play the music "${this.screen.music.src}"`, err);
    });
  }

  /**
   * The screen ends: fade the music out, or leave it playing to the end of its segment.
   * @param {boolean} abrupt    The session is disposed or stopped rather than ended
   */
  #endMusic(abrupt) {
    const keep = !abrupt && (this.screen.music.onEnd === "finish");
    const pending = this.#musicTimers.size > 0;
    if ( !keep ) {
      for ( const id of this.#musicTimers ) window.clearTimeout(id);
      this.#musicTimers.clear();
    }
    const segment = this.musicSegment;
    if ( !segment || segment.done ) return;
    if ( keep && this.#musicStarted ) return this.manager.adoptAudio(segment);
    if ( keep && pending ) return; // Starts later and is adopted then
    const ms = abrupt ? RELEASE_MS : this.screen.music.fadeOut * 1000;
    segment.release(ms).then(() => unload(segment.media));
  }

  /* -------------------------------------------- */
  /*  Sound Permission                            */
  /* -------------------------------------------- */

  /**
   * The browser refused to start sound until the page gets a click or key press: show a hint and wait for one.
   * @param {"video"|"music"} kind
   */
  #offerSound(kind) {
    if ( this.closed ) return;
    this.#soundPending.add(kind);
    if ( this.#soundHint ) return;
    const hint = this.#soundHint = document.createElement("div");
    hint.id = "ls-custom-sound";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-volume-xmark";
    icon.inert = true;
    const text = document.createElement("span");
    text.textContent = game.i18n.localize("LOADING_SCREEN.Custom.EnableSound");
    hint.append(icon, text);
    document.body.append(hint);
    this.#listen(document, "pointerdown", () => this.#enableSound(), {capture: true});
  }

  /**
   * Turn on the sound that was refused, from inside a click or key press. Music resumes where it should be by now.
   * @returns {boolean}   Whether there was sound to turn on
   */
  #enableSound() {
    if ( !this.#soundPending.size ) return false;
    this.#soundAt = performance.now();
    if ( this.#soundPending.has("video") && this.video ) this.video.muted = false;
    const music = this.musicSegment;
    if ( this.#soundPending.has("music") && music && !music.done ) {
      const position = music.start + ((performance.now() - this.#musicAt) / 1000);
      music.play(position).catch(err => console.warn("Loading Screen | Could not start the music", err));
    }
    this.#soundPending.clear();
    this.#refreshSoundHint();
    return true;
  }

  #refreshSoundHint() {
    if ( this.#soundPending.size || !this.#soundHint ) return;
    this.#soundHint.remove();
    this.#soundHint = null;
  }

  #dropSoundHint() {
    this.#soundPending.clear();
    this.#refreshSoundHint();
  }

  /* -------------------------------------------- */
  /*  Reveal and Camera                           */
  /* -------------------------------------------- */

  #maybeReveal() {
    if ( this.#revealed || this.closed || !this.#mediaDone || !this.readyAt || this.#awaiting ) return;
    if ( this.stageGate && this.#needsStart(this.stageGate) && !this.#go.has(this.stageGate) ) return;
    this.#revealed = true;
    if ( !showsStage(this.screen) && this.forwardTo ) return this.#skipStage();
    this.#reveal().catch(err => {
      console.error("Loading Screen | Custom screen camera failed", err);
      this.#finishCamera();
    });
  }

  /**
   * Put the camera at its start, fade the overlay out and move the camera to its end.
   * @returns {Promise<void>}
   */
  async #reveal() {
    const s = this.screen;
    this.phase = "camera";
    this.#runMoment("media");
    const sameScene = !this.scene || (canvas.scene?.id === this.scene.id);
    const useCamera = s.camera.enabled && canvas.ready && !!canvas.scene && sameScene;
    if ( useCamera ) {
      this.#target = cameraView(s.camera.to, s.camera);
      canvas.pan(cameraView(s.camera.from, s.camera));
    }
    const last = !this.forwardTo;
    const revealMs = last ? this.#openUp() : this.#fadeOut();
    if ( useCamera ) {
      const CanvasAnimation = foundry.canvas.animation.CanvasAnimation;
      const name = EASINGS[s.camera.easing];
      const easing = name ? CanvasAnimation[name] : (t => t);
      await canvas.animatePan({...this.#target, duration: s.camera.duration * 1000, easing});
    }
    else await this.#wait(revealMs);
    this.#finishCamera();
  }

  /**
   * Go on from the black screen to the destination without showing the screen's own scene.
   */
  #skipStage() {
    this.phase = "camera";
    this.#runMoment("media");
    this.#cameraDone = true;
    this.phase = "hold";
    this.#runMoment("end");
    this.#afterHold();
  }

  #finishCamera() {
    if ( this.#cameraDone || this.closed ) return;
    this.#cameraDone = true;
    this.phase = "hold";
    this.#runMoment("end");
    this.#holdTimer = this.#after(this.screen.interfaceDelay * 1000, () => this.#afterHold());
  }

  /* -------------------------------------------- */
  /*  Interface                                   */
  /* -------------------------------------------- */

  #hideInterface() {
    const body = document.body;
    body.classList.remove("ls-cine-ui-back");
    body.classList.add("ls-cine-ui");
    if ( !document.getElementById("ls-cine-shield") ) {
      const shield = document.createElement("div");
      shield.id = "ls-cine-shield";
      if ( game.user.isGM ) shield.classList.add("ls-cine-gm");
      body.append(shield);
    }
    this.#ownsInterface = true;
  }

  /**
   * Show the interface again, unless the screen that replaces this one keeps it hidden.
   * @param {object} [options]
   * @param {boolean} [options.instant=false]
   */
  #restoreInterface({instant=false}={}) {
    if ( !this.#ownsInterface ) return;
    this.#ownsInterface = false;
    const next = this.manager.session;
    if ( next && (next !== this) && next.custom && !next.closed && next.screen?.hideInterface ) return;
    const body = document.body;
    body.classList.remove("ls-cine-ui");
    document.getElementById("ls-cine-shield")?.remove();
    if ( instant ) return;
    body.classList.add("ls-cine-ui-back");
    window.setTimeout(() => body.classList.remove("ls-cine-ui-back"), 700);
  }

  /**
   * The GM's stop button, shown above everything while the screen plays.
   */
  #mountStopButton() {
    if ( !game.user.isGM || this.#stopButton ) return;
    document.getElementById("ls-custom-stop")?.remove();
    const button = this.#stopButton = document.createElement("button");
    button.type = "button";
    button.id = "ls-custom-stop";
    button.setAttribute("aria-label", game.i18n.localize("LOADING_SCREEN.Custom.Stop"));
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-stop";
    icon.inert = true;
    button.append(icon);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.manager.stopCustom({local: this.preview});
    });
    document.body.append(button);
  }

  #removeStopButton() {
    this.#stopButton?.remove();
    this.#stopButton = null;
  }

  /* -------------------------------------------- */
  /*  Input                                       */
  /* -------------------------------------------- */

  /**
   * A click turns refused sound on; otherwise players who may skip stop the screen on their own client.
   */
  #onClick() {
    if ( this.#enableSound() ) return;
    if ( (performance.now() - this.#soundAt) < SOUND_CLICK_GRACE_MS ) return;
    if ( this.screen.skippable && !game.user.isGM ) this.manager.stopCustom({local: true});
  }

  /**
   * Escape stops everything: the GM's stops the screen on every client (a preview only here), a player's stops it on
   * their client when players may skip. With the interface hidden, other keys do not reach Foundry, so they cannot pan
   * the camera, move tokens or open windows. Browser keys such as F5 keep working.
   * @param {KeyboardEvent} event
   */
  #onKeyDown(event) {
    if ( this.closed ) return;
    if ( event.key === "Escape" ) {
      if ( !game.user.isGM && !this.screen.skippable ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.manager.stopCustom({local: this.preview || !game.user.isGM});
      return;
    }
    this.#enableSound();
    if ( this.screen.hideInterface ) event.stopImmediatePropagation();
  }

  /* -------------------------------------------- */
  /*  Moments and Macros                          */
  /* -------------------------------------------- */

  /**
   * Run the macros of a moment and start the music if it begins then.
   * @param {string} moment
   */
  #runMoment(moment) {
    this.#runMacros(moment);
    const m = this.screen.music;
    if ( !this.musicSegment || (m.when !== moment) ) return;
    const id = window.setTimeout(() => {
      this.#musicTimers.delete(id);
      this.#startMusic();
    }, m.delay * 1000);
    this.#musicTimers.add(id);
  }

  /**
   * Schedule the macros of a moment.
   * @param {string} moment
   */
  #runMacros(moment) {
    const entries = this.screen.macros.filter(m => m.uuid && (m.when === moment));
    if ( !entries.length ) return;
    if ( !this.preview && !game.users.activeGM?.isSelf ) return;
    for ( const entry of entries ) {
      const id = window.setTimeout(() => {
        this.#macroTimers.delete(id);
        this.#runMacro(entry, moment);
      }, entry.delay * 1000);
      this.#macroTimers.add(id);
    }
  }

  /**
   * Execute one macro. Script macros receive `scope.loadingScreen`: {id, name, scene, moment, preview}.
   * @param {CustomScreenMacro} entry
   * @param {string} moment
   * @returns {Promise<void>}
   */
  async #runMacro(entry, moment) {
    const macro = await fromUuid(entry.uuid).catch(() => null);
    if ( macro?.documentName !== "Macro" ) {
      ui.notifications.warn(game.i18n.format("LOADING_SCREEN.Custom.MacroMissing", {uuid: entry.uuid}));
      return;
    }
    const loadingScreen = {id: this.screen.id, name: this.screen.name, scene: this.scene, moment, preview: this.preview};
    try {
      await macro.execute({loadingScreen});
    } catch(err) {
      console.error(`Loading Screen | Macro "${macro.name}" failed`, err);
    }
  }

  /* -------------------------------------------- */
  /*  Timers and Listeners                        */
  /* -------------------------------------------- */

  /**
   * Longest the sequence should take, with a margin.
   * @returns {number}  Seconds
   */
  #expectedSeconds() {
    const s = this.screen;
    let shown = shownSeconds(s);
    if ( this.video ) {
      const length = this.mediaSegment?.length;
      shown = Number.isFinite(length) ? length : UNKNOWN_VIDEO_S;
    }
    const move = (PRELOAD_WAIT_MS + ARRIVAL_WAIT_MS + SYNC_WAIT_MS + 5000) / 1000;
    const preload = (this.stageTo || this.forwardTo) ? (PRELOAD_WAIT_MS + SYNC_WAIT_MS + 5000) / 1000 : 0;
    const stage = this.stageTo ? move : 0;
    const forward = this.forwardTo ? move + (CUTIN_WAIT_MS / 1000) + s.fadeIn + s.fadeOut : 0;
    const camera = s.camera.enabled ? s.camera.duration : 0;
    return preload + shown + stage + camera + s.interfaceDelay + forward + s.fadeIn + s.fadeOut + SAFETY_MARGIN_S;
  }

  /**
   * (Re)start the timer that ends a sequence which got stuck.
   */
  #armSafety() {
    if ( this.closed ) return;
    if ( this.#safety !== null ) {
      window.clearTimeout(this.#safety);
      this.#timeouts.delete(this.#safety);
    }
    this.#safety = this.#after(this.#expectedSeconds() * 1000, () => {
      console.warn("Loading Screen | Custom screen ended by its safety timer");
      this.close();
    });
  }

  /**
   * @param {number} ms
   * @param {Function} fn
   * @returns {number}
   */
  #after(ms, fn) {
    const id = window.setTimeout(() => {
      this.#timeouts.delete(id);
      fn();
    }, ms);
    this.#timeouts.add(id);
    return id;
  }

  /**
   * A promise that resolves after a delay, unless the session ends first.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  #wait(ms) {
    return new Promise(resolve => this.#after(ms, resolve));
  }

  #stopTimers() {
    for ( const id of this.#timeouts ) window.clearTimeout(id);
    this.#timeouts.clear();
    this.#safety = null;
    this.#arrival = null;
    this.#holdTimer = null;
  }

  /**
   * @param {EventTarget} target
   * @param {string} type
   * @param {Function} fn
   * @param {object} [options]
   */
  #listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this.#listeners.push(() => target.removeEventListener(type, fn, options));
  }

  #unlisten() {
    for ( const off of this.#listeners.splice(0) ) off();
  }
}
