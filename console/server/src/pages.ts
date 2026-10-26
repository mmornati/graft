// The only server-rendered page: sign-in. It uses the web app's stylesheet and no script.

export type LoginPageState = { state: "start" } | { state: "error"; message: string };

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

export const MARK_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><path class="mk-stock" d="M32 60V30" fill="none" stroke-width="7" stroke-linecap="round"/><path class="mk-scion" d="M32 31L47 8" fill="none" stroke-width="6" stroke-linecap="round"/><path class="mk-leaf" d="M47 8c-6 1-10 5-10 10 6-1 10-5 10-10z"/><rect class="mk-tape" x="25" y="29" width="14" height="11" rx="1.5" stroke-width="2"/><path class="mk-line" d="M26 33h12M26 36.5h12" stroke-width="1.4"/></svg>`;

export function loginPage(cssHref: string, s: LoginPageState): string {
  const body =
    s.state === "error"
      ? `<p class="login__error" role="alert">${esc(s.message)}</p>
         <a class="btn btn--primary" href="/auth/login?start=1">Try again with GitHub</a>`
      : `<p class="login__lead">The console reads what Graft recorded: pull requests, intent cards, verdicts, guard events and jobs. It cannot change anything.</p>
         <a class="btn btn--primary" href="/auth/login?start=1">Sign in with GitHub</a>
         <p class="login__fine">Only the operators listed in <code>CONSOLE_ALLOWED_USERS</code> get in. GitHub tells the console who you are; the console keeps nothing else.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Graft Console</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${esc(cssHref)}">
</head>
<body>
<main class="login">
  <div class="login__sheet">
    <span class="crop crop--tl" aria-hidden="true"></span><span class="crop crop--br" aria-hidden="true"></span>
    <p class="wordmark">${MARK_SVG}Graft <small>console</small></p>
    <h1>Sign in</h1>
    ${body}
  </div>
</main>
</body>
</html>`;
}
