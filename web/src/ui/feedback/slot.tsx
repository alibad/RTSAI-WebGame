// Where the one feedback launcher (ui/Feedback.tsx) sits on each screen. Its own module, so the dialog kit can hold a
// slot without importing the feedback dialog.

/**
 * Marks where the launcher goes on this screen: the HUD bar ("hud", an icon), the menus' utility row ("menu", a
 * labelled button) or an open dialog's header ("dialog", beside its close button). The launcher is drawn over it from
 * the page's top layer; the slot last in the page wins, so an open dialog's slot takes it from the screen beneath.
 */
export function FeedbackSlot({ kind }: { kind: "hud" | "menu" | "dialog" }) {
  return <span className="gfb-slot" data-feedback-slot={kind} aria-hidden="true" />;
}
