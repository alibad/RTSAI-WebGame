/** Layering helpers for surfaces that host UI kit popups (popups are portalled to <body>). */

const OPEN_POPUP = ["select-content", "combobox-content", "popover-content", "dropdown-menu-content"].map(slot => `[data-slot="${slot}"][data-open]`).join(",");

/**
 * True while a kit popup is open. A hand-written dialog that closes on Escape from a window listener checks this, so
 * Escape first closes the open picker (Base UI handles it) and only the next press closes the dialog.
 */
export function kitPopupOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(OPEN_POPUP) !== null;
}
