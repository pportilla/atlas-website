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
