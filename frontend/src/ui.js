// ui.js — shared UI helpers: scroll-to-table (tasks 2, 6).
//
// scrollToTable is the single implementation behind the Toolbar's find-table
// jump and the LintPanel's click-to-jump row. Both select first, then scroll
// the card into view; the lookup key differs (id vs name), so the helper takes
// the resolved table id and name. select is injected (setSelected) so this
// stays free of store access and unit-testable with a fake document.

/**
 * Select + scroll a table card into view.
 * @param {string} id table id to select
 * @param {string} name table name used by the card's aria-label
 * @param {(id: string) => void} select
 * @returns {boolean} whether a matching card was found
 */
export function scrollToTable(id, name, select) {
	select(id);
	const el = document.querySelector(`[aria-label="Table ${CSS.escape(name)}"]`);
	el?.scrollIntoView({ block: "center", inline: "center" });
	return !!el;
}
