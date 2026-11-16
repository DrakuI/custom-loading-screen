/**
 * Loading Screen System: Scene configuration tab.
 * Fork notice (Apache-2.0 §4b): rewritten in 2026 for Foundry VTT v14. Values are stored in scene flags and saved by
 * the Scene sheet itself; the tab is placed before the form footer and also holds the per-scene music and the choice
 * of a custom screen.
 */

const MODULE_ID = "custom-loading-screen";
const TAB_ID = "loadingScreen";
const TEMPLATE = `modules/${MODULE_ID}/templates/scene-config-tab.html`;

/**
 * Add the Loading Screen tab to the Scene configuration sheet.
 */
export function registerSceneConfigTab() {
  const SceneConfig = foundry.applications.sheets.SceneConfig;

  // Tab entry
  const tabs = SceneConfig.TABS.sheet.tabs;
  if ( !tabs.some(t => t.id === TAB_ID) ) {
    tabs.push({id: TAB_ID, icon: "fa-solid fa-hourglass-half", label: "LOADING_SCREEN.SceneTab"});
  }

  // Part, keeping the footer last so every added tab renders above the buttons
  const {footer, [TAB_ID]: _existing, ...parts} = SceneConfig.PARTS;
  parts[TAB_ID] = {template: TEMPLATE, scrollable: [""]};
  if ( footer ) parts.footer = footer;
  SceneConfig.PARTS = parts;

  Hooks.on("renderSceneConfig", onRenderSceneConfig);
}

/**
 * Enable the custom music path only when the music mode asks for it, and dim the default-screen fields while a custom
 * screen is chosen.
 * @param {foundry.applications.sheets.SceneConfig} app
 * @param {HTMLElement} element
 */
function onRenderSceneConfig(app, element) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  const tab = root?.querySelector(`.tab[data-tab="${TAB_ID}"]`);
  if ( !tab ) return;

  const screen = tab.querySelector(`[name="flags.${MODULE_ID}.screen"]`);
  if ( screen ) {
    const syncScreen = () => tab.classList.toggle("ls-custom-chosen", !!screen.value);
    screen.addEventListener("change", syncScreen);
    syncScreen();
  }

  const mode = tab.querySelector(`[name="flags.${MODULE_ID}.soundMode"]`);
  const sound = tab.querySelector(`[name="flags.${MODULE_ID}.sound"]`);
  if ( !mode || !sound ) return;
  const sync = () => {
    const custom = mode.value === "custom";
    sound.closest(".form-group")?.classList.toggle("ls-disabled", !custom);
    if ( typeof sound.disabled === "boolean" ) sound.disabled = !custom;
  };
  mode.addEventListener("change", sync);
  sync();
}
