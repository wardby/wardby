/**
 * Shared CSS for wardby's server-rendered pages: the self-hosted OAuth
 * browser flow (auth/self-hosted/browser.ts) and the secret-entry form
 * (tools/secret-elicitation-form.ts). Both are publicly reachable,
 * dependency-free surfaces — no CDN fonts, no external stylesheets, no
 * external images — so this module is the one inline stylesheet each page
 * embeds in its own `<style>` tag rather than a `<link>`.
 *
 * Tokens follow the naming used by wardby's marketing/dashboard page so this
 * corner of the product reads as the same system: --cream --gold --ink
 * --line --mint --mint-deep --muted --paper --red --shadow --sky --white.
 * Dark mode redefines the same token names under `prefers-color-scheme` —
 * the source page itself has no dark mode, but these pages already did
 * (the secret form's previous inline styles supported it), so it's kept.
 */
export const PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --cream: #fffaf0;
  --paper: #f7f4ec;
  --white: #ffffff;
  --ink: #12243c;
  --muted: #657287;
  --line: #dce3e8;
  --mint: #43e6b1;
  --mint-deep: #15b982;
  --gold: #c9aa70;
  --red: #e33d37;
  --sky: #75d4ff;
  --shadow: 0 24px 70px rgba(6, 23, 47, 0.12);
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0b1524;
    --white: #142238;
    --ink: #f2f6fa;
    --muted: #9fb0c2;
    --line: #263a52;
    --shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--ink);
  background:
    radial-gradient(circle at 12% 0%, rgba(67, 230, 177, 0.14), transparent 26rem),
    radial-gradient(circle at 100% 20%, rgba(117, 212, 255, 0.12), transparent 30rem),
    var(--paper);
  font-family: "Avenir Next", Avenir, "Trebuchet MS", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.card {
  width: 100%;
  max-width: 420px;
  padding: 38px 34px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--white);
  box-shadow: var(--shadow);
}
.kicker {
  margin: 0 0 12px;
  color: var(--mint-deep);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
h1 {
  margin: 0 0 10px;
  font-family: Futura, "Avenir Next", Avenir, sans-serif;
  font-size: 23px;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
p { margin: 0 0 22px; color: var(--muted); font-size: 14px; line-height: 1.55; }
p:last-child { margin-bottom: 0; }
p strong { color: var(--ink); }
label { display: block; margin-bottom: 18px; font-size: 13px; font-weight: 700; color: var(--muted); }
input[type="password"] {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 14px 16px;
  font-size: 16px;
  letter-spacing: 0.02em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
}
input[type="password"]:focus {
  outline: none;
  border-color: var(--mint-deep);
  box-shadow: 0 0 0 3px rgba(21, 185, 130, 0.18);
}
button {
  width: 100%;
  margin-top: 4px;
  padding: 15px;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  color: var(--cream);
  background: var(--ink);
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition: background 140ms ease;
}
button:hover { background: var(--mint-deep); }
button:focus-visible { outline: 3px solid var(--mint-deep); outline-offset: 2px; }
.actions { display: flex; gap: 10px; margin-top: 4px; }
.actions button { margin-top: 0; }
.actions button[value="deny"] {
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
}
.actions button[value="deny"]:hover { background: var(--line); }
#auth-error { margin: 16px 0 0; color: var(--red); font-size: 13px; min-height: 1em; }
`;
