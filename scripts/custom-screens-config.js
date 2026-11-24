/**
 * Loading Screen System: window to manage the custom loading screens.
 * Fork notice (Apache-2.0 §4b): added in 2026 by Drakul for Foundry VTT v14.
 *
 * Edits are saved shortly after each change, and when the window closes. Video and music segments are chosen on
 * segment bars; a timeline above the fields shows when each part happens. A screen has its own scene (where the camera
 * moves) and a destination everyone is forwarded to at the end, which must be another scene.
 */

import {
  ANCHORS, CustomScreens, EASINGS, IMAGE_SECONDS, MOMENTS, MUSIC_ENDS, ZOOMS, forwards, mediaKind, normalizeScreen,
  timelineOf
} from "./custom-screens.js?v=20261124c";
import {formatTime, isVideo} from "./compat.js?v=20261124c";
import {TrimBar, renderTimeline} from "./custom-screens-trim.js?v=20261124c";
import {betaNotice, pageLinks} from "./support.js?v=20261124c";

const MODULE_ID = "custom-loading-screen";
const {ApplicationV2, HandlebarsApplicationMixin, DialogV2} = foundry.applications.api;

/** Localization keys for the select elements. */
const LABELS = Object.freeze({
  anchors: Object.fromEntries(Object.keys(ANCHORS).map(k => [k, `LOADING_SCREEN.Custom.Anchor.${k}`])),
  zooms: Object.fromEntries(ZOOMS.map(k => [k, `LOADING_SCREEN.Custom.Zoom.${k}`])),
  easings: Object.fromEntries(Object.keys(EASINGS).map(k => [k, `LOADING_SCREEN.Custom.Easing.${k}`])),
  moments: Object.fromEntries(MOMENTS.map(k => [k, `LOADING_SCREEN.Custom.Moment.${k}`])),
  musicEnds: Object.fromEntries(MUSIC_ENDS.map(k => [k, `LOADING_SCREEN.Custom.MusicEnds.${k}`]))
});

/** Fields holding a time written as m:ss.s. */
const TIME_FIELDS = Object.freeze(["media.start", "media.end", "music.start", "music.end"]);

/**
 * List of saved custom screens with an editor for the selected one.
 */
export class CustomScreensConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "loading-screen-custom-screens",
    tag: "form",
    classes: ["loading-screen-custom-screens"],
    window: {
      title: "LOADING_SCREEN.Custom.Title",
      icon: "fa-solid fa-clapperboard",
      resizable: true
    },
    position: {width: 860, height: 760},
    form: {
      handler: CustomScreensConfig.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      select: CustomScreensConfig.#onSelect,
      create: CustomScreensConfig.#onCreate,
      duplicate: CustomScreensConfig.#onDuplicate,
      delete: CustomScreensConfig.#onDelete,
      addMacro: CustomScreensConfig.#onAddMacro,
      removeMacro: CustomScreensConfig.#onRemoveMacro,
      preview: CustomScreensConfig.#onPreview,
      play: CustomScreensConfig.#onPlay
    }
  };

  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/custom-screens.html`,
      scrollable: [".ls-cs-list ol", ".ls-cs-editor"]
    },
    footer: {template: "templates/generic/form-footer.hbs"}
  };

  /**
   * Working copies of the saved screens.
   * @type {import("./custom-screens.js").CustomScreenData[]}
   */
  #screens = CustomScreens.all();

  /**
   * Id of the screen being edited.
   * @type {string|null}
   */
  #currentId = this.#screens[0]?.id ?? null;

  /** Edits not saved yet. */
  #dirty = false;

  /** Save shortly after the last change. */
  #saveSoon = foundry.utils.debounce(() => this.#save(), 600);

  /**
   * Segment bars of the edited screen.
   * @type {{media?: TrimBar, music?: TrimBar}}
   */
  #bars = {};

  /** Durations of the edited screen's files, for the timeline. */
  #lengths = {media: NaN, music: NaN};

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const current = this.#current();
    const macros = {};
    const sorted = [...game.macros].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    for ( const macro of sorted ) macros[macro.uuid] = macro.name;
    for ( const {uuid} of current?.macros ?? [] ) {
      if ( uuid && !(uuid in macros) ) {
        macros[uuid] = fromUuidSync(uuid)?.name ?? game.i18n.format("LOADING_SCREEN.Custom.MacroUnknown", {uuid});
      }
    }
    const scenes = {};
    const byName = [...game.scenes].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    for ( const scene of byName ) scenes[scene.id] = scene.name;
    for ( const id of [current?.scene, current?.destination] ) {
      if ( id && !(id in scenes) ) scenes[id] = game.i18n.format("LOADING_SCREEN.Custom.SceneUnknown", {id});
    }
    const time = t => (t ? formatTime(t) : "");
    return Object.assign(context, {
      screens: this.#screens.map(s => ({id: s.id, label: CustomScreens.label(s), active: s.id === this.#currentId})),
      current,
      times: current ? {
        mediaStart: formatTime(current.media.start),
        mediaEnd: time(current.media.end),
        musicStart: formatTime(current.music.start),
        musicEnd: time(current.music.end)
      } : {},
      macroChoices: macros,
      sceneChoices: scenes,
      revealChoices: {fade: "LOADING_SCREEN.Custom.RevealFade", blink: "LOADING_SCREEN.Custom.RevealBlink"},
      labels: LABELS,
      buttons: [
        {type: "button", action: "preview", icon: "fa-solid fa-eye", label: "LOADING_SCREEN.Custom.Preview",
          disabled: !current},
        {type: "button", action: "play", icon: "fa-solid fa-play", label: "LOADING_SCREEN.Custom.PlayAll",
          disabled: !current}
      ]
    });
  }

  /* -------------------------------------------- */

  /**
   * Add the strip with the author's pages and the beta notice under the buttons. It is no part of the window, so it
   * stays through later renders.
   */
  #addSupport() {
    const content = this.element.querySelector(".window-content");
    if ( !content || content.querySelector(":scope > .ls-support") ) return;
    const strip = document.createElement("footer");
    strip.className = "ls-support";
    strip.append(pageLinks({names: true}), betaNotice());
    content.append(strip);
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#addSupport();
    this.#destroyBars();
    this.#lengths = {media: NaN, music: NaN};
    const form = this.element;
    if ( this.#current() ) {
      const labels = {
        start: game.i18n.localize("LOADING_SCREEN.Custom.SegmentStart"),
        end: game.i18n.localize("LOADING_SCREEN.Custom.SegmentEnd"),
        play: game.i18n.localize("LOADING_SCREEN.Custom.TrimPlay"),
        stop: game.i18n.localize("LOADING_SCREEN.Custom.TrimStop"),
        loading: game.i18n.localize("LOADING_SCREEN.Custom.TrimLoading"),
        unavailable: game.i18n.localize("LOADING_SCREEN.Custom.TrimUnavailable"),
        status: game.i18n.localize("LOADING_SCREEN.Custom.TrimStatus")
      };
      for ( const kind of ["media", "music"] ) {
        const root = form.querySelector(`.ls-trim[data-kind="${kind}"]`);
        if ( !root ) continue;
        this.#bars[kind] = new TrimBar(root, {
          kind,
          scope: form,
          labels,
          volume: () => this.#previewVolume(kind),
          onLength: duration => {
            this.#lengths[kind] = duration;
            this.#renderTimeline();
          }
        });
      }
    }
    this.#syncFields();
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    this.#readForm();
    const name = event.target?.name;
    if ( TIME_FIELDS.includes(name) ) this.#rewriteTime(event.target);
    this.#syncFields();
    if ( name === "name" ) this.#refreshLabel();
    if ( name === "media.volume" ) this.#bars.media?.updateVolume();
    if ( name === "music.volume" ) this.#bars.music?.updateVolume();
    this.#dirty = true;
    this.#saveSoon();
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _preClose(options) {
    this.#readForm();
    await super._preClose(options);
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    this.#destroyBars();
    if ( this.#dirty ) this.#save();
  }

  /* -------------------------------------------- */
  /*  Working Copy                                */
  /* -------------------------------------------- */

  /**
   * @returns {import("./custom-screens.js").CustomScreenData|null}
   */
  #current() {
    return this.#screens.find(s => s.id === this.#currentId) ?? null;
  }

  /**
   * Copy the form values into the working copy of the edited screen.
   */
  #readForm() {
    const current = this.#current();
    const form = this.element;
    if ( !current || !(form instanceof HTMLFormElement) || !form.querySelector("[name=name]") ) return;
    const data = foundry.utils.expandObject(new foundry.applications.ux.FormDataExtended(form).object);
    const next = normalizeScreen({
      ...current,
      ...data,
      id: current.id,
      media: {...current.media, ...data.media},
      music: {...current.music, ...data.music},
      camera: {...current.camera, ...data.camera},
      reveal: {...current.reveal, ...data.reveal},
      cover: {...current.cover, ...data.cover},
      macros: Object.values(data.macros ?? {})
    });
    Object.assign(current, next);
  }

  /**
   * Write a time field the way it was understood, for example 83.5 as 1:23.5. An empty end stays empty.
   * @param {HTMLInputElement} input
   */
  #rewriteTime(input) {
    const value = foundry.utils.getProperty(this.#current() ?? {}, input.name);
    if ( typeof value !== "number" ) return;
    input.value = (input.name.endsWith(".end") && !value) ? "" : formatTime(value);
  }

  /**
   * @returns {Promise<void>}
   */
  async #save() {
    this.#dirty = false;
    try {
      await CustomScreens.save(this.#screens);
    } catch(err) {
      this.#dirty = true;
      console.error("Loading Screen | Could not save the custom screens", err);
      ui.notifications.error("LOADING_SCREEN.Custom.SaveFailed", {localize: true});
    }
  }

  /* -------------------------------------------- */
  /*  Form State                                  */
  /* -------------------------------------------- */

  /**
   * Dim fields that do not apply, load the files into the segment bars, and update the timeline and the footer.
   */
  #syncFields() {
    const form = this.element;
    const current = this.#current();
    if ( !form || !current ) return;
    const kind = mediaKind({...current, media: {...current.media, enabled: true}});
    const toggle = (selector, dim) => form.querySelector(selector)?.classList.toggle("ls-disabled", dim);
    toggle(".ls-cs-media-fields", !current.media.enabled);
    toggle(".ls-cs-music-fields", !current.music.enabled);
    toggle(".ls-cs-camera-fields", !current.camera.enabled);
    toggle(".ls-cs-shown", current.media.enabled && (kind === "video"));
    toggle(".ls-cs-showstage", !forwards(current));
    for ( const el of form.querySelectorAll(".ls-cs-blink") ) el.hidden = current.reveal.style !== "blink";
    for ( const el of form.querySelectorAll(".ls-cs-cover-blink") ) el.hidden = current.cover.style !== "blink";
    for ( const el of form.querySelectorAll(".ls-cs-video-only") ) el.hidden = kind !== "video";
    for ( const el of form.querySelectorAll(".ls-cs-picture-only") ) el.hidden = kind === "black";
    const scale = form.querySelector(".ls-cs-scale");
    if ( scale ) scale.hidden = current.camera.zoom !== "custom";
    const duration = form.querySelector("[name=duration]");
    if ( duration ) duration.placeholder = (current.media.enabled && (kind === "image")) ? String(IMAGE_SECONDS) : "0";

    this.#bars.media?.setSource(isVideo(current.media.src) ? current.media.src : "");
    this.#bars.music?.setSource(current.music.src);

    // The destination cannot be the screen's own scene
    for ( const option of form.querySelectorAll("select[name=destination] option") ) {
      option.disabled = !!option.value && (option.value === current.scene);
    }
    this.#renderTimeline();
  }

  #renderTimeline() {
    const el = this.element?.querySelector(".ls-cs-timeline");
    const current = this.#current();
    if ( !el || !current ) return;
    const t = key => game.i18n.localize(`LOADING_SCREEN.Custom.Timeline.${key}`);
    const sceneName = id => game.scenes.get(id)?.name ?? "";
    renderTimeline(el, timelineOf(current, this.#lengths), {
      kinds: {video: t("video"), image: t("image"), black: t("black")},
      stage: `${t("stage")}: ${sceneName(current.scene)}`,
      forward: sceneName(current.destination),
      camera: t("camera"),
      reveal: t("reveal"),
      hold: t("hold"),
      music: t("music"),
      unknown: t("unknown"),
      macro: uuid => fromUuidSync(uuid)?.name ?? t("macro")
    }, current.camera.enabled);
  }

  /**
   * Preview volume of a segment bar: the field value times this client's Music volume.
   * @param {"media"|"music"} kind
   * @returns {number}
   */
  #previewVolume(kind) {
    const field = this.element?.querySelector(`[name="${kind}.volume"]`);
    const volume = Number(field?.value ?? 1);
    const music = Number(game.settings.get("core", "globalPlaylistVolume") ?? 1);
    return Math.clamp((Number.isFinite(volume) ? volume : 1) * (Number.isFinite(music) ? music : 1), 0, 1);
  }

  #destroyBars() {
    for ( const bar of Object.values(this.#bars) ) bar.destroy();
    this.#bars = {};
  }

  /**
   * Update the edited screen's name in the list without a full render.
   */
  #refreshLabel() {
    const current = this.#current();
    const button = this.element?.querySelector(`.ls-cs-item[data-id="${current?.id}"]`);
    if ( button ) button.textContent = CustomScreens.label(current);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /**
   * @this {CustomScreensConfig}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onSelect(event, target) {
    this.#readForm();
    this.#currentId = target.dataset.id;
    this.render();
  }

  /**
   * @this {CustomScreensConfig}
   */
  static async #onCreate() {
    this.#readForm();
    const screen = normalizeScreen({name: game.i18n.localize("LOADING_SCREEN.Custom.NewName")});
    this.#screens.push(screen);
    this.#currentId = screen.id;
    await this.#save();
    this.render();
  }

  /**
   * @this {CustomScreensConfig}
   */
  static async #onDuplicate() {
    this.#readForm();
    const current = this.#current();
    if ( !current ) return;
    const name = game.i18n.format("LOADING_SCREEN.Custom.CopyName", {name: CustomScreens.label(current)});
    const copy = normalizeScreen({...foundry.utils.deepClone(current), id: foundry.utils.randomID(), name});
    this.#screens.push(copy);
    this.#currentId = copy.id;
    await this.#save();
    this.render();
  }

  /**
   * @this {CustomScreensConfig}
   */
  static async #onDelete() {
    this.#readForm();
    const current = this.#current();
    if ( !current ) return;
    const name = foundry.utils.escapeHTML(CustomScreens.label(current));
    const confirmed = await DialogV2.confirm({
      window: {title: "LOADING_SCREEN.Custom.DeleteTitle"},
      content: `<p>${game.i18n.format("LOADING_SCREEN.Custom.DeleteConfirm", {name})}</p>`
    });
    if ( !confirmed ) return;
    this.#screens = this.#screens.filter(s => s.id !== current.id);
    this.#currentId = this.#screens[0]?.id ?? null;
    await this.#save();
    this.render();
  }

  /**
   * @this {CustomScreensConfig}
   */
  static #onAddMacro() {
    this.#readForm();
    this.#current()?.macros.push({uuid: "", when: "end", delay: 0});
    this.render();
  }

  /**
   * @this {CustomScreensConfig}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onRemoveMacro(event, target) {
    this.#readForm();
    this.#current()?.macros.splice(Number(target.dataset.index), 1);
    this.#dirty = true;
    this.#saveSoon();
    this.render();
  }

  /**
   * Play the edited screen on this client only, with its current values, over the viewed scene.
   * @this {CustomScreensConfig}
   */
  static #onPreview() {
    this.#readForm();
    const current = this.#current();
    if ( !current ) return;
    for ( const bar of Object.values(this.#bars) ) bar.stop();
    game.modules.get(MODULE_ID)?.api?.custom?.preview(foundry.utils.deepClone(current));
  }

  /**
   * Save, then play the edited screen for everyone, forwarding to its destination at the end.
   * @this {CustomScreensConfig}
   */
  static async #onPlay() {
    this.#readForm();
    const current = this.#current();
    if ( !current ) return;
    for ( const bar of Object.values(this.#bars) ) bar.stop();
    await this.#save();
    await game.modules.get(MODULE_ID)?.api?.custom?.play(current.id);
  }

  /**
   * @this {CustomScreensConfig}
   */
  static async #onSubmit() {
    this.#readForm();
    await this.#save();
  }
}
