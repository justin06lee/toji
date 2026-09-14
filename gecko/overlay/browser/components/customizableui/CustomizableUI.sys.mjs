/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's stand-in for Firefox's CustomizableUI (gecko/overlay). Firefox's
// toolbars, their customization and every widget are gone from the tree; the
// WebExtension browserAction API (ext-browserAction.js, ExtensionPopups,
// ExtensionControlledPopup) and the tab strip still ask this for a toolbar
// button that no longer exists. Every answer is "no such widget": add-ons keep
// working, their buttons are simply nowhere (Toji's Settings switches uBlock
// Origin on and off; the Electron app had no add-on buttons either).

const listeners = new Set();

function noWidget(id) {
  return {
    id,
    type: "custom",
    areaType: null,
    instances: [],
    forWindow() {
      return { node: null, anchor: null, overflowed: false };
    },
  };
}

export const CustomizableUI = {
  AREA_NAVBAR: "nav-bar",
  AREA_MENUBAR: "toolbar-menubar",
  AREA_TABSTRIP: "TabsToolbar",
  AREA_BOOKMARKS: "PersonalToolbar",
  AREA_ADDONS: "unified-extensions-area",
  AREA_FIXED_OVERFLOW_PANEL: "widget-overflow-fixed-list",
  TYPE_TOOLBAR: "toolbar",
  TYPE_PANEL: "panel",
  PROVIDER_XUL: "xul",
  PROVIDER_API: "api",
  PROVIDER_SPECIAL: "special",
  SOURCE_BUILTIN: "builtin",
  SOURCE_EXTERNAL: "external",
  verticalTabsEnabled: false,
  windows: [],
  areas: [],

  addListener(listener) {
    listeners.add(listener);
  },
  removeListener(listener) {
    listeners.delete(listener);
  },

  createWidget(properties) {
    return noWidget(properties?.id);
  },
  destroyWidget() {},
  getWidget(id) {
    return noWidget(id);
  },
  getWidgetsInArea() {
    return [];
  },
  getWidgetIdsInArea() {
    return [];
  },
  getPlacementOfWidget() {
    return null;
  },
  widgetIsLikelyVisible() {
    return false;
  },
  isWebExtensionWidget(id) {
    return typeof id == "string" && id.endsWith("-browser-action");
  },
  isSpecialWidget() {
    return false;
  },
  addWidgetToArea() {},
  removeWidgetFromArea() {},
  moveWidgetWithinArea() {},
  ensureWidgetPlacedInWindow() {},
  getAreaType() {
    return null;
  },
  getCustomizationTarget() {
    return null;
  },
  getCollapsedToolbarIds() {
    return new Set();
  },
  setToolbarVisibility() {},
  hidePanelForNode() {},
  registerPanelNode() {},
  addPanelCloseListeners() {},
  removePanelCloseListeners() {},
  registerToolbarNode() {},
  registerArea() {},
  unregisterArea() {},
  handleNewBrowserWindow() {},
  dispatchToolboxEvent() {},
  reset() {},
  getPanelForNode() {
    return null;
  },
  canWidgetMoveToArea() {
    return false;
  },
  isAreaOverflowable() {
    return false;
  },
  getUnusedWidgets() {
    return [];
  },
  getTestOnlyInternalProp() {
    return null;
  },
};
