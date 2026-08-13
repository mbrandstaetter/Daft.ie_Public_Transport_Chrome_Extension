// Panel styles live in a Shadow DOM root so Daft's stylesheets cannot reach in and
// ours cannot leak out.
export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

.panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 330px;
  max-height: min(72vh, 640px);
  display: flex;
  flex-direction: column;
  background: #ffffff;
  color: #1d1d22;
  border-radius: 12px;
  box-shadow: 0 6px 28px rgba(0,0,0,.22);
  z-index: 2147483000;
  font-size: 13px;
  overflow: hidden;
}
.panel[hidden] { display: none; }

header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  background: #12303f; color: #fff;
  cursor: grab;
  user-select: none;
  /* Stops the browser claiming the gesture for panning before we see pointermove. */
  touch-action: none;
}
header.dragging { cursor: grabbing; }
header h1 { font-size: 13px; font-weight: 600; margin: 0; flex: 1; letter-spacing: .01em; }
header .chev { opacity: .8; font-size: 11px; }
header .grip { opacity: .55; font-size: 12px; letter-spacing: -1px; }

/* Nothing should animate under the cursor while dragging. */
.panel.dragging { transition: none; }

/* position:relative makes this the offsetParent for its sections, so scrolling a section
   into view is a straight offsetTop rather than a difference of two offsets. */
.body { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; position: relative; }
.panel.collapsed .body { display: none; }

section { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6a6a76; margin: 0; font-weight: 600; }

.modes { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 9px; border-radius: 999px; cursor: pointer;
  border: 1px solid #d5d5de; background: #fff; font-size: 12px; color: #3a3a44;
}
.chip.on { border-color: transparent; color: #fff; }
.chip .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }

.row { display: flex; align-items: center; gap: 8px; }
.row label { flex: 1; color: #3a3a44; }

input[type=text], input[type=date], input[type=time], select {
  padding: 7px 9px; border: 1px solid #d5d5de; border-radius: 7px;
  font-size: 13px; color: #1d1d22; background: #fff; font-family: inherit;
}
input[type=text] { width: 100%; }
input[type=date], input[type=time] { flex: 1; min-width: 0; }
select { flex: 1; cursor: pointer; }
input:focus, select:focus { outline: 2px solid #2f6f8f; outline-offset: -1px; }

button.btn {
  padding: 7px 11px; border-radius: 7px; border: 1px solid #12303f;
  background: #12303f; color: #fff; cursor: pointer; font-size: 12px; font-weight: 500;
}
button.btn.ghost { background: #fff; color: #12303f; }
button.btn:disabled { opacity: .5; cursor: default; }

.hits { display: flex; flex-direction: column; border: 1px solid #e3e3ea; border-radius: 7px; overflow: hidden; }
.hits button {
  text-align: left; padding: 7px 9px; border: 0; background: #fff; cursor: pointer;
  font-size: 12px; border-bottom: 1px solid #f0f0f4; color: #1d1d22;
}
.hits button:last-child { border-bottom: 0; }
.hits button:hover { background: #f5f7f9; }

.dest { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f0f0f4; }
.dest:last-child { border-bottom: 0; }
.dest .swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.dest .meta { flex: 1; min-width: 0; }
.dest .meta b { display: block; font-size: 12px; font-weight: 600; }
.dest .meta span { display: block; font-size: 11px; color: #7a7a86; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dest button.x { border: 0; background: none; cursor: pointer; color: #9a9aa6; font-size: 15px; line-height: 1; padding: 2px 4px; }
.dest button.x:hover { color: #c0392b; }

.result { border: 1px solid #e3e3ea; border-radius: 9px; padding: 9px 10px; cursor: pointer; }
.result:hover { border-color: #2f6f8f; }
.result.active { border-color: #2f6f8f; box-shadow: 0 0 0 2px rgba(47,111,143,.15); }
.result .head { display: flex; align-items: baseline; gap: 8px; }
.result .head b { flex: 1; font-size: 12px; font-weight: 600; }
.result .head .time { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
.result .head .arrive { font-size: 11px; color: #7a7a86; }
.result .legs { margin-top: 5px; font-size: 11px; color: #55555f; line-height: 1.5; }
.result .legs .seg { white-space: nowrap; }
.result .legs .route { font-weight: 600; padding: 0 4px; border-radius: 3px; color: #fff; }

.muted { color: #7a7a86; font-size: 12px; }
.warn { color: #a3540f; font-size: 12px; background: #fdf3e7; padding: 7px 9px; border-radius: 7px; }
.err { color: #9b2c2c; font-size: 12px; background: #fdeaea; padding: 7px 9px; border-radius: 7px; }
.spinner { font-size: 12px; color: #7a7a86; }

footer { padding: 9px 12px; border-top: 1px solid #f0f0f4; font-size: 10px; color: #8a8a96; line-height: 1.5; }
footer a { color: #2f6f8f; text-decoration: none; }
footer a:hover { text-decoration: underline; }
`;
