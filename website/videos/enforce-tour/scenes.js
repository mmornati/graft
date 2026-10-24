/* Enforce mode, step by step: scenes of a canvas video (see ../engine/engine.js and the canvas-video skill).
 *
 * The third episode of the series, about Phase 1: modes and the ceiling, approvals that count, break-glass and the
 * audit log, the post-merge guard and its revert pull requests, the MCP server, the rollout runbook and the gate.
 * Same herbarium sheet as the other two (DESIGN.md). The acme organisation, its people and pull requests are
 * fictional; the check titles, comment lines and CLI output follow Graft's real renderers and docs.
 *
 * Each scene is fn(t, d, cues), a pure function of t; animations hook onto at(cues, i).
 */
"use strict";

const FELL = '"IM Fell English", "Iowan Old Style", Georgia, serif';
const LIT = 'Literata, "Iowan Old Style", Georgia, serif';
const CP = '"Courier Prime", "Courier New", monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const GMONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const G = {
  board: "#e4e8df", sheet: "#f6f7f2", edge: "#cfd6c9", label: "#fbfaf2", ink: "#16212a", ink2: "#3c4950", ink3: "#536066",
  rule: "#bcc5b8", cambium: "#2f8a22", cambiumInk: "#22681a", soft: "#d5e8c8", tape: "#e3d8b0", tapeLine: "#b9ab78",
  sensitive: "#b42318", logic: "#8a5600", trivial: "#22681a", code: "#eceee6",
};
const RISK = { trivial: G.trivial, logic: G.logic, sensitive: G.sensitive };
/* the GitHub surface (light theme) */
const GH = {
  bg: "#ffffff", fg: "#1f2328", muted: "#59636e", border: "#d1d9e0", subtle: "#f6f8fa", link: "#0969da", open: "#1a7f37",
  neutral: "#59636e", code: "#eff1f3", tab: "#fd8c73", WARNING: "#9a6700", CAUTION: "#d1242f", IMPORTANT: "#8250df", NOTE: "#0969da",
  btn: "#1f883d",
};


/* ------------------------------------------------------------------ herbarium helpers */

function rot(x, y, a, fn) { ctx.save(); ctx.translate(x, y); ctx.rotate(a * Math.PI / 180); fn(); ctx.restore(); }
function alpha(k, fn) { if (k <= 0) return; ctx.save(); ctx.globalAlpha *= clamp(k); fn(); ctx.restore(); }

function plate(num, caption, k, o = {}) {
  const x = o.x ?? 80, y = o.y ?? 82;
  text(`Plate ${num}.`, x, y, { size: 21, weight: "italic 400", font: FELL, color: G.cambiumInk, alpha: k });
  const w = measure(`Plate ${num}.`, 21, "italic 400", FELL);
  text(caption.toUpperCase(), x + w + 12, y - 1, { size: 12, weight: 700, font: CP, color: G.ink3, spacing: "1.2px", alpha: k });
}
function head(l1, l2, k1, k2, o = {}) {
  const x = o.x ?? 80, y = o.y ?? 146, size = o.size ?? 46, gap = o.gap ?? size * 1.04;
  text(l1, x, y + (1 - outCubic(k1)) * 14, { size, font: FELL, color: G.ink, alpha: k1, align: o.align });
  if (l2) text(l2, x, y + gap + (1 - outCubic(k2)) * 14, { size, weight: "italic 400", font: FELL, color: G.cambiumInk, alpha: k2, align: o.align });
}
function sheet(x, y, w, h, o = {}) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.shadowColor = o.pinned ? "rgba(0,0,0,0.16)" : "rgba(22,33,42,0.22)";
  ctx.shadowBlur = o.pinned ? 12 : 16; ctx.shadowOffsetY = o.pinned ? 5 : 7;
  rr(x, y, w, h, o.r ?? 4); ctx.fillStyle = o.fill ?? G.sheet; ctx.fill();
  ctx.shadowColor = "transparent";
  if (o.stroke !== false) { ctx.lineWidth = o.lw ?? 1; ctx.strokeStyle = o.stroke ?? G.edge; ctx.stroke(); }
  ctx.restore();
}
function rule(x1, x2, y, w = 1, color = G.rule, k = 1) { if (k > 0) line([[x1, y], [lerp(x1, x2, clamp(k)), y]], color, w); }
function cropMarks(x, y, w, h, color = G.ink3, a = 0.7) {
  const s = 18;
  [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    line([[cx, cy + dy * s], [cx, cy], [cx + dx * s, cy]], color, 1.2, a);
  });
}
function tape(x, y, w, h, a, k = 1) {
  alpha(k, () => rot(x, y, a, () => {
    ctx.fillStyle = G.tape; ctx.globalAlpha *= 0.92; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = G.tapeLine; ctx.lineWidth = 1; ctx.strokeRect(-w / 2, -h / 2, w, h);
  }));
}
function lbl(s, x, y, o = {}) { text(s, x, y, { size: o.size ?? 14, weight: o.weight ?? 400, font: CP, color: o.color ?? G.ink, align: o.align, alpha: o.alpha, spacing: o.spacing }); }
function body(s, x, y, o = {}) { text(s, x, y, { size: o.size ?? 18, weight: o.weight ?? 400, font: LIT, color: o.color ?? G.ink, align: o.align, alpha: o.alpha }); }

/* A small risk tag: the class word plus the stamp's outline (single, dashed, double). Returns its width. */
function riskTag(cls, x, y, k = 1) {
  const col = RISK[cls], w = measure(cls.toUpperCase(), 13, 700, CP) + 22, h = 26;
  alpha(k, () => {
    ctx.save(); ctx.strokeStyle = col;
    if (cls === "logic") { ctx.lineWidth = 2; ctx.setLineDash([4, 3]); rr(x, y - h / 2, w, h, 4); ctx.stroke(); }
    else if (cls === "sensitive") { ctx.lineWidth = 2.4; rr(x, y - h / 2, w, h, 13); ctx.stroke(); }
    else { ctx.lineWidth = 1.6; rr(x, y - h / 2, w, h, 13); ctx.stroke(); }
    ctx.restore();
    lbl(cls.toUpperCase(), x + w / 2, y + 4.5, { size: 13, weight: 700, color: col, align: "center", spacing: "1px" });
  });
  return w;
}

/* The Graft mark (docs/assets/brand/mark.svg), drawn as the graft takes: stem, scion, leaf, tape. */
function mark(cx, cy, s, k = 1) {
  const X = u => cx + (u - 32) * s, Y = v => cy + (v - 32) * s;
  const k1 = seg(k, 0, 0.3), k2 = seg(k, 0.3, 0.6), k3 = seg(k, 0.55, 0.8), k4 = seg(k, 0.75, 1);
  if (k1 > 0) line(partial([[X(32), Y(60)], [X(32), Y(30)]], outCubic(k1)), "#18222b", 7 * s);
  if (k2 > 0) line(partial([[X(32), Y(31)], [X(47), Y(8)]], outCubic(k2)), "#2a7d1e", 6 * s);
  alpha(k3, () => {
    ctx.translate(X(47), Y(8)); ctx.scale(outBack(k3), outBack(k3)); ctx.translate(-X(47), -Y(8));
    ctx.beginPath(); ctx.moveTo(X(47), Y(8));
    ctx.bezierCurveTo(X(41), Y(9), X(37), Y(13), X(37), Y(18));
    ctx.bezierCurveTo(X(43), Y(17), X(47), Y(13), X(47), Y(8));
    ctx.fillStyle = "#2a7d1e"; ctx.fill();
  });
  alpha(k4, () => {
    rr(X(25), Y(29) - (1 - outCubic(k4)) * 6 * s, 14 * s, 11 * s, 1.5 * s); ctx.fillStyle = "#e9e3c8"; ctx.fill();
    ctx.strokeStyle = "#18222b"; ctx.lineWidth = 2 * s; ctx.stroke();
    line([[X(26), Y(33)], [X(38), Y(33)]], "#18222b", 1.4 * s);
    line([[X(26), Y(36.5)], [X(38), Y(36.5)]], "#18222b", 1.4 * s);
  });
}

function board() {
  ctx.fillStyle = G.board; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = G.edge;
  for (let x = 40; x < W; x += 40) { ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 40; y < H; y += 40) { ctx.globalAlpha = 0.55 * Math.sin(Math.PI * y / H); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.restore();
  const g = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 780);
  g.addColorStop(0, "rgba(228,232,223,0.9)"); g.addColorStop(1, "rgba(228,232,223,0.15)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  cropMarks(28, 26, W - 56, H - 64, G.ink3, 0.55);
}

/* Field notes in the left column: a word in Courier, ticked off as the narration reaches it. */
function notes(items, t, x = 80, y = 290) {
  items.forEach(([s, k0, sub], i) => {
    const k = seg(t, k0 - 0.2, k0 + 0.3), yy = y + i * 52;
    alpha(0.35 + 0.65 * k, () => {
      ctx.save(); ctx.strokeStyle = k > 0.5 ? G.cambiumInk : G.ink3; ctx.lineWidth = 1.6; rr(x, yy - 15, 18, 18, 3); ctx.stroke(); ctx.restore();
      if (k > 0) check(x + 9, yy - 6, 12, G.cambiumInk, k);
      lbl(s, x + 30, yy, { size: 15, weight: 700, color: G.ink });
      if (sub) lbl(sub, x + 30, yy + 19, { size: 12, color: G.ink3 });
    });
  });
}

const STR = {
  en: {
    fictional: "ACME IS FICTIONAL · TEXT FROM GRAFT'S RENDERERS AND DOCS",
    docs: "mmornati.github.io/graft/docs",
  },
};

/* ------------------------------------------------------------------ shared pieces of this episode */

const REPO = "acme/payments";

/* A code sheet: lines [{s, at, c, b}] typed in from `at`; a line whose `at` is in the future is not drawn. */
function codeSheet(x, y, w, h, t, lines, o = {}) {
  const k = o.k ?? 1;
  alpha(k, () => {
    ctx.save(); rr(x, y, w, h, 4); ctx.fillStyle = G.code; ctx.fill(); ctx.strokeStyle = G.edge; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
    const size = o.size ?? 14, lh = o.lh ?? 23;
    lines.forEach((l, i) => {
      if (t < l.at) return;
      const cmd = l.s.startsWith("$ ");
      const s = cmd ? typed(l.s, seg(t, l.at, l.at + Math.min(1.4, l.s.length * 0.025))) : l.s;
      lbl(s, x + 16, y + 28 + i * lh, { size, weight: l.b ? 700 : 400, color: l.c ?? (cmd ? G.ink : G.ink2), alpha: cmd ? 1 : seg(t, l.at, l.at + 0.3) });
    });
  });
}

/* GitHub-like status icons. */
function okIcon(x, y, k = 1) { alpha(k, () => { dot(x, y, 8.5, GH.open); check(x, y, 9, "#fff", 1); }); }
function failIcon(x, y, k = 1) { alpha(k, () => { dot(x, y, 8.5, GH.CAUTION); cross(x, y, 7, "#fff", 1); }); }
function neutralIcon(x, y, k = 1) { alpha(k, () => { ring(x, y, 7.5, GH.neutral, 2); line([[x - 3.2, y], [x + 3.2, y]], GH.neutral, 2); }); }
function statusIcon(state, x, y, k = 1) { (state === "success" ? okIcon : state === "failure" ? failIcon : neutralIcon)(x, y, k); }

/* A white GitHub surface with a title bar. */
function ghCard(x, y, w, h, title, o = {}) {
  alpha(o.alpha ?? 1, () => {
    ctx.save(); ctx.shadowColor = "rgba(22,33,42,0.18)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6;
    rr(x, y, w, h, 6); ctx.fillStyle = GH.bg; ctx.fill(); ctx.restore();
    ctx.save(); rr(x, y, w, h, 6); ctx.strokeStyle = GH.border; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
    if (title) {
      ctx.save(); rr(x, y, w, 38, 6); ctx.clip(); ctx.fillStyle = GH.subtle; ctx.fillRect(x, y, w, 38); ctx.restore();
      line([[x, y + 38], [x + w, y + 38]], GH.border, 1);
      text(title, x + 16, y + 25, { size: 14, weight: 600, font: SANS, color: GH.fg });
    }
  });
}
function sans(s, x, y, o = {}) { text(s, x, y, { size: o.size ?? 14, weight: o.weight ?? 400, font: SANS, color: o.color ?? GH.fg, align: o.align, alpha: o.alpha }); }

/* One check run row: icon, bold name, muted title. */
function checkRow(x, y, w, name, state, title, k = 1) {
  alpha(k, () => {
    statusIcon(state, x + 12, y);
    sans(name, x + 30, y + 5, { weight: 600 });
    const nw = measure(name, 14, 600, SANS);
    const max = w - nw - 50; let s = title;
    while (measure(s, 14, 400, SANS) > max && s.length > 4) s = s.slice(0, -2);
    if (s !== title) s = s.slice(0, -1) + "…";
    sans(s, x + 38 + nw, y + 5, { color: GH.muted });
  });
}

/* A GitHub label chip. */
function ghLabel(s, x, y, color, k = 1) {
  const w = measure(s, 12, 600, SANS) + 18;
  alpha(k, () => {
    ctx.save(); rr(x, y - 11, w, 22, 11); ctx.fillStyle = color; ctx.fill(); ctx.restore();
    sans(s, x + w / 2, y + 4, { size: 12, weight: 600, color: "#fff", align: "center" });
  });
  return w;
}

/* A rubber stamp, rotated. */
function stamp(s, x, y, color, k, a = -6, size = 22) {
  if (k <= 0) return;
  const w = measure(s, size, 700, CP) + 30, h = size + 20, sc = 1 + (1 - outCubic(k)) * 0.6;
  alpha(k, () => rot(x, y, a, () => {
    ctx.scale(sc, sc);
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 3; rr(-w / 2, -h / 2, w, h, 6); ctx.stroke();
    ctx.lineWidth = 1; rr(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 4); ctx.stroke(); ctx.restore();
    lbl(s, 0, size * 0.36, { size, weight: 700, color, align: "center", spacing: "2px" });
  }));
}

/* ------------------------------------------------------------------ 1 · title */

function sTitle(t, d, cues) {
  const a0 = at(cues, 0, 1.4), a1 = at(cues, 1, 7);
  sheet(110, 92, 1060, 470, { alpha: seg(t, 0, 0.6) });
  cropMarks(130, 112, 1020, 430, G.edge, seg(t, 0.2, 0.8));
  mark(210, 210, 2.2, seg(t, 0.2, 1.8));
  lbl("GRAFT · VIDEO DOCUMENTATION · PHASE 1", 290, 180, { size: 12, weight: 700, color: G.ink3, spacing: "1.2px", alpha: seg(t, 0.4, 1) });
  head("Enforce mode,", "step by step.", seg(t, 0.6, 1.3), seg(t, 0.9, 1.6), { x: 290, y: 240, size: 50 });
  const cards = [["Count approvals", "graft/policy"], ["Watch main", "the post-merge guard"], ["Talk to agents", "the MCP server"]];
  cards.forEach(([h, s], i) => {
    const k = seg(t, a0 + 1.4 + i * 1.1, a0 + 1.9 + i * 1.1), x = 200 + i * 300, y = 360;
    alpha(k, () => {
      sheet(x, y + (1 - outCubic(k)) * 16, 270, 100, { fill: G.label, pinned: true });
      tape(x + 135, y, 64, 15, i % 2 ? 2 : -2);
      body(h, x + 18, y + 46, { size: 21, weight: 600 });
      lbl(s, x + 18, y + 76, { size: 13, color: G.ink3 });
    });
  });
  stamp("REPORT BY DEFAULT", 930, 245, G.logic, seg(t, a1 + 0.6, a1 + 1.1), -7, 24);
  alpha(seg(t, a1, a1 + 0.6), () => lbl(S.fictional, 640, 528, { size: 12, weight: 700, color: G.ink3, align: "center", spacing: "1.2px" }));
}

/* ------------------------------------------------------------------ 2 · modes and the ceiling */

function sModes(t, d, cues) {
  const c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 4));
  plate("I", "Modes and the ceiling", seg(t, 0, 0.5));
  head("Three keys,", "one ceiling.", seg(t, 0.1, 0.7), seg(t, c[2], c[2] + 0.6), { size: 44, y: 140 });
  notes([["policy_mode", c[0] + 0.6, "report · enforce"], ["guard_mode", c[0] + 1.3, "report · enforce"], ["mcp_write", c[0] + 2.0, "off · on"]], t, 80, 290);
  alpha(seg(t, c[1] + 2.4, c[1] + 3), () => {
    lbl("set by the operator", 80, 470, { size: 13, weight: 700, color: G.cambiumInk });
    lbl("never by graft.yaml, a label or a PR", 80, 490, { size: 13, color: G.ink3 });
  });
  const X = 420, Y = 210, w = 780;
  const L = [
    { s: `$ pnpm graft mode set --repo ${REPO} --policy enforce --reason "pilot"`, at: c[1] + 0.2 },
    { s: "acme/payments: policy report -> enforce (audited)", at: c[1] + 1.6, c: G.cambiumInk },
    { s: `$ pnpm graft mode show --repo ${REPO}`, at: c[2] },
    { s: "  ceiling    report   (worker)", at: c[2] + 1.0, b: true },
    { s: "  policy     requested enforce  effective report   ceiling", at: c[2] + 1.6 },
    { s: "  guard      requested report   effective report", at: c[2] + 1.9 },
    { s: "  mcp_write  requested off      effective off", at: c[2] + 2.2 },
  ];
  codeSheet(X, Y, w, 190, t, L, { k: seg(t, c[1] - 0.3, c[1] + 0.2), size: 14, lh: 24 });
  // the ceiling caps the request: the lower of the two wins
  const kc = seg(t, c[2] + 2.4, c[2] + 3);
  alpha(kc, () => {
    ctx.save(); ctx.strokeStyle = G.logic; ctx.lineWidth = 2; rr(X + 8, Y + 110, w - 16, 30, 4); ctx.stroke(); ctx.restore();
  });
  stamp("LOWER WINS", X + w - 120, Y + 166, G.logic, seg(t, c[2] + 3, c[2] + 3.5), 6, 18);
  // the mutation guard refuses a write the effective mode does not allow
  const k3 = seg(t, c[3], c[3] + 0.5), y3 = 470;
  alpha(k3, () => {
    sheet(X, y3, 250, 70, { fill: G.label, pinned: true });
    lbl("a GitHub write", X + 16, y3 + 28, { size: 12, color: G.ink3 });
    lbl("POST …/git/refs", X + 16, y3 + 52, { size: 15, weight: 700 });
    sheet(X + 330, y3, 200, 70, { fill: G.sheet });
    lbl("allow-list", X + 346, y3 + 28, { size: 12, color: G.ink3 });
    lbl("guard_mode: report", X + 346, y3 + 52, { size: 15, weight: 700 });
  });
  arrow(X + 258, y3 + 35, X + 322, y3 + 35, seg(t, c[3] + 0.5, c[3] + 1), G.ink2);
  const kr = seg(t, c[3] + 1.1, c[3] + 1.6);
  cross(X + 580, y3 + 35, 22, G.sensitive, kr);
  alpha(kr, () => lbl("refused", X + 606, y3 + 41, { size: 17, weight: 700, color: G.sensitive }));
}

/* ------------------------------------------------------------------ 3 · approvals that count */

function sApprovals(t, d, cues) {
  const c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 4));
  plate("II", "Approvals that count", seg(t, 0, 0.5));
  head("Approvals", "that count.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0), { size: 44, y: 140 });
  notes([["write access", c[1] + 1.2], ["current head", c[1] + 2.4], ["verified team", c[1] + 3.6]], t, 80, 300);
  const enforce = t >= c[1] + 0.4;
  alpha(seg(t, 0.4, 1), () => {
    const w = 290; ctx.save(); rr(80, 470, w, 48, 4); ctx.fillStyle = enforce ? G.soft : G.code; ctx.fill(); ctx.restore();
    lbl(enforce ? "policy_mode: enforce" : "policy_mode: report", 96, 500, { size: 15, weight: 700, color: enforce ? G.cambiumInk : G.ink2 });
  });
  const X = 420, Y = 200, w = 780;
  ghCard(X, Y, w, 136, "Checks · #212 Add idempotency keys to refunds", { alpha: seg(t, 0.3, 0.9) });
  // the policy row in its four states
  let state = "neutral", title = "Would require 1 human (1 from @acme/payments-team) · report only";
  if (t >= c[1] + 0.4) { state = "failure"; title = "Needs 1 more approval from @acme/payments-team"; }
  if (t >= c[3] + 0.6) { state = "success"; title = "Policy satisfied: required approvals present"; }
  alpha(seg(t, 0.6, 1.2), () => {
    checkRow(X + 8, Y + 64, w - 16, "graft/intent", "neutral", "Risk: logic · Add idempotency keys to refund requests");
    line([[X, Y + 86], [X + w, Y + 86]], GH.border, 1);
    checkRow(X + 8, Y + 110, w - 16, "graft/policy", state, title);
  });
  highlight(X + 4, Y + 92, w - 8, 36, seg(t, c[0] + 0.6, c[0] + 1.2) - seg(t, c[1] + 4.5, c[1] + 5), G.cambiumInk);
  // report mode: the would-be line
  alpha(seg(t, c[0] + 1.4, c[0] + 2) - seg(t, c[1], c[1] + 0.4), () => {
    sheet(X, Y + 152, w, 52, { fill: G.label, pinned: true });
    const h1 = "In enforce mode this check would be: ", x1 = X + 16 + measure(h1, 15, 600, SANS);
    text(h1, X + 16, Y + 184, { size: 15, weight: 600, font: SANS, color: GH.fg });
    lbl("failure", x1, Y + 184, { size: 15, weight: 700, color: G.sensitive });
    sans(", needs 1 more approval from @acme/payments-team.", x1 + measure("failure", 15, 700, CP), Y + 184, { size: 15 });
  });
  // the reviews: dana, then a push, then lee
  const RY = Y + 230;
  const rows = [
    { who: "dana", what: "approved these changes", sha: "4c9e1f2", at: c[1] + 1.0, team: false },
    { who: "acme-agent[bot]", what: "pushed 1 commit", sha: "7a1d0e3", at: c[2] + 0.2, push: true },
    { who: "lee", what: "approved these changes", sha: "7a1d0e3", at: c[3] + 0.1, team: true },
  ];
  rows.forEach((r, i) => {
    const k = seg(t, r.at, r.at + 0.5), y = RY + i * 50;
    alpha(k, () => {
      ghCard(X, y, w, 42, null);
      if (r.push) { ring(X + 22, y + 21, 8, GH.muted, 2); }
      else { dot(X + 22, y + 21, 10, GH.open); check(X + 22, y + 21, 10, "#fff", 1); }
      sans(r.who, X + 42, y + 26, { weight: 600 });
      sans(r.what, X + 48 + measure(r.who, 14, 600, SANS), y + 26, { color: GH.muted });
      lbl(r.sha, X + 470, y + 26, { size: 13, color: GH.muted });
      if (r.team) lbl("@acme/payments-team ✓", X + 560, y + 26, { size: 13, weight: 700, color: G.cambiumInk });
    });
    if (i === 0) {
      const ks = seg(t, c[2] + 0.8, c[2] + 1.3);
      alpha(ks, () => { line([[X + 40, y + 21], [X + 450, y + 21]], G.ink3, 1.5); lbl("stale: older commit", X + 560, y + 26, { size: 13, weight: 700, color: G.logic }); });
    }
  });
}

/* ------------------------------------------------------------------ 4 · break-glass */

function sBreakGlass(t, d, cues) {
  const c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 3.6));
  plate("III", "Break-glass", seg(t, 0, 0.5));
  head("One label,", "one commit.", seg(t, 0.1, 0.7), seg(t, c[1], c[1] + 0.6), { size: 44, y: 140 });
  notes([["maintain or admin", c[0] + 0.8], ["one commit only", c[1] + 0.4], ["triage: ignored", c[2] + 0.4], ["every use audited", c[3] + 0.3]], t, 80, 290);
  const X = 420, Y = 200, w = 780;
  ghCard(X, Y, w, 84, "#215 Hotfix: settlement cut-off time", { alpha: seg(t, 0.3, 0.9) });
  let state = "failure", title = "Needs 1 more approval from @acme/payments-team";
  if (t >= c[0] + 1.6) { state = "success"; title = "Bypassed by break-glass (maya)"; }
  if (t >= c[1] + 1.4) { state = "failure"; title = "Needs 1 more approval from @acme/payments-team"; }
  alpha(seg(t, 0.6, 1.2), () => checkRow(X + 8, Y + 62, w - 16, "graft/policy", state, title));
  const ev = [
    { at: c[0] + 0.6, who: "maya", role: "maintain", text: "added", label: true, sha: "4c9e1f2" },
    { at: c[1] + 0.6, who: "maya", role: "maintain", text: "pushed 1 commit", sha: "9b2c4e1" },
    { at: c[2] + 0.3, who: "sam", role: "triage", text: "added", label: true, sha: "9b2c4e1", ignored: true },
  ];
  ev.forEach((e, i) => {
    const y = Y + 106 + i * 44, k = seg(t, e.at, e.at + 0.5);
    alpha(k, () => {
      line([[X + 22, y - 14], [X + 22, y + 14]], GH.border, 2);
      dot(X + 22, y, 6, e.label ? GH.IMPORTANT : GH.muted);
      sans(e.who, X + 40, y + 5, { weight: 600 });
      const x1 = X + 46 + measure(e.who, 14, 600, SANS);
      sans(`(${e.role}) ${e.text}`, x1, y + 5, { color: GH.muted });
      const x2 = x1 + measure(`(${e.role}) ${e.text}`, 14, 400, SANS) + 8;
      if (e.label) ghLabel("graft:break-glass", x2, y, "#b60205");
      lbl(e.sha, X + 640, y + 5, { size: 13, color: GH.muted });
    });
  });
  // the ignored line, as the policy section words it
  alpha(seg(t, c[2] + 1.2, c[2] + 1.7), () => {
    sheet(X, Y + 236, w, 46, { fill: G.label, pinned: true });
    text("Break-glass label ignored:", X + 16, Y + 265, { size: 14, weight: 700, font: SANS, color: GH.fg });
    sans("applied by sam (triage). Only maintain or admin can bypass the policy.", X + 206, Y + 265);
  });
  codeSheet(X, Y + 300, w, 112, t, [
    { s: `$ pnpm graft audit list --repo ${REPO}`, at: c[3] + 0.2 },
    { s: "2026-10-24T10:41Z  ignored  #215  9b2c4e1  sam (triage)       enforce", at: c[3] + 1.2 },
    { s: "2026-10-24T10:32Z  stale    #215  4c9e1f2  maya (maintain)    enforce", at: c[3] + 1.4 },
    { s: "2026-10-24T10:18Z  applied  #215  4c9e1f2  maya (maintain)    enforce", at: c[3] + 1.6 },
  ], { k: seg(t, c[3] - 0.3, c[3] + 0.2), size: 13, lh: 22 });
}

/* ------------------------------------------------------------------ 5 · the post-merge guard */

function sGuard(t, d, cues) {
  const c = [0, 1, 2].map((i, j) => at(cues, i, 0.5 + j * 5));
  plate("IV", "The post-merge guard", seg(t, 0, 0.5));
  head("Watching main,", "after the merge.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0), { size: 44, y: 140 });
  // main as a branch line with five commits
  const Y = 300, X0 = 120, X1 = 1160;
  line(partial([[X0, Y], [X1, Y]], outCubic(seg(t, c[0], c[0] + 1.2))), G.ink, 3);
  lbl("main", X0 - 40, Y + 5, { size: 14, weight: 700, color: G.ink3, alpha: seg(t, c[0], c[0] + 0.5) });
  const C = [
    { sha: "1f04ab2", pr: "#209", at: c[0] + 0.3, s: "green" },
    { sha: "8d33c71", pr: "#210", at: c[0] + 0.6, s: "green" },
    { sha: "5e1a9c0", pr: "#211", at: c[1] + 0.1, s: "red" },
    { sha: "c27e4d8", pr: "#213", at: c[1] + 3.0, s: "red2" },
  ];
  C.forEach((m, i) => {
    const x = 260 + i * 240, k = seg(t, m.at, m.at + 0.4);
    alpha(k, () => {
      dot(x, Y, 13, G.sheet); ring(x, Y, 13, G.ink, 3);
      lbl(m.sha, x, Y + 44, { size: 13, color: G.ink3, align: "center" });
      lbl(`merged ${m.pr}`, x, Y + 64, { size: 13, weight: 700, align: "center" });
      // its CI result, a moment after it lands
      const kr = seg(t, m.at + 0.8, m.at + 1.2);
      const ok = m.s === "green";
      alpha(kr, () => {
        rr(x - 34, Y - 56, 68, 26, 13); ctx.fillStyle = ok ? G.soft : "#f6d9d6"; ctx.fill();
        lbl("test", x + 6, Y - 38, { size: 12, weight: 700, color: ok ? G.cambiumInk : G.sensitive, align: "center" });
      });
      if (ok) check(x - 22, Y - 43, 10, G.cambiumInk, kr); else cross(x - 22, Y - 43, 8, G.sensitive, kr);
    });
  });
  // waiting for confirmation, then confirmed
  const kw = seg(t, c[1] + 1.4, c[1] + 1.9) - seg(t, c[1] + 4, c[1] + 4.4);
  alpha(kw, () => lbl("red · waiting for the next commit", 740, Y - 80, { size: 13, weight: 700, color: G.logic, align: "center" }));
  stamp("CONFIRMED", 740, Y - 94, G.sensitive, seg(t, c[1] + 4.2, c[1] + 4.7), -4, 18);
  alpha(seg(t, c[1] + 4.6, c[1] + 5.2), () => {
    lbl("a green re-run instead: flaky, nobody is blamed", 120, Y + 104, { size: 13, color: G.ink3 });
  });
  // the guard comment on the culprit, in the renderer's words
  const kc = seg(t, c[2], c[2] + 0.6), CX = 300, CY = 440, CW = 680;
  arrow(740, Y + 76, 740, CY - 6, seg(t, c[2] + 0.2, c[2] + 0.7), G.sensitive);
  alpha(kc, () => {
    ghCard(CX, CY, CW, 150, "Comment on #211 Add retry to the settlement job");
    text("Graft guard", CX + 16, CY + 64, { size: 17, weight: 700, font: SANS, color: GH.fg });
    sans("CI check test went red on main at 5e1a9c0 after this pull request was merged.", CX + 16, CY + 90);
    sans("It was green at 8d33c71, the commit before.", CX + 16, CY + 110);
    sans("• Confirmed by: the next commit c27e4d8 is also red", CX + 16, CY + 136, { color: GH.muted });
  });
}

/* ------------------------------------------------------------------ 6 · revert pull requests */

function sRevert(t, d, cues) {
  const c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 3.8));
  plate("V", "Revert pull requests", seg(t, 0, 0.5));
  head("Undo it,", "without reading it.", seg(t, 0.1, 0.7), seg(t, c[1], c[1] + 0.6), { size: 44, y: 140 });
  const X = 80, Y = 236;
  // the revert pull request
  alpha(seg(t, c[0] + 0.3, c[0] + 0.9), () => {
    ghCard(X, Y, 520, 128, null);
    dot(X + 24, Y + 30, 9, GH.open);
    sans("Revert #211 (Graft guard)", X + 42, Y + 36, { size: 18, weight: 600 });
    sans("graft[bot] wants to merge 1 commit · @omar", X + 42, Y + 64, { color: GH.muted });
    ghLabel("graft:revert", X + 42, Y + 96, "#5319e7");
    lbl("Graft-Agent: graft-guard", X + 170, Y + 101, { size: 13, color: GH.muted });
  });
  // the tree, from blob SHAs only
  const TX = 660, TY = 236, TW = 540;
  alpha(seg(t, c[1], c[1] + 0.5), () => {
    sheet(TX, TY, TW, 128, { fill: G.label, pinned: true });
    lbl("revert tree = main's tree, with", TX + 16, TY + 28, { size: 13, color: G.ink3 });
    const R = [["src/settle/retry.ts", "blob 81c2d0e", "blob 3f9a71b"], ["src/settle/job.ts", "blob 0d6e2aa", "blob 77b19c4"], ["test/settle/retry.test.ts", "added", "removed"]];
    R.forEach(([p, a, b], i) => {
      const y = TY + 56 + i * 24, k = seg(t, c[1] + 0.5 + i * 0.4, c[1] + 0.9 + i * 0.4);
      alpha(k, () => {
        lbl(p, TX + 16, y, { size: 13, weight: 700 });
        lbl(`${a} → ${b}`, TX + 300, y, { size: 13, color: G.cambiumInk });
      });
    });
  });
  alpha(seg(t, c[1] + 2, c[1] + 2.5), () => lbl("Git Data API · blob SHAs only · no file contents fetched or stored", TX + 16, TY + 150, { size: 13, weight: 700, color: G.cambiumInk }));
  // a later commit touched the same file: a human decides
  alpha(seg(t, c[2], c[2] + 0.5), () => {
    sheet(X, 420, 520, 96, { fill: G.sheet });
    lbl("#216 merged later and changed", X + 16, 450, { size: 13, color: G.ink3 });
    lbl("src/settle/job.ts", X + 16, 474, { size: 15, weight: 700 });
    lbl("no merge attempted · the guard comment lists the path", X + 16, 498, { size: 12, color: G.ink3 });
  });
  stamp("NEEDS HUMAN", X + 440, 446, G.logic, seg(t, c[2] + 0.8, c[2] + 1.3), -6, 18);
  // opt-in auto-merge by risk class
  const AX = 660, AY = 420;
  alpha(seg(t, c[3], c[3] + 0.5), () => {
    sheet(AX, AY, TW, 150, { fill: G.label, pinned: true });
    lbl("guard:", AX + 16, AY + 30, { size: 14, weight: 700 });
    lbl("  auto_merge_reverts: [trivial, logic]", AX + 16, AY + 52, { size: 14 });
  });
  ["trivial", "logic", "sensitive"].forEach((cls, i) => {
    const k = seg(t, c[3] + 0.8 + i * 0.6, c[3] + 1.2 + i * 0.6), x = AX + 16 + i * 175, y = AY + 92;
    riskTag(cls, x, y, k);
    const ok = cls !== "sensitive";
    if (ok) check(x + 10, y + 32, 10, G.cambiumInk, k); else cross(x + 10, y + 32, 8, G.sensitive, k);
    alpha(k, () => lbl(ok ? "auto-merge" : "never", x + 26, y + 37, { size: 13, weight: 700, color: ok ? G.cambiumInk : G.sensitive }));
  });
  alpha(seg(t, c[3] + 3.4, c[3] + 4), () => lbl("branch protection and required checks still decide", 80, 560, { size: 13, weight: 700, color: G.ink2 }));
}

/* ------------------------------------------------------------------ 7 · the MCP server */

function sMcp(t, d, cues) {
  const c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 3.8));
  plate("VI", "The MCP server", seg(t, 0, 0.5));
  head("Agents ask", "Graft directly.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0), { size: 44, y: 140 });
  // the agent and the endpoint
  alpha(seg(t, c[0], c[0] + 0.5), () => {
    sheet(80, 270, 230, 70, { fill: G.label, pinned: true });
    lbl("coding agent", 96, 298, { size: 12, color: G.ink3 });
    lbl("claude-code", 96, 322, { size: 16, weight: 700 });
    sheet(80, 400, 230, 70, { fill: G.sheet });
    lbl("Graft server", 96, 428, { size: 12, color: G.ink3 });
    lbl("POST /mcp", 96, 452, { size: 16, weight: 700 });
  });
  arrow(195, 346, 195, 394, seg(t, c[0] + 0.5, c[0] + 1), G.ink2);
  packets(195, 346, 195, 394, t, { n: 2, period: 1.6, color: G.cambium, r: 3 });
  // the four tools
  const TOOLS = [
    ["get_status", "card, provenance, verdict, guard events", c[0] + 1.6, "read"],
    ["get_policy", "the effective policy and modes", c[0] + 2.0, "read"],
    ["report_provenance", "agent, model, task, session", c[2], "tightens only"],
    ["open_change", "open a PR from a pushed branch", c[3], "mcp_write: on"],
  ];
  TOOLS.forEach(([n, s, k0, tag], i) => {
    const x = 400 + (i % 2) * 400, y = 236 + Math.floor(i / 2) * 120, k = seg(t, c[0] + 1 + i * 0.3, c[0] + 1.5 + i * 0.3);
    alpha(k, () => {
      sheet(x, y, 380, 100, { fill: G.label, pinned: true });
      lbl(n, x + 16, y + 34, { size: 17, weight: 700 });
      body(s, x + 16, y + 64, { size: 15, color: G.ink2 });
      const kt = seg(t, k0, k0 + 0.5);
      alpha(kt, () => {
        const tw = measure(tag, 12, 700, CP) + 18;
        ctx.save(); rr(x + 16, y + 74, tw, 20, 10); ctx.fillStyle = i < 2 ? G.soft : "#f3e6c8"; ctx.fill(); ctx.restore();
        lbl(tag, x + 25, y + 88, { size: 12, weight: 700, color: i < 2 ? G.cambiumInk : G.logic });
      });
    });
  });
  highlight(396, 352, 388, 108, seg(t, c[2], c[2] + 0.5) - seg(t, c[3] - 0.3, c[3]), G.logic);
  highlight(796, 352, 388, 108, seg(t, c[3], c[3] + 0.5), G.logic);
  // the token
  codeSheet(400, 486, 780, 92, t, [
    { s: `$ pnpm graft mcp-token create --repo ${REPO}`, at: c[1] + 0.2 },
    { s: "shown once · one repository · stored as a hash · rate-limited", at: c[1] + 1.4, c: G.cambiumInk, b: true },
  ], { k: seg(t, c[1] - 0.3, c[1] + 0.2), size: 14, lh: 26 });
  alpha(seg(t, c[3] + 4, c[3] + 4.6), () => {
    lbl("signed commits", 80, 520, { size: 14, weight: 700, color: G.cambiumInk });
    lbl("or no approval counts", 80, 540, { size: 13, color: G.ink3 });
  });
}

/* ------------------------------------------------------------------ 8 · rollout and the gate */

function sRollout(t, d, cues) {
  const c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 4));
  plate("VII", "Rollout and the gate", seg(t, 0, 0.5));
  head("One repository,", "one stage at a time.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0), { size: 40, y: 136 });
  const ST = [["0", "deployment", "ready", c[0] + 0.5], ["1", "install", "report", c[1]], ["2", "watch", "14 days · 30 PRs", c[1] + 1.4],
    ["3", "enforce", "policy", c[1] + 2.6], ["4", "enforce", "guard", c[1] + 3.6], ["5", "auto-merge", "optional", c[1] + 4.4], ["6", "mcp_write", "optional", c[1] + 4.8]];
  const Y = 290, X0 = 120, step = 173;
  line(partial([[X0, Y], [X0 + step * 6, Y]], outCubic(seg(t, c[0], c[1] + 4.8))), G.cambiumInk, 2.5);
  ST.forEach(([n, a, b, k0], i) => {
    const x = X0 + i * step, k = seg(t, k0, k0 + 0.4);
    alpha(0.25 + 0.75 * k, () => {
      dot(x, Y, 17, k > 0.5 ? G.cambiumInk : G.sheet); ring(x, Y, 17, G.cambiumInk, 2);
      lbl(n, x, Y + 5, { size: 15, weight: 700, color: k > 0.5 ? "#fff" : G.cambiumInk, align: "center" });
      lbl(a, x, Y + 44, { size: 13, weight: 700, align: "center" });
      lbl(b, x, Y + 63, { size: 12, color: G.ink3, align: "center" });
    });
  });
  // the gate
  const GX = 80, GY = 390, GW = 1120;
  alpha(seg(t, c[2], c[2] + 0.5), () => {
    sheet(GX, GY, GW, 196, { fill: G.label, pinned: true });
    text("The Phase 1 gate", GX + 20, GY + 40, { size: 26, weight: "italic 400", font: FELL, color: G.cambiumInk });
    lbl("five pilots · pnpm graft gate report --phase 1", GX + 280, GY + 37, { size: 13, color: G.ink3 });
  });
  const M = [["≥ 30%", "PRs merged", "with no human"], ["−50%", "review minutes", "per agent PR"], ["≥ 80%", "breakages", "caught"], ["no rise", "escaped", "defects"]];
  M.forEach(([v, a, b], i) => {
    const x = GX + 20 + i * 275, k = seg(t, c[3] + 0.3 + i * 1.6, c[3] + 0.8 + i * 1.6);
    alpha(k, () => {
      text(v, x, GY + 108 + (1 - outCubic(k)) * 10, { size: 40, font: FELL, color: G.ink });
      lbl(a, x, GY + 140, { size: 14, weight: 700 });
      lbl(b, x, GY + 160, { size: 13, color: G.ink3 });
    });
  });
  alpha(seg(t, c[3] + 6.8, c[3] + 7.4), () => lbl("measured in enforce mode · previewed from report mode", GX + GW - 20, GY + 182, { size: 12, color: G.ink3, align: "right" }));
}

/* ------------------------------------------------------------------ 9 · close */

function sClose(t, d, cues) {
  const a1 = at(cues, 1, 3.6);
  ctx.save(); ctx.globalAlpha *= seg(t, 0, 0.4) * 0.85; ctx.fillStyle = G.soft; ctx.fillRect(0, 0, W, H); ctx.restore();
  mark(W / 2, 150, 1.5, seg(t, 0, 1.2));
  head("Report first,", "then enforce one repository at a time.", seg(t, 0.2, 0.8), seg(t, 0.5, 1.1), { x: W / 2, y: 262, size: 52, align: "center" });
  alpha(seg(t, 1.4, 2), () => {
    const s = `pnpm graft mode show --repo ${REPO}`, w = measure(s, 17, 400, CP) + 48;
    ctx.save(); rr(W / 2 - w / 2, 384, w, 46, 4); ctx.fillStyle = G.code; ctx.fill(); ctx.strokeStyle = G.edge; ctx.stroke(); ctx.restore();
    lbl(s, W / 2, 413, { size: 17, align: "center" });
    lbl("the rollout runbook: docs/pilots/phase-1-runbook", W / 2, 456, { size: 13, color: G.ink3, align: "center" });
  });
  alpha(seg(t, a1 - 0.2, a1 + 0.4), () => {
    const s = S.docs, w = measure(s, 18, 600, LIT) + 48;
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6;
    rr(W / 2 - w / 2, 486, w, 50, 3); ctx.fillStyle = G.cambiumInk; ctx.fill(); ctx.restore();
    body(s, W / 2, 518, { size: 18, weight: 600, color: "#fff", align: "center" });
  });
}

/* ------------------------------------------------------------------ video */

VIDEO.create({
  title: { en: "Enforce mode, step by step" },
  kicker: { en: "Graft · video documentation" },
  langs: ["en"],
  theme: {
    bg: G.board, bg2: G.board, panel: G.sheet, panel2: "#1d2a24", line: G.rule, ink: G.ink, soft: G.ink2, faint: G.ink3,
    accent: G.cambiumInk, accent2: G.cambium, good: G.trivial, warn: G.logic, bad: G.sensitive, deep: G.soft, term: "#15201b", termInk: "#e8ede4",
  },
  strings: STR,
  background: board,
  poster: "revert",
  fonts: ['400 20px "IM Fell English"', 'italic 400 20px "IM Fell English"', '400 20px Literata', '600 20px Literata',
    '400 20px "Courier Prime"', '700 20px "Courier Prime"'],
  scenes: {
    title: sTitle, modes: sModes, approvals: sApprovals, breakglass: sBreakGlass, guard: sGuard,
    revert: sRevert, mcp: sMcp, rollout: sRollout, close: sClose,
  },
});
