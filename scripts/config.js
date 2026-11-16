/**
 * Loading Screen System: configuration dialogs.
 * Fork notice (Apache-2.0 §4b): rewritten in 2026 for Foundry VTT v14 with ApplicationV2. The unused per-scene folder
 * dialog was removed (scenes are configured from their own sheet) and a preview dialog was added.
 */

const MODULE_ID = "custom-loading-screen";
const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/**
 * Edit the custom tip list, one tip per line.
 */
export class CustomTipsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "loading-screen-custom-tips",
    tag: "form",
    classes: ["loading-screen-tips-config"],
    window: {
      title: "LOADING_SCREEN.CustomTipsTitle",
      icon: "fa-solid fa-lightbulb",
      resizable: true,
      contentClasses: ["standard-form"]
    },
    position: {width: 640, height: 560},
    form: {
      handler: CustomTipsConfig.#onSubmit,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {template: `modules/${MODULE_ID}/templates/custom-tips.html`},
    footer: {template: "templates/generic/form-footer.hbs"}
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const customTips = game.settings.get(MODULE_ID, "customTips") ?? "";
    return Object.assign(context, {
      customTips,
      count: customTips.split(/\r?\n/).filter(t => t.trim()).length,
      placeholder: game.i18n.localize("LOADING_SCREEN.CustomTipsPlaceholder"),
      buttons: [{type: "submit", icon: "fa-solid fa-floppy-disk", label: "LOADING_SCREEN.Save"}]
    });
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const area = this.element.querySelector("textarea[name=customTips]");
    const counter = this.element.querySelector(".ls-tip-count");
    area?.addEventListener("input", () => {
      const count = area.value.split(/\r?\n/).filter(t => t.trim()).length;
      if ( counter ) counter.textContent = game.i18n.format("LOADING_SCREEN.CustomTipsCount", {count});
    });
  }

  /**
   * @this {CustomTipsConfig}
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   * @param {FormDataExtended} formData
   */
  static async #onSubmit(event, form, formData) {
    await game.settings.set(MODULE_ID, "customTips", formData.object.customTips ?? "");
    ui.notifications.info("LOADING_SCREEN.CustomTipsSaved", {localize: true});
  }
}

/* -------------------------------------------- */

/**
 * Show the loading screen on this client for a chosen scene, without loading it.
 */
export class LoadingScreenPreview extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "loading-screen-preview",
    tag: "form",
    classes: ["loading-screen-preview"],
    window: {
      title: "LOADING_SCREEN.PreviewTitle",
      icon: "fa-solid fa-eye",
      contentClasses: ["standard-form"]
    },
    position: {width: 460},
    form: {
      handler: LoadingScreenPreview.#onSubmit,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {template: `modules/${MODULE_ID}/templates/preview.html`},
    footer: {template: "templates/generic/form-footer.hbs"}
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const scenes = {};
    for ( const scene of game.scenes.contents.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang)) ) {
      scenes[scene.id] = scene.name;
    }
    return Object.assign(context, {
      scenes,
      sceneId: canvas.scene?.id ?? game.scenes.current?.id ?? "",
      duration: 8,
      buttons: [{type: "submit", icon: "fa-solid fa-play", label: "LOADING_SCREEN.PreviewButton"}]
    });
  }

  /**
   * @this {LoadingScreenPreview}
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   * @param {FormDataExtended} formData
   */
  static async #onSubmit(event, form, formData) {
    const {sceneId, duration} = formData.object;
    game.modules.get(MODULE_ID)?.api?.preview({
      scene: game.scenes.get(sceneId) ?? null,
      duration: Math.clamp(Number(duration) || 8, 1, 120)
    });
  }
}
