/**
 * Loading Screen System for Foundry VTT
 * Original module by NoWitchCraft, licensed under Apache-2.0.
 *
 * Fork notice (Apache-2.0 §4b): modified in 2026 by Drakul for Foundry VTT v14.
 * - Tips sit in a bar anchored to the bottom of the screen, centered and aligned in every design.
 * - Optional loading music: file, folder or wildcard, per-scene override, volume, fade-out or play to the end.
 * - Image sources accept several entries and wildcards; images can rotate with a crossfade at a fixed interval.
 * - Minimum display time, click to dismiss once loaded, progress fed by the real texture loading.
 * - Scene settings stored in scene flags; ApplicationV2 dialogs; a preview window.
 * - The overlay is created before textures load and is closed reliably, also when a scene loads very fast.
 * - Custom screens: saved sequences of a full-screen video segment, image or black screen, music, a camera move over
 *   the screen's own scene and macros, used by a scene instead of the default screen, played for everyone by a GM,
 *   previewed alone, or played on the way to another scene; Escape or the GM's stop button interrupts everything.
 */

import {tips_en} from "./tips-en.js";
import {CustomTipsConfig, LoadingScreenPreview} from "./config.js";
import {CustomScreensConfig} from "./custom-screens-config.js?v=20261111c";
import {CustomScreens, CustomSession, PLAY_SETTING, SCREENS_SETTING, normalizeScreen} from "./custom-screens.js?v=20261111c";
import {registerSceneConfigTab} from "./scene-config.js";
import {MediaSegment, fadeAudio, resolveMedia, isVideo, ShuffleBag} from "./compat.js?v=20261111c";

const MODULE_ID = "custom-loading-screen";

/**
 * Version added to the URLs of the scripts and the stylesheet of the custom screens, so browsers and proxies that
 * cache module files load the current ones. The import statements repeat it; every importer of a file must use the
 * same URL, or the file would load twice.
 */
const ASSET_VERSION = "20261111c";

/** Template paths by design name. */
const TEMPLATES = Object.freeze({
  standard: `modules/${MODULE_ID}/templates/loading-screens/standard.html`,
  minimalist: `modules/${MODULE_ID}/templates/loading-screens/minimalist.html`,
  cinematic: `modules/${MODULE_ID}/templates/loading-screens/cinematic.html`,
  fantasy: `modules/${MODULE_ID}/templates/loading-screens/fantasy.html`
});

/** Close the overlay anyway if the canvas never reports ready. */
const SAFETY_TIMEOUT_MS = 60000;

/** A click dismisses the overlay once loading is done, or after this long. */
const SKIP_AFTER_MS = 10000;

/** Crossfade duration between background images, in seconds. */
const IMAGE_FADE_SECONDS = 1.2;

/* -------------------------------------------- */
/*  Loading Session                             */
/* -------------------------------------------- */

/**
 * One displayed loading screen, from the moment a scene starts loading until its overlay is removed.
 */
class LoadingSession {
  /**
   * @param {typeof LoadingScreenManager} manager
   * @param {Scene|null} scene
   * @param {object} [options]
   * @param {boolean} [options.preview=false]   A preview which closes by itself after its duration
   * @param {number} [options.duration=8]       Preview duration in seconds
   */
  constructor(manager, scene, {preview=false, duration=8}={}) {
    this.manager = manager;
    this.scene = scene;
    this.preview = preview;
    this.previewDuration = duration;
    this.settings = manager.readSettings();
    this.startedAt = performance.now();
    this.readyAt = null;
    this.closed = false;
    this.disposed = false;
    this.element = null;
    this.layers = [];
    this.layerIndex = 0;
    this.currentImage = null;
    this.images = new ShuffleBag();
    this.tips = new ShuffleBag();
    this.audio = null;
    this.progress = {shown: 0, creep: 0, real: 0};
    this.rotating = false;
  }

  /** @type {Set<number>} */
  #timeouts = new Set();

  /** @type {Set<number>} */
  #intervals = new Set();

  /** @type {MutationObserver|null} */
  #observer = null;

  /* -------------------------------------------- */

  /**
   * Build and display the overlay, then start images, tips, progress and music.
   * @returns {Promise<void>}
   */
  async start() {
    const s = this.settings;
    const tips = s.showTips ? this.manager.getTips() : [];
    this.tips.setItems(tips);
    const data = {
      template: s.template,
      customText: s.customText,
      sceneName: this.manager.getSceneName(this.scene),
      showProgress: s.showProgress,
      showTips: s.showTips && (tips.length > 0),
      currentTip: this.tips.next() ?? "",
      fadeDuration: s.fadeDuration,
      imageFade: IMAGE_FADE_SECONDS,
      backgroundImage: "",
      labels: {
        entering: game.i18n.localize("LOADING_SCREEN.Entering"),
        tips: game.i18n.localize("LOADING_SCREEN.TipsHeader"),
        skip: game.i18n.localize("LOADING_SCREEN.ClickToContinue")
      }
    };
    const html = this.manager.renderTemplateSync(s.template, data) ?? await this.manager.renderTemplate(s.template, data);
    if ( this.closed || this.disposed ) return;

    // Create the overlay
    const holder = document.createElement("div");
    holder.innerHTML = html.trim();
    const el = this.element = holder.querySelector("#loading-screen-overlay") ?? holder.firstElementChild;
    if ( !el ) return;
    el.classList.add("loading-screen");
    el.style.setProperty("--fade-duration", `${s.fadeDuration}s`);
    el.style.setProperty("--image-fade", `${IMAGE_FADE_SECONDS}s`);
    if ( (s.minDuration > 0) || this.preview ) el.classList.add("ls-skippable");
    let container = el.querySelector(".ls-backgrounds");
    if ( !container ) {
      container = document.createElement("div");
      container.className = "ls-backgrounds";
      el.prepend(container);
    }
    for ( let i = 0; i < 2; i++ ) {
      const layer = document.createElement("div");
      layer.className = "ls-bg";
      container.append(layer);
      this.layers.push(layer);
    }
    el.addEventListener("click", () => this.#onClick());
    document.body.classList.add("loading-screen-active");
    document.body.classList.toggle("ls-block-notifications", !!s.blockNotifications);
    document.body.append(el);

    // First image: cached pool or the scene's own background, then the full pool in the background
    const spec = this.manager.imageSpecFor(this.scene);
    this.images.setItems(this.manager.cachedMedia(spec, "image"));
    this.#setImage(this.images.next() ?? this.manager.getSceneImage(this.scene), {instant: true});
    this.#loadImagePool(spec).catch(err => console.warn("Loading Screen | Image pool failed", err));

    // Tips, progress and music
    if ( data.showTips && (this.tips.items.length > 1) ) this.#every(s.tipRotation * 1000, () => this.#rotateTip());
    if ( s.showProgress ) this.#startProgress();
    this.#startMusic().catch(err => console.warn("Loading Screen | Music failed", err));

    // Closing conditions
    if ( this.preview ) this.#after(this.previewDuration * 1000, () => this.markReady());
    else this.#after(SAFETY_TIMEOUT_MS, () => this.close());
    if ( this.readyAt ) this.markReady({force: true});
  }

  /* -------------------------------------------- */

  /**
   * The scene finished drawing: close now or once the minimum display time has passed.
   * @param {object} [options]
   * @param {boolean} [options.force]   Re-evaluate even if ready was already recorded
   */
  markReady({force=false}={}) {
    if ( this.closed || (this.readyAt && !force) ) return;
    this.readyAt ??= performance.now();
    this.progress.shown = 1;
    this.#setProgressWidth(1);
    this.element?.classList.add("ls-ready");
    const minimum = this.preview ? 0 : this.settings.minDuration * 1000;
    const wait = Math.max(0, (this.startedAt + minimum) - performance.now());
    if ( !this.element && (wait > 0) ) return; // Shown once start() completes
    this.#after(wait, () => this.close());
  }

  /* -------------------------------------------- */

  /**
   * Fade the overlay out and stop or hand over the music.
   */
  close() {
    if ( this.closed ) return;
    this.closed = true;
    this.#stopTimers();
    this.#releaseAudio();
    const el = this.element;
    if ( !el ) {
      this.disposed = true;
      this.#restoreBody();
      return;
    }
    this.#setProgressWidth(1);
    el.classList.add("fade-out");
    window.setTimeout(() => {
      el.remove();
      this.disposed = true;
      this.#restoreBody();
    }, this.settings.fadeDuration * 1000);
  }

  /* -------------------------------------------- */

  /**
   * Remove the overlay at once, for example when another scene starts loading.
   */
  dispose() {
    this.closed = true;
    this.disposed = true;
    this.#stopTimers();
    if ( this.audio ) {
      const audio = this.audio;
      this.audio = null;
      fadeAudio(audio, 0, 300).then(() => audio.pause());
    }
    this.element?.remove();
  }

  /* -------------------------------------------- */

  /**
   * Restore body classes, unless another session owns them now.
   */
  #restoreBody() {
    if ( this.manager.session && (this.manager.session !== this) ) return;
    document.body.classList.remove("loading-screen-active", "ls-block-notifications");
    this.manager.session = null;
  }

  /* -------------------------------------------- */
  /*  Timers                                      */
  /* -------------------------------------------- */

  /**
   * @param {number} ms
   * @param {Function} fn
   */
  #after(ms, fn) {
    const id = window.setTimeout(() => {
      this.#timeouts.delete(id);
      fn();
    }, ms);
    this.#timeouts.add(id);
  }

  /**
   * @param {number} ms
   * @param {Function} fn
   */
  #every(ms, fn) {
    this.#intervals.add(window.setInterval(fn, ms));
  }

  #stopTimers() {
    for ( const id of this.#timeouts ) window.clearTimeout(id);
    for ( const id of this.#intervals ) window.clearInterval(id);
    this.#timeouts.clear();
    this.#intervals.clear();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* -------------------------------------------- */
  /*  Images                                      */
  /* -------------------------------------------- */

  /**
   * Resolve the full image pool, switch to it and start the rotation.
   * @param {string} spec
   * @returns {Promise<void>}
   */
  async #loadImagePool(spec) {
    const list = spec ? await this.manager.getMedia(spec, "image", {refresh: true}) : [];
    if ( this.closed ) return;
    if ( list.length ) {
      this.images.setItems(list);
      if ( !list.includes(this.currentImage) ) await this.#crossfadeTo(this.images.next());
    }
    if ( this.settings.imageRotate && !this.rotating && (this.images.items.length > 1) ) {
      this.rotating = true;
      this.#every(this.settings.imageInterval * 1000, () => this.#crossfadeTo(this.images.next()));
    }
  }

  /**
   * Fill a background layer with an image or a muted looping video.
   * @param {HTMLElement} layer
   * @param {string} src
   */
  #fillLayer(layer, src) {
    layer.replaceChildren();
    layer.style.backgroundImage = "";
    if ( !src ) return;
    if ( isVideo(src) ) {
      const video = document.createElement("video");
      Object.assign(video, {src, autoplay: true, muted: true, loop: true, playsInline: true});
      video.className = "ls-media";
      layer.append(video);
      video.play?.().catch(() => {});
    }
    else layer.style.backgroundImage = `url(${JSON.stringify(src)})`;
  }

  /**
   * Show an image immediately on the active layer.
   * @param {string|null} src
   */
  #setImage(src) {
    const layer = this.layers[this.layerIndex];
    if ( !layer ) return;
    this.#fillLayer(layer, src);
    layer.classList.add("active");
    this.currentImage = src ?? null;
  }

  /**
   * Preload an image and crossfade to it.
   * @param {string|null} src
   * @returns {Promise<void>}
   */
  async #crossfadeTo(src) {
    if ( !src || (src === this.currentImage) || this.closed ) return;
    if ( !isVideo(src) ) {
      const img = new Image();
      img.src = src;
      try {
        await img.decode();
      } catch {
        return; // Unreadable image: keep the current one
      }
    }
    if ( this.closed ) return;
    const current = this.layers[this.layerIndex];
    this.layerIndex = 1 - this.layerIndex;
    const next = this.layers[this.layerIndex];
    this.#fillLayer(next, src);
    next.classList.add("active");
    current.classList.remove("active");
    this.currentImage = src;
    this.#after(IMAGE_FADE_SECONDS * 1000 + 50, () => {
      if ( !current.classList.contains("active") ) this.#fillLayer(current, null);
    });
  }

  /* -------------------------------------------- */
  /*  Tips                                        */
  /* -------------------------------------------- */

  #rotateTip() {
    const el = this.element?.querySelector("#loading-tip-text");
    const tip = this.tips.next();
    if ( !el || !tip ) return;
    el.classList.add("ls-tip-hidden");
    this.#after(350, () => {
      el.textContent = tip;
      el.classList.remove("ls-tip-hidden");
    });
  }

  /* -------------------------------------------- */
  /*  Progress                                    */
  /* -------------------------------------------- */

  /**
   * Animate the progress bar: a slow creep towards 90%, pushed by the real texture loading progress.
   */
  #startProgress() {
    if ( !this.element?.querySelector("#loading-progress-fill") ) return;
    this.#watchNotifications();
    this.#every(100, () => {
      const p = this.progress;
      let target = 1;
      if ( !this.readyAt ) {
        p.creep += (0.9 - p.creep) * 0.02;
        target = Math.max(p.creep, Math.min(p.real, 1) * 0.9);
      }
      p.shown += (target - p.shown) * 0.25;
      this.#setProgressWidth(p.shown);
    });
  }

  /**
   * @param {number} fraction
   */
  #setProgressWidth(fraction) {
    const fill = this.element?.querySelector("#loading-progress-fill");
    if ( fill ) fill.style.width = `${(Math.clamp(fraction, 0, 1) * 100).toFixed(1)}%`;
  }

  /**
   * Mirror the core texture loading notification, which reports its percentage in a CSS variable.
   */
  #watchNotifications() {
    const list = document.getElementById("notifications");
    if ( !list || this.preview ) return;
    const read = () => {
      for ( const li of list.querySelectorAll("li.notification.progress") ) {
        const pct = parseFloat(li.style.getPropertyValue("--pct"));
        if ( Number.isFinite(pct) ) this.progress.real = Math.max(this.progress.real, pct / 100);
      }
    };
    this.#observer = new MutationObserver(read);
    this.#observer.observe(list, {subtree: true, childList: true, attributes: true, attributeFilter: ["style"]});
    read();
  }

  /* -------------------------------------------- */
  /*  Music                                       */
  /* -------------------------------------------- */

  /**
   * Start the loading music on this client, if configured and allowed by the browser.
   * @returns {Promise<void>}
   */
  async #startMusic() {
    const s = this.settings;
    if ( !s.soundClient || game.audio?.globalMute ) return;
    const spec = this.manager.soundSpecFor(this.scene);
    if ( !spec ) return;
    const volume = Math.clamp(s.soundVolume * (game.settings.get("core", "globalPlaylistVolume") ?? 1), 0, 1);
    if ( volume <= 0 ) return;
    this.manager.stopLingeringAudio(400);

    let pool = this.manager.cachedMedia(spec, "audio");
    if ( pool.length ) this.manager.getMedia(spec, "audio", {refresh: true}).catch(() => {});
    else pool = await this.manager.getMedia(spec, "audio");
    if ( this.disposed || (this.closed && (s.soundEnd === "fade")) ) return;
    const src = pool[Math.floor(Math.random() * pool.length)];
    if ( !src ) return;

    const audio = new Audio(src);
    audio.preload = "auto";
    audio.volume = 0;
    this.audio = audio;
    try {
      await audio.play();
    } catch(err) {
      // Browsers block audio until the page receives a click or key press
      console.debug("Loading Screen | Music not allowed to start yet", err);
      if ( this.audio === audio ) this.audio = null;
      return;
    }
    if ( this.disposed || (this.closed && (s.soundEnd === "fade")) ) {
      audio.pause();
      if ( this.audio === audio ) this.audio = null;
      return;
    }
    if ( this.closed ) this.manager.adoptAudio(audio);
    fadeAudio(audio, volume, 500);
    audio.addEventListener("ended", () => {
      if ( this.audio === audio ) this.audio = null;
      this.manager.forgetAudio(audio);
    }, {once: true});
  }

  /**
   * Stop the music with a fade, or let it play to the end, depending on the settings.
   */
  #releaseAudio() {
    const audio = this.audio;
    if ( !audio ) return;
    this.audio = null;
    if ( this.settings.soundEnd === "finish" ) return this.manager.adoptAudio(audio);
    fadeAudio(audio, 0, this.settings.soundFade * 1000).then(() => audio.pause());
  }

  /* -------------------------------------------- */

  #onClick() {
    const elapsed = performance.now() - this.startedAt;
    if ( this.readyAt || this.preview || (elapsed > SKIP_AFTER_MS) ) this.close();
  }
}

/* -------------------------------------------- */
/*  Manager                                     */
/* -------------------------------------------- */

class LoadingScreenManager {
  static ID = MODULE_ID;

  static SETTINGS = Object.freeze({
    ENABLED: "enabled",
    TEMPLATE: "template",
    CUSTOM_TEXT: "customText",
    SCENE_NAME_SOURCE: "sceneNameSource",
    IMAGE_FOLDER: "imageFolder",
    IMAGE_ROTATE: "imageRotate",
    IMAGE_INTERVAL: "imageInterval",
    MIN_DURATION: "minDuration",
    FADE_DURATION: "fadeDuration",
    SHOW_PROGRESS: "showProgress",
    SHOW_TIPS: "showTips",
    TIP_ROTATION: "tipRotation",
    CUSTOM_TIPS: "customTips",
    SOUND: "sound",
    SOUND_VOLUME: "soundVolume",
    SOUND_END: "soundEnd",
    SOUND_FADE: "soundFade",
    SOUND_CLIENT: "soundClient",
    BLOCK_NOTIFICATIONS: "blockNotifications",
    REDRAW_SAME_SCENE: "redrawSameScene",
    SCENE_FOLDERS: "sceneFolders",
    FOLDER_IMAGE_CACHE: "folderImageCache",
    CUSTOM_SCREENS: SCREENS_SETTING,
    CUSTOM_PLAY: PLAY_SETTING
  });

  static DEFAULT_TIPS = {en: tips_en};

  /**
   * The active loading screen.
   * @type {LoadingSession|null}
   */
  static session = null;

  /**
   * Id of the last scene which finished drawing.
   * @type {string|null}
   */
  static lastSceneId = null;

  /**
   * Music left playing to its end after its loading screen closed.
   * @type {HTMLAudioElement|null}
   */
  static #lingering = null;

  /**
   * Serializes writes to the media cache setting.
   * @type {Promise<void>}
   */
  static #cacheWrite = Promise.resolve();

  /** Debounced cache refresh for GM edits. */
  static #scheduleRefresh = foundry.utils.debounce(() => {
    LoadingScreenManager.refreshCache().catch(err => console.warn("Loading Screen | Cache refresh failed", err));
  }, 1500);

  /* -------------------------------------------- */

  static initialize() {
    this.#loadStyles();
    this.registerSettings();
    this.registerHelpers();
    registerSceneConfigTab();
    Hooks.on("canvasTearDown", (canvas, options) => this.#guard(() => this.#onCanvasTearDown(canvas, options)));
    Hooks.on("canvasInit", canvas => this.#guard(() => this.#onCanvasInit(canvas)));
    Hooks.on("canvasReady", canvas => this.#guard(() => this.#onCanvasReady(canvas)));
    Hooks.on("updateScene", (scene, changes) => {
      if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) this.#requestRefresh();
    });
    foundry.applications.handlebars.loadTemplates(Object.values(TEMPLATES))
      .catch(err => console.error("Loading Screen | Could not preload the designs", err));
  }

  /* -------------------------------------------- */

  /**
   * Add the stylesheet of the custom screens to the modules cascade layer, like the stylesheets Foundry loads.
   */
  static #loadStyles() {
    if ( document.getElementById("loading-screen-custom-styles") ) return;
    const href = `${foundry.utils.getRoute(`modules/${MODULE_ID}/styles/custom-screens.css`)}?v=${ASSET_VERSION}`;
    const style = document.createElement("style");
    style.id = "loading-screen-custom-styles";
    style.textContent = `@import url(${JSON.stringify(href)}) layer(modules);`;
    document.head.append(style);
  }

  /* -------------------------------------------- */

  /**
   * Run a hook handler without letting an error break the canvas workflow.
   * @param {Function} fn
   */
  static #guard(fn) {
    try {
      fn();
    } catch(err) {
      console.error("Loading Screen | Hook failed", err);
    }
  }

  /* -------------------------------------------- */
  /*  Settings                                    */
  /* -------------------------------------------- */

  static registerSettings() {
    const S = this.SETTINGS;
    const register = (key, data) => game.settings.register(MODULE_ID, key, {scope: "world", config: true, ...data});

    register(S.ENABLED, {
      name: "LOADING_SCREEN.SettingEnabled",
      hint: "LOADING_SCREEN.SettingEnabledHint",
      type: Boolean,
      default: true,
      requiresReload: true
    });
    register(S.TEMPLATE, {
      name: "LOADING_SCREEN.SettingTemplate",
      hint: "LOADING_SCREEN.SettingTemplateHint",
      type: String,
      default: "standard",
      choices: {
        standard: "LOADING_SCREEN.TemplateStandard",
        minimalist: "LOADING_SCREEN.TemplateMinimalist",
        cinematic: "LOADING_SCREEN.TemplateCinematic",
        fantasy: "LOADING_SCREEN.TemplateFantasy"
      }
    });
    register(S.CUSTOM_TEXT, {
      name: "LOADING_SCREEN.SettingCustomText",
      hint: "LOADING_SCREEN.SettingCustomTextHint",
      type: String,
      default: game.i18n.localize("LOADING_SCREEN.DefaultText")
    });
    register(S.SCENE_NAME_SOURCE, {
      name: "LOADING_SCREEN.SettingSceneNameSource",
      hint: "LOADING_SCREEN.SettingSceneNameSourceHint",
      type: String,
      default: "hidden",
      choices: {
        hidden: "LOADING_SCREEN.SceneNameHidden",
        navigation: "LOADING_SCREEN.SceneNameNavigation"
      }
    });
    register(S.IMAGE_FOLDER, {
      name: "LOADING_SCREEN.SettingImageFolder",
      hint: "LOADING_SCREEN.SettingImageFolderHint",
      type: String,
      default: "",
      filePicker: "folder",
      onChange: () => this.#requestRefresh()
    });
    register(S.IMAGE_ROTATE, {
      name: "LOADING_SCREEN.SettingImageRotate",
      hint: "LOADING_SCREEN.SettingImageRotateHint",
      type: Boolean,
      default: false
    });
    register(S.IMAGE_INTERVAL, {
      name: "LOADING_SCREEN.SettingImageInterval",
      hint: "LOADING_SCREEN.SettingImageIntervalHint",
      type: Number,
      range: {min: 2, max: 60, step: 1},
      default: 8
    });
    register(S.MIN_DURATION, {
      name: "LOADING_SCREEN.SettingMinDuration",
      hint: "LOADING_SCREEN.SettingMinDurationHint",
      type: Number,
      range: {min: 0, max: 30, step: 0.5},
      default: 0
    });
    register(S.FADE_DURATION, {
      name: "LOADING_SCREEN.SettingFadeDuration",
      hint: "LOADING_SCREEN.SettingFadeDurationHint",
      type: Number,
      range: {min: 0.1, max: 3, step: 0.1},
      default: 0.5
    });
    register(S.SHOW_PROGRESS, {
      name: "LOADING_SCREEN.SettingShowProgress",
      hint: "LOADING_SCREEN.SettingShowProgressHint",
      type: Boolean,
      default: true
    });
    register(S.SHOW_TIPS, {
      name: "LOADING_SCREEN.SettingShowTips",
      hint: "LOADING_SCREEN.SettingShowTipsHint",
      type: Boolean,
      default: true
    });
    register(S.TIP_ROTATION, {
      name: "LOADING_SCREEN.SettingTipRotation",
      hint: "LOADING_SCREEN.SettingTipRotationHint",
      type: Number,
      range: {min: 3, max: 30, step: 1},
      default: 5
    });
    register(S.SOUND, {
      name: "LOADING_SCREEN.SettingSound",
      hint: "LOADING_SCREEN.SettingSoundHint",
      type: String,
      default: "",
      filePicker: "audio",
      onChange: () => this.#requestRefresh()
    });
    register(S.SOUND_VOLUME, {
      name: "LOADING_SCREEN.SettingSoundVolume",
      hint: "LOADING_SCREEN.SettingSoundVolumeHint",
      type: Number,
      range: {min: 0, max: 1, step: 0.05},
      default: 0.5
    });
    register(S.SOUND_END, {
      name: "LOADING_SCREEN.SettingSoundEnd",
      hint: "LOADING_SCREEN.SettingSoundEndHint",
      type: String,
      default: "fade",
      choices: {
        fade: "LOADING_SCREEN.SoundEndFade",
        finish: "LOADING_SCREEN.SoundEndFinish"
      }
    });
    register(S.SOUND_FADE, {
      name: "LOADING_SCREEN.SettingSoundFade",
      hint: "LOADING_SCREEN.SettingSoundFadeHint",
      type: Number,
      range: {min: 0, max: 10, step: 0.5},
      default: 2
    });
    register(S.SOUND_CLIENT, {
      name: "LOADING_SCREEN.SettingSoundClient",
      hint: "LOADING_SCREEN.SettingSoundClientHint",
      scope: "client",
      type: Boolean,
      default: true
    });
    register(S.BLOCK_NOTIFICATIONS, {
      name: "LOADING_SCREEN.SettingBlockNotifications",
      hint: "LOADING_SCREEN.SettingBlockNotificationsHint",
      type: Boolean,
      default: true
    });
    register(S.REDRAW_SAME_SCENE, {
      name: "LOADING_SCREEN.SettingRedrawSameScene",
      hint: "LOADING_SCREEN.SettingRedrawSameSceneHint",
      type: Boolean,
      default: false
    });

    // Hidden storage
    register(S.CUSTOM_TIPS, {config: false, type: String, default: ""});
    register(S.SCENE_FOLDERS, {config: false, type: Object, default: {}});
    register(S.FOLDER_IMAGE_CACHE, {config: false, type: Object, default: {}});
    register(S.CUSTOM_SCREENS, {config: false, type: Object, default: {}});
    register(S.CUSTOM_PLAY, {
      config: false,
      type: Object,
      default: {},
      onChange: value => this.#guard(() => this.#onPlaySignal(value))
    });

    // Menus
    game.settings.registerMenu(MODULE_ID, "customScreensMenu", {
      name: "LOADING_SCREEN.Custom.Menu",
      hint: "LOADING_SCREEN.Custom.MenuHint",
      label: "LOADING_SCREEN.Custom.MenuLabel",
      icon: "fa-solid fa-clapperboard",
      type: CustomScreensConfig,
      restricted: true
    });
    game.settings.registerMenu(MODULE_ID, "customTipsMenu", {
      name: "LOADING_SCREEN.SettingCustomTips",
      hint: "LOADING_SCREEN.SettingCustomTipsHint",
      label: "LOADING_SCREEN.EditCustomTips",
      icon: "fa-solid fa-lightbulb",
      type: CustomTipsConfig,
      restricted: true
    });
    game.settings.registerMenu(MODULE_ID, "previewMenu", {
      name: "LOADING_SCREEN.SettingPreview",
      hint: "LOADING_SCREEN.SettingPreviewHint",
      label: "LOADING_SCREEN.PreviewButton",
      icon: "fa-solid fa-eye",
      type: LoadingScreenPreview,
      restricted: true
    });
  }

  /**
   * Snapshot of the settings used by one loading screen.
   * @returns {object}
   */
  static readSettings() {
    const S = this.SETTINGS;
    const get = key => game.settings.get(MODULE_ID, key);
    const number = (key, fallback) => {
      const value = Number(get(key));
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      template: get(S.TEMPLATE) in TEMPLATES ? get(S.TEMPLATE) : "standard",
      customText: get(S.CUSTOM_TEXT) ?? "",
      showProgress: !!get(S.SHOW_PROGRESS),
      fadeDuration: Math.max(0.1, number(S.FADE_DURATION, 0.5)),
      showTips: !!get(S.SHOW_TIPS),
      tipRotation: Math.max(1, number(S.TIP_ROTATION, 5)),
      blockNotifications: !!get(S.BLOCK_NOTIFICATIONS),
      imageRotate: !!get(S.IMAGE_ROTATE),
      imageInterval: Math.max(1, number(S.IMAGE_INTERVAL, 8)),
      minDuration: Math.max(0, number(S.MIN_DURATION, 0)),
      soundVolume: Math.clamp(number(S.SOUND_VOLUME, 0.5), 0, 1),
      soundEnd: get(S.SOUND_END) === "finish" ? "finish" : "fade",
      soundFade: Math.max(0, number(S.SOUND_FADE, 2)),
      soundClient: !!get(S.SOUND_CLIENT)
    };
  }

  /* -------------------------------------------- */
  /*  Templates and Helpers                       */
  /* -------------------------------------------- */

  static registerHelpers() {
    Handlebars.registerHelper("lsSceneFlag", (scene, key) => {
      const value = scene?.getFlag?.(MODULE_ID, key);
      if ( (key === "images") && (value === undefined) ) return this.#legacySceneFolder(scene);
      return value ?? "";
    });
    Handlebars.registerHelper("lsSetting", key => game.settings.get(MODULE_ID, key));
    Handlebars.registerHelper("lsSoundModes", () => ({
      default: "LOADING_SCREEN.SoundModeDefault",
      custom: "LOADING_SCREEN.SoundModeCustom",
      none: "LOADING_SCREEN.SoundModeNone"
    }));
    Handlebars.registerHelper("lsCustomScreens", () => CustomScreens.choices());
  }

  /**
   * Render a design from the preloaded template cache.
   * @param {string} name
   * @param {object} data
   * @returns {string|null}
   */
  static renderTemplateSync(name, data) {
    const compiled = Handlebars.partials[TEMPLATES[name] ?? TEMPLATES.standard];
    return typeof compiled === "function" ? compiled(data) : null;
  }

  /**
   * Render a design, loading its template if needed.
   * @param {string} name
   * @param {object} data
   * @returns {Promise<string>}
   */
  static async renderTemplate(name, data) {
    const render = foundry.applications.handlebars.renderTemplate;
    try {
      return await render(TEMPLATES[name] ?? TEMPLATES.standard, data);
    } catch(err) {
      console.error(`Loading Screen | Template "${name}" failed, using the standard design`, err);
      return render(TEMPLATES.standard, data);
    }
  }

  /* -------------------------------------------- */
  /*  Scene Data                                  */
  /* -------------------------------------------- */

  /**
   * Name shown on the loading screen.
   * @param {Scene|null} scene
   * @returns {string}
   */
  static getSceneName(scene) {
    if ( !scene ) return "";
    const source = game.settings.get(MODULE_ID, this.SETTINGS.SCENE_NAME_SOURCE);
    return (source === "navigation") ? (scene.navName || scene.name) : (scene.name || scene.navName);
  }

  /**
   * The scene's own background, used when no image source is configured.
   * @param {Scene|null} scene
   * @returns {string|null}
   */
  static getSceneImage(scene) {
    return scene?.initialLevel?.background?.src || scene?.thumb || null;
  }

  /**
   * Per-scene folder saved by version 2.3 in a world setting.
   * @param {Scene|null} scene
   * @returns {string}
   */
  static #legacySceneFolder(scene) {
    if ( !scene?.id ) return "";
    return (game.settings.get(MODULE_ID, this.SETTINGS.SCENE_FOLDERS) ?? {})[scene.id]?.trim?.() ?? "";
  }

  /**
   * Image source for a scene: its own field, then the module default.
   * @param {Scene|null} scene
   * @returns {string}
   */
  static imageSpecFor(scene) {
    const flag = scene?.getFlag?.(MODULE_ID, "images");
    const own = (typeof flag === "string") ? flag.trim() : this.#legacySceneFolder(scene);
    return own || (game.settings.get(MODULE_ID, this.SETTINGS.IMAGE_FOLDER) ?? "").trim();
  }

  /**
   * Music source for a scene, honoring its music mode.
   * @param {Scene|null} scene
   * @returns {string}
   */
  static soundSpecFor(scene) {
    const mode = scene?.getFlag?.(MODULE_ID, "soundMode") ?? "default";
    if ( mode === "none" ) return "";
    if ( mode === "custom" ) {
      const own = String(scene.getFlag(MODULE_ID, "sound") ?? "").trim();
      if ( own ) return own;
    }
    return (game.settings.get(MODULE_ID, this.SETTINGS.SOUND) ?? "").trim();
  }

  /**
   * Tips to show: the custom list, or the defaults for the client language.
   * @returns {string[]}
   */
  static getTips() {
    const custom = game.settings.get(MODULE_ID, this.SETTINGS.CUSTOM_TIPS) ?? "";
    const list = custom.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
    if ( list.length ) return list;
    return this.DEFAULT_TIPS[game.i18n.lang] ?? this.DEFAULT_TIPS.en;
  }

  /* -------------------------------------------- */
  /*  Media Cache                                 */
  /* -------------------------------------------- */

  /**
   * @param {"image"|"audio"} kind
   * @param {string} spec
   * @returns {string}
   */
  static cacheKey(kind, spec) {
    return `${kind}|${spec}`;
  }

  /**
   * Files known for a source, as resolved earlier by a GM. Players read this when they cannot browse files.
   * @param {string} spec
   * @param {"image"|"audio"} kind
   * @returns {string[]}
   */
  static cachedMedia(spec, kind) {
    if ( !spec ) return [];
    const cache = game.settings.get(MODULE_ID, this.SETTINGS.FOLDER_IMAGE_CACHE) ?? {};
    const list = cache[this.cacheKey(kind, spec)] ?? ((kind === "image") ? cache[spec] : undefined);
    return Array.isArray(list) ? list : [];
  }

  /**
   * Files for a source: cached, or resolved now when allowed.
   * @param {string} spec
   * @param {"image"|"audio"} kind
   * @param {object} [options]
   * @param {boolean} [options.refresh=false]   Resolve again even when cached
   * @returns {Promise<string[]>}
   */
  static async getMedia(spec, kind, {refresh=false}={}) {
    if ( !spec ) return [];
    const cached = this.cachedMedia(spec, kind);
    if ( cached.length && (!refresh || !game.user.can("FILES_BROWSE")) ) return cached;
    const list = await resolveMedia(spec, kind);
    if ( list.length && game.user.isGM && !list.equals(cached) ) {
      this.#queueCacheWrite(cache => ({...cache, [this.cacheKey(kind, spec)]: list}));
    }
    return list.length ? list : cached;
  }

  /**
   * Resolve every source in use and store the result for players, dropping unused entries. Active GM only.
   * @returns {Promise<void>}
   */
  static async refreshCache() {
    if ( !game.users.activeGM?.isSelf ) return;
    const sources = new Map();
    const add = (spec, kind) => {
      if ( spec ) sources.set(this.cacheKey(kind, spec), [spec, kind]);
    };
    add((game.settings.get(MODULE_ID, this.SETTINGS.IMAGE_FOLDER) ?? "").trim(), "image");
    add((game.settings.get(MODULE_ID, this.SETTINGS.SOUND) ?? "").trim(), "audio");
    for ( const scene of game.scenes ) {
      add(this.imageSpecFor(scene), "image");
      add(this.soundSpecFor(scene), "audio");
    }
    const fresh = {};
    for ( const [key, [spec, kind]] of sources ) {
      const list = await resolveMedia(spec, kind);
      const kept = list.length ? list : this.cachedMedia(spec, kind);
      if ( kept.length ) fresh[key] = kept;
    }
    this.#queueCacheWrite(() => fresh);
  }

  static #requestRefresh() {
    if ( game.ready && game.users.activeGM?.isSelf ) this.#scheduleRefresh();
  }

  /**
   * Apply cache changes one at a time, always starting from the latest stored value.
   * @param {(cache: object) => object} update
   */
  static #queueCacheWrite(update) {
    this.#cacheWrite = this.#cacheWrite.then(async () => {
      const current = foundry.utils.deepClone(game.settings.get(MODULE_ID, this.SETTINGS.FOLDER_IMAGE_CACHE) ?? {});
      const next = update(current);
      if ( foundry.utils.objectsEqual(current, next) ) return;
      await game.settings.set(MODULE_ID, this.SETTINGS.FOLDER_IMAGE_CACHE, next);
    }).catch(err => console.warn("Loading Screen | Could not store the media cache", err));
  }

  /* -------------------------------------------- */
  /*  Music Hand-over                             */
  /* -------------------------------------------- */

  /**
   * Keep a track playing after its loading screen closed.
   * @param {HTMLAudioElement|MediaSegment} audio   A track, or a segment that stops by itself at its end
   */
  static adoptAudio(audio) {
    if ( this.#lingering && (this.#lingering !== audio) ) this.stopLingeringAudio(300);
    this.#lingering = audio;
  }

  /**
   * @param {HTMLAudioElement|MediaSegment} audio
   */
  static forgetAudio(audio) {
    if ( this.#lingering === audio ) this.#lingering = null;
  }

  /**
   * Fade out a track that was left playing.
   * @param {number} [fade]  Fade duration in milliseconds
   */
  static stopLingeringAudio(fade=300) {
    const audio = this.#lingering;
    if ( !audio ) return;
    this.#lingering = null;
    if ( !(audio instanceof MediaSegment) ) {
      fadeAudio(audio, 0, fade).then(() => audio.pause());
      return;
    }
    audio.release(fade).then(() => {
      audio.media.removeAttribute("src");
      audio.media.load();
    });
  }

  /* -------------------------------------------- */
  /*  Sessions                                    */
  /* -------------------------------------------- */

  /**
   * Show a loading screen for a scene, replacing any current one. A custom screen is used when one is passed or the
   * scene asks for one.
   * @param {Scene|null} scene
   * @param {object} [options]                Options passed to the session
   * @param {object} [options.screen]         Custom screen to play
   * @param {boolean} [options.firstLoad]     The scene is drawn without a scene change (Foundry opened or reloaded)
   * @param {boolean} [options.redraw]        The scene being drawn again is the current one
   * @param {string} [options.stage]          Scene a custom screen moves to before its camera
   * @param {string} [options.forward]        Scene a custom screen goes to when it ends
   * @returns {LoadingSession|CustomSession}
   */
  static begin(scene, options={}) {
    this.session?.dispose();
    const screen = options.screen ?? this.customScreenFor(scene, options);
    const session = this.session = screen
      ? new CustomSession(this, scene, screen, options)
      : new LoadingSession(this, scene, options);
    session.start().catch(err => {
      console.error("Loading Screen | Failed to show the loading screen", err);
      session.dispose();
      if ( this.session === session ) this.session = null;
      document.body.classList.remove("loading-screen-active", "ls-block-notifications");
    });
    return session;
  }

  /**
   * The custom screen a scene uses instead of the default one, if any.
   * @param {Scene|null} scene
   * @param {object} [options]
   * @param {boolean} [options.firstLoad=false]
   * @param {boolean} [options.redraw=false]
   * @param {boolean} [options.preview=false]
   * @returns {object|null}
   */
  static customScreenFor(scene, {firstLoad=false, redraw=false, preview=false}={}) {
    if ( preview || redraw ) return null;
    const id = scene?.getFlag?.(MODULE_ID, "screen");
    const screen = (typeof id === "string") && id ? CustomScreens.get(id) : null;
    if ( !screen || (firstLoad && !screen.firstLoad) ) return null;
    return screen;
  }

  /**
   * Id of an existing scene, or null.
   * @param {string} id
   * @returns {string|null}
   */
  static #sceneId(id) {
    return (id && game.scenes.get(id)) ? id : null;
  }

  /**
   * Play a custom screen on every connected client. A screen with its own scene takes everyone there. At the end,
   * everyone is forwarded to the screen's destination when it has one, or else back to the scene that was active.
   * Without a scene of its own, it plays over the scene each one is viewing. GM only.
   * @param {string} key    Id or name of a saved screen
   * @returns {Promise<boolean>}
   */
  static async playCustom(key) {
    const screen = CustomScreens.get(key);
    if ( !screen ) {
      ui.notifications.warn(game.i18n.format("LOADING_SCREEN.Custom.NotFound", {name: String(key)}));
      return false;
    }
    if ( !game.user.isGM ) return false;
    const stage = this.#sceneId(screen.scene);
    const destination = this.#sceneId(screen.destination);
    const origin = game.scenes.active?.id ?? null;
    let forward = null;
    if ( destination && (destination !== stage) ) forward = destination;
    else if ( stage && origin && (origin !== stage) ) forward = origin;
    await game.settings.set(MODULE_ID, this.SETTINGS.CUSTOM_PLAY,
      {id: screen.id, nonce: foundry.utils.randomID(), stage, forward});
    return true;
  }

  /**
   * Play a custom screen on the way to another scene. Every client plays the screen (taken to the screen's own scene
   * first, if it has one) while the destination preloads; when the screen ends, the active GM's client activates the
   * destination under a black cover, and each client reveals it once it is drawn and a cinematic cut-in on screen has
   * ended. GM only.
   * @param {string} key                    Id or name of a saved screen
   * @param {Scene|string} [destination]    Scene, or its id or name; the screen's own destination by default
   * @returns {Promise<boolean>}
   */
  static async changeScene(key, destination) {
    const screen = CustomScreens.get(key);
    if ( !screen ) {
      ui.notifications.warn(game.i18n.format("LOADING_SCREEN.Custom.NotFound", {name: String(key)}));
      return false;
    }
    if ( !game.user.isGM ) return false;
    const wanted = destination ?? screen.destination;
    const target = (wanted?.documentName === "Scene") ? wanted
      : (game.scenes.get(wanted) ?? game.scenes.getName(wanted));
    if ( !target ) {
      const message = wanted
        ? game.i18n.format("LOADING_SCREEN.Custom.SceneNotFound", {name: String(wanted)})
        : game.i18n.localize("LOADING_SCREEN.Custom.SceneMissing");
      ui.notifications.warn(message);
      return false;
    }
    await game.settings.set(MODULE_ID, this.SETTINGS.CUSTOM_PLAY,
      {id: screen.id, nonce: foundry.utils.randomID(), stage: this.#sceneId(screen.scene), forward: target.id});
    return true;
  }

  /**
   * Interrupt the custom screen at once: on every client when a GM asks, otherwise on this client only. Music left
   * playing by a custom screen and a cinematic cut-in on screen stop too.
   * @param {object} [options]
   * @param {boolean} [options.local=false]   Only on this client
   * @returns {Promise<void>}
   */
  static async stopCustom({local=false}={}) {
    this.#haltCustom();
    if ( local || !game.user.isGM ) return;
    await game.settings.set(MODULE_ID, this.SETTINGS.CUSTOM_PLAY, {stop: true, nonce: foundry.utils.randomID()});
  }

  static #haltCustom() {
    if ( this.session?.custom ) this.session.stop();
    if ( this.#lingering instanceof MediaSegment ) this.stopLingeringAudio(300);
    if ( document.querySelector("#cinematic-overlay.active") ) {
      game.modules.get("cinematic-cut-ins")?.api?.CutinManager?.stopAll?.();
    }
  }

  /**
   * Play a custom screen on this client only. A screen with its own scene moves this client's view there and back.
   * Its macros run here and receive `preview: true`.
   * @param {string|object} key   Id or name of a saved screen, or screen data
   * @returns {CustomSession|null}
   */
  static previewCustom(key) {
    const screen = (key && (typeof key === "object")) ? normalizeScreen(key) : CustomScreens.get(key);
    if ( !screen ) {
      ui.notifications.warn(game.i18n.format("LOADING_SCREEN.Custom.NotFound", {name: String(key)}));
      return null;
    }
    const stage = this.#sceneId(screen.scene);
    const origin = canvas.scene?.id ?? null;
    const forward = (stage && origin && (origin !== stage)) ? origin : null;
    return this.begin(canvas.scene ?? null, {screen, preview: true, stage, forward});
  }

  /**
   * A GM asked every client to play a custom screen with its scene moves, gave the start of a scene of it, or stopped it.
   * @param {{id?: string, stage?: string, forward?: string, nonce?: string, go?: string, scene?: string, stop?: boolean}} value
   */
  static #onPlaySignal(value) {
    if ( !game.ready ) return;
    if ( value?.stop ) return this.#haltCustom();
    if ( value?.go ) return this.session?.custom && this.session.onStart(value);
    if ( !value?.id ) return;
    const screen = CustomScreens.get(value.id);
    if ( !screen ) return;
    const stage = this.#sceneId(value.stage);
    const forward = this.#sceneId(value.forward);
    this.begin(canvas.scene ?? null, {screen, manual: true, stage, forward, run: value.nonce ?? null});
  }

  /**
   * Show the loading screen on this client without loading anything.
   * @param {object} [options]
   * @param {Scene|string} [options.scene]  The scene to preview, the viewed one by default
   * @param {number} [options.duration=8]   Seconds before it closes by itself
   * @returns {LoadingSession}
   */
  static preview({scene, duration=8}={}) {
    if ( typeof scene === "string" ) scene = game.scenes.get(scene);
    scene ??= canvas.scene ?? game.scenes.current ?? null;
    return this.begin(scene, {preview: true, duration});
  }

  /**
   * Close the current loading screen.
   */
  static hide() {
    this.session?.close();
  }

  /* -------------------------------------------- */
  /*  Canvas Hooks                                */
  /* -------------------------------------------- */

  static #enabled() {
    return game.settings.get(MODULE_ID, this.SETTINGS.ENABLED);
  }

  /**
   * The previous scene is torn down: show the loading screen for the next one as early as possible.
   * @param {Canvas} canvas
   * @param {{nextScene?: Scene|null}} options
   */
  static #onCanvasTearDown(canvas, options={}) {
    const next = options?.nextScene;
    if ( !next ) return;

    // A custom screen keeps playing over the scene it moves to
    if ( this.session?.custom && this.session.onTransition(next) ) return;
    if ( !this.#enabled() ) return;
    const sameScene = next.id === canvas.scene?.id;
    if ( sameScene && !game.settings.get(MODULE_ID, this.SETTINGS.REDRAW_SAME_SCENE) ) return;
    this.begin(next, {redraw: sameScene});
  }

  /**
   * A scene starts drawing. Covers the first load, where no tear down happens.
   * @param {Canvas} canvas
   */
  static #onCanvasInit(canvas) {
    const scene = canvas.scene;
    if ( !this.#enabled() || !scene ) return;
    const current = this.session;
    if ( current && !current.closed && (current.custom || !current.preview) && (current.scene?.id === scene.id) ) return;
    const redraw = this.lastSceneId === scene.id;
    if ( redraw && !game.settings.get(MODULE_ID, this.SETTINGS.REDRAW_SAME_SCENE) ) return;
    this.begin(scene, {firstLoad: true, redraw});
  }

  /**
   * The scene finished drawing.
   * @param {Canvas} canvas
   */
  static #onCanvasReady(canvas) {
    this.lastSceneId = canvas.scene?.id ?? null;
    const session = this.session;
    if ( session && (session.custom || !session.preview) && (session.scene?.id === canvas.scene?.id) ) session.markReady();
  }
}

/* -------------------------------------------- */
/*  Initialization                              */
/* -------------------------------------------- */

Hooks.once("init", () => {
  LoadingScreenManager.initialize();
  const module = game.modules.get(MODULE_ID);
  if ( module ) {
    module.api = {
      preview: options => LoadingScreenManager.preview(options),
      hide: () => LoadingScreenManager.hide(),
      resolveMedia,
      refreshCache: () => LoadingScreenManager.refreshCache(),
      manager: LoadingScreenManager,
      custom: {
        list: () => CustomScreens.all(),
        get: key => CustomScreens.get(key),
        play: key => LoadingScreenManager.playCustom(key),
        changeScene: (key, scene) => LoadingScreenManager.changeScene(key, scene),
        preview: key => LoadingScreenManager.previewCustom(key),
        stop: options => LoadingScreenManager.stopCustom(options),
        skip: () => LoadingScreenManager.session?.custom && LoadingScreenManager.session.skip(),
        open: () => new CustomScreensConfig().render({force: true})
      }
    };
  }
});

Hooks.once("ready", () => {
  LoadingScreenManager.refreshCache().catch(err => console.warn("Loading Screen | Cache refresh failed", err));
});

export {LoadingScreenManager, LoadingSession, CustomSession};
