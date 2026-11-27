const themeButton = document.getElementById("theme");
const nextTheme = { auto: "light", light: "dark", dark: "auto" };

function currentTheme() {
  return document.documentElement.dataset.theme || "auto";
}

function describeTheme() {
  const current = currentTheme();
  themeButton.title = `Colour theme: ${current}. Switch to ${nextTheme[current]}.`;
  themeButton.setAttribute("aria-label", themeButton.title);
}

themeButton.addEventListener("click", () => {
  const next = nextTheme[currentTheme()] || "auto";
  if (next === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    if (next === "auto") localStorage.removeItem("atlas-theme");
    else localStorage.setItem("atlas-theme", next);
  } catch { /* Keep this page's choice when storage is unavailable. */ }
  describeTheme();
});
describeTheme();
themeButton.hidden = false;

let activeHint;
let pinned = false;

function showHint(hint) {
  if (activeHint === hint) return;
  if (activeHint) activeHint.querySelector('[role="tooltip"]').hidden = true;
  activeHint = hint;
  pinned = false;
  if (hint) hint.querySelector('[role="tooltip"]').hidden = false;
}

for (const hint of document.querySelectorAll(".performance-hint")) {
  const button = hint.querySelector("button");
  hint.addEventListener("pointerenter", event => {
    if (event.pointerType !== "touch") showHint(hint);
  });
  hint.closest(".destination").addEventListener("pointerleave", event => {
    if (event.pointerType !== "touch" && activeHint === hint && !pinned && !button.matches(":focus-visible")) showHint(null);
  });
  button.addEventListener("focus", () => {
    if (button.matches(":focus-visible")) showHint(hint);
  });
  button.addEventListener("blur", () => {
    if (activeHint === hint && !pinned) showHint(null);
  });
  button.addEventListener("click", () => {
    if (activeHint === hint && pinned) showHint(null);
    else {
      showHint(hint);
      pinned = true;
    }
  });
}
document.addEventListener("keydown", event => {
  if (event.key === "Escape" || event.key === "Tab") showHint(null);
});
// An open touch hint occupies a row. Keep the layout still until the tap lands.
document.addEventListener("click", event => {
  if (activeHint && !activeHint.contains(event.target)) showHint(null);
});
