import "./tokens.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { initialTheme } from "./theme.js";

// Apply the saved theme BEFORE mount so the first paint is correct — an
// inline <script> could do the same job in index.html, but the CSP forbids
// inline scripts. store.theme reads the same localStorage key, so the
// attribute and the UI cannot disagree.
document.documentElement.dataset.theme = initialTheme();

const app = mount(App, { target: document.getElementById("app") });

export default app;
