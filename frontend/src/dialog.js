// dialog.js — shared native <dialog> helper.
//
// showModal() is imperative, so it cannot be an attribute. The $effect that
// calls it re-runs when a mutation re-renders the dialog, hence the guard on
// `open`. Shared by the three modals (column/index/relationship) so the guard
// lives in one place instead of being copied per dialog.
/**
 * @param {{ open: boolean, showModal: () => void } | null} dlg
 */
export function showDialog(dlg) {
	if (dlg && !dlg.open) dlg.showModal();
}
