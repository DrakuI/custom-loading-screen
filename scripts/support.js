/**
 * Loading Screen System: links to the author's pages and the notice about the beta of the next version.
 * Fork notice (Apache-2.0 §4b): added in 2026 by Drakul.
 */

const MODULE_ID = "custom-loading-screen";

/** The author's pages. The first one is where the beta is published. */
export const PAGES = Object.freeze([
  {id: "patreon", label: "Patreon", icon: "fa-brands fa-patreon", url: "https://patreon.com/noiterpg"},
  {id: "discord", label: "Discord", icon: "fa-brands fa-discord", url: "https://discord.gg/RNTmfrcmUC"}
]);

function icon(classes) {
  const node = document.createElement("i");
  node.className = classes;
  node.setAttribute("inert", "");
  return node;
}

function anchor(url, classes) {
  const node = document.createElement("a");
  node.className = classes;
  node.href = url;
  node.target = "_blank";
  node.rel = "noopener";
  return node;
}

/**
 * A link to one of the author's pages.
 * @param {object} page       An entry of PAGES
 * @param {boolean} named     Show the page's name beside its icon; without it the name is the tooltip
 * @returns {HTMLAnchorElement}
 */
function pageLink(page, named) {
  const link = anchor(page.url, `ls-page ls-page-${page.id}`);
  link.append(icon(page.icon));
  if ( named ) link.append(page.label);
  else {
    link.dataset.tooltip = page.label;
    link.setAttribute("aria-label", page.label);
  }
  return link;
}

/**
 * Links to the author's pages.
 * @param {object} [options]
 * @param {boolean} [options.names=false]  Show each page's name beside its icon; without it the name is the tooltip
 * @returns {HTMLSpanElement}
 */
export function pageLinks({names=false}={}) {
  const links = document.createElement("span");
  links.className = "ls-pages";
  links.append(...PAGES.map(page => pageLink(page, names)));
  return links;
}

/**
 * The notice that a beta of the next version is published on Patreon, as a link to it.
 * @returns {HTMLAnchorElement}
 */
export function betaNotice() {
  const link = anchor(PAGES[0].url, "ls-beta");
  link.append(icon("fa-solid fa-flask"), game.i18n.localize("LOADING_SCREEN.Support.Beta"));
  return link;
}

/**
 * Put the links beside the title of the module's section, and the beta notice under it, with the link to the page
 * the beta is published on. Foundry gives the sections of Configure Settings no title: when another module made one,
 * the links go right after its text, before the buttons that module adds; with no title, the section gets one with
 * the module's name.
 * @param {HTMLElement} section
 */
function place(section) {
  if ( section.querySelector(".ls-pages") ) return;
  let title = section.querySelector(":scope > h2");
  if ( !title ) {
    title = document.createElement("h2");
    title.className = "ls-settings-title";
    title.textContent = game.modules.get(MODULE_ID)?.title ?? MODULE_ID;
    section.prepend(title);
  }
  const text = [...title.childNodes].find(node => (node.nodeType === Node.TEXT_NODE) && node.textContent.trim());
  if ( text ) text.after(pageLinks());
  else title.append(pageLinks());
  const notice = document.createElement("p");
  notice.className = "ls-beta-notice";
  notice.append(betaNotice(), pageLink(PAGES[0], true));
  title.after(notice);
}

/**
 * Runs on the renderSettingsConfig hook. The links go in after the other hooks of the same render, because that is
 * where other modules make the section's title.
 * @param {Application} app
 * @param {HTMLElement|JQuery} html
 */
export function onRenderSettingsConfig(app, html) {
  const root = (html instanceof HTMLElement) ? html : html?.[0];
  const section = root?.querySelector(`section[data-category="${MODULE_ID}"]`)
    ?? root?.querySelector(`section[data-tab="${MODULE_ID}"]`);
  if ( section ) queueMicrotask(() => place(section));
}
