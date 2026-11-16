export const FRAME_CSS = `
:root { color-scheme: dark; }
:root[data-scheme="light"] { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
body {
  color: var(--text); font: 400 14px/22px "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif;
  font-feature-settings: "cv11", "ss01"; -webkit-font-smoothing: antialiased; overflow-wrap: anywhere;
}
#root { display: flow-root; padding: 2px 0; }
.v-column, .v-row { display: flex; min-width: 0; }
.v-column { flex-direction: column; }
.v-row { flex-direction: row; }
.v-row > * { min-width: 0; }
.v-row > .v-chart, .v-row > .v-canvas, .v-row > .v-scene, .v-row > .v-shader, .v-row > .v-slider, .v-row > .v-table { flex: 1 1 0; }
.v-grid { display: grid; min-width: 0; }
.v-hover { border-radius: 6px; margin: -4px -6px; padding: 4px 6px; transition: background-color 100ms ease; }
.v-hover:hover, .v-hover:focus-visible { background: color-mix(in oklab, var(--text) 6%, transparent); }
tr.v-hover { margin: 0; padding: 0; }
.v-clickable { cursor: pointer; outline: none; }
.v-clickable:focus-visible { box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 60%, transparent); }
.v-text { min-width: 0; white-space: pre-wrap; }
.v-heading { letter-spacing: -0.01em; }
.v-mono { font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace; font-size: 0.93em; }
.v-truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v-rule { height: 1px; background: var(--border); flex: none; align-self: stretch; }
.v-row > .v-rule { width: 1px; height: auto; }
.v-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.v-stat-value { font-size: 19px; line-height: 27px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 8px; }
.v-stat-delta { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
.v-stat-label { font-size: 12px; line-height: 18px; color: var(--muted); }
.v-table { overflow-x: auto; min-width: 0; }
.v-table table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
.v-table th { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--muted); padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.v-table td { padding: 6px 10px; border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent); vertical-align: top; }
.v-table th:first-child, .v-table td:first-child { padding-left: 0; }
.v-table th:last-child, .v-table td:last-child { padding-right: 0; }
.v-table tr.v-hover:hover td { background: color-mix(in oklab, var(--text) 5%, transparent); }
.v-chart, .v-canvas, .v-scene, .v-shader { position: relative; min-width: 0; width: 100%; }
.v-chart svg { position: relative; display: block; overflow: visible; font-variant-numeric: tabular-nums; }
.v-canvas canvas, .v-scene canvas, .v-shader canvas { display: block; width: 100%; }
button { font: inherit; color: inherit; }
.v-button {
  height: 28px; padding: 0 12px; border-radius: 6px; border: 0; cursor: pointer; font-size: 13px; font-weight: 500;
  background: color-mix(in oklab, var(--text) 8%, transparent); color: var(--text);
  transition: background-color 100ms ease, transform 120ms ease; align-self: flex-start;
}
.v-button:hover { background: color-mix(in oklab, var(--text) 12%, transparent); }
.v-button:active { transform: scale(0.97); }
.v-primary { background: var(--accent); color: var(--on-accent); }
.v-primary:hover { background: color-mix(in oklab, var(--accent) 88%, var(--text)); }
.v-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: color-mix(in oklab, var(--text) 6%, transparent); align-self: flex-start; max-width: 100%; overflow-x: auto; }
.v-tab { height: 24px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: color 100ms ease, background-color 100ms ease; }
.v-tab:hover { color: var(--text); }
.v-tab[aria-selected="true"] { background: color-mix(in oklab, var(--text) 10%, transparent); color: var(--text); }
.v-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; user-select: none; align-self: flex-start; }
.v-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.v-switch { width: 28px; height: 16px; border-radius: 999px; background: color-mix(in oklab, var(--text) 16%, transparent); position: relative; transition: background-color 150ms ease; flex: none; }
.v-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 999px; background: var(--text); transition: transform 150ms cubic-bezier(0.23, 1, 0.32, 1); }
.v-toggle input:checked + .v-switch { background: var(--accent); }
.v-toggle input:checked + .v-switch::after { transform: translateX(12px); background: var(--on-accent); }
.v-toggle input:focus-visible + .v-switch { box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 60%, transparent); }
.v-slider { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
.v-slider-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 18px; color: var(--muted); }
.v-slider-value { color: var(--text); font-variant-numeric: tabular-nums; }
.v-slider input { -webkit-appearance: none; appearance: none; width: 100%; height: 16px; background: transparent; margin: 0; cursor: pointer; }
.v-slider input::-webkit-slider-runnable-track { height: 4px; border-radius: 999px; background: linear-gradient(to right, var(--accent) var(--fill), color-mix(in oklab, var(--text) 14%, transparent) var(--fill)); }
.v-slider input::-moz-range-track { height: 4px; border-radius: 999px; background: linear-gradient(to right, var(--accent) var(--fill), color-mix(in oklab, var(--text) 14%, transparent) var(--fill)); }
.v-slider input::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 999px; background: var(--text); border: 0; transition: transform 120ms ease; }
.v-slider input::-moz-range-thumb { width: 14px; height: 14px; border-radius: 999px; background: var(--text); border: 0; }
.v-slider input:active::-webkit-slider-thumb { transform: scale(1.15); }
.v-slider input:focus-visible { outline: none; }
.v-slider input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 50%, transparent); }
.v-link { color: var(--text); text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; align-self: flex-start; }
.v-link:hover { text-decoration-color: var(--text); }
.v-label { position: absolute; pointer-events: none; font-size: 11px; line-height: 16px; color: var(--muted); white-space: nowrap; transform: translate(-50%, -50%); }
.v-error { margin-top: 8px; font: 12px/18px "Geist Mono Variable", ui-monospace, Menlo, monospace; color: var(--danger); white-space: pre-wrap; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
:root[data-motion="reduce"] * { transition: none !important; }
`
