// Graft landing page: theme switch and the risk-floor plate. No network, no storage beyond the theme choice.
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");
  // the graft "takes" once, on the first painted frame; a page that never paints visibly keeps the rested state
  if (window.requestAnimationFrame) requestAnimationFrame(function () { root.classList.add("takes"); });

  // theme switch: light <-> dark, remembered per browser when storage is available
  var btn = document.querySelector(".theme");
  function current() {
    var t = root.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (btn) {
    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("graft-theme", next); } catch (e) { /* private mode: not remembered */ }
    });
  }

  // the floor: final class = max(floor, writer, verifier, logic if the verifier disagrees)
  var plate = document.querySelector("[data-floor]");
  if (!plate) return;
  var ORDER = ["trivial", "logic", "sensitive"];
  var files = plate.querySelectorAll(".floor__files input");
  var writer = plate.querySelector('[data-model="writer"]');
  var verifier = plate.querySelector('[data-model="verifier"]');
  var disagree = plate.querySelector("[data-disagree]");
  var steps = plate.querySelectorAll("[data-step]");
  var floorMark = plate.querySelector("[data-floor-mark]");
  var stamp = plate.querySelector("[data-stamp]");
  var text = plate.querySelector("[data-verdict-text]");
  var COLOR = { trivial: "var(--trivial)", logic: "var(--logic)", sensitive: "var(--sensitive)" };

  function rank(c) { return ORDER.indexOf(c); }

  function update() {
    var floor = 0, reasons = [];
    files.forEach(function (f) {
      if (!f.checked) return;
      var r = rank(f.value);
      var path = f.parentNode.querySelector("code").textContent;
      if (r > floor) { floor = r; reasons = []; }
      if (r === floor && r > 0) reasons.push(f.getAttribute("data-why") + " (" + path + ")");
    });
    var w = rank(writer.value), v = rank(verifier.value), d = disagree.checked ? 1 : 0;
    var fin = Math.max(floor, w, v, d);
    var cls = ORDER[fin];

    steps.forEach(function (s, i) {
      s.classList.toggle("is-below", i < floor);
      s.classList.toggle("is-final", i === fin);
      s.style.setProperty("--c", COLOR[ORDER[i]]);
    });
    floorMark.style.left = "calc(" + (floor * 100 / 3) + "% - 1px)";

    stamp.className = "stamp stamp--" + cls;
    stamp.querySelector("span").textContent = cls;

    var floorText = floor === 0 ? "nothing in the rules matched" : reasons.join("; ");
    var msg = "Floor " + ORDER[floor] + ": " + floorText + ". ";
    if (fin === floor) {
      msg += (w < floor || v < floor) ? "A model said less; it cannot lower the floor. Final: " + cls + "." : "Final: " + cls + ".";
    } else {
      var by = [];
      if (w === fin) by.push("the writer");
      if (v === fin) by.push("the verifier");
      if (d && fin === 1 && !by.length) by.push("the verifier's disagreement");
      msg += "Raised to " + cls + " by " + (by.join(" and ") || "a model") + ".";
    }
    text.textContent = msg;
  }

  plate.addEventListener("change", update);
  update();
})();
