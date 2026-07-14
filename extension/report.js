// TODO before this ships anywhere beyond personal use: point this at the
// real GitHub repo ("owner/repo") once one exists.
const GITHUB_REPO = "YOUR_GITHUB_USERNAME/doi-extension";
const FALLBACK_EMAIL = "111hui@protonmail.com";

let reportType = "bug";
let screenshotFiles = [];

const typeBugBtn = document.getElementById("type-bug");
const typeFeatureBtn = document.getElementById("type-feature");
const titleEl = document.getElementById("title");
const descriptionEl = document.getElementById("description");
const codeEl = document.getElementById("code");
const screenshotsEl = document.getElementById("screenshots");
const thumbsEl = document.getElementById("thumbs");
const statusEl = document.getElementById("form-status");

typeBugBtn.addEventListener("click", () => setType("bug"));
typeFeatureBtn.addEventListener("click", () => setType("feature"));

function setType(type) {
  reportType = type;
  typeBugBtn.classList.toggle("active", type === "bug");
  typeFeatureBtn.classList.toggle("active", type === "feature");
}

screenshotsEl.addEventListener("change", () => {
  screenshotFiles = Array.from(screenshotsEl.files || []);
  renderThumbs();
});

function renderThumbs() {
  thumbsEl.innerHTML = "";
  screenshotFiles.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    const thumb = document.createElement("div");
    thumb.className = "thumb";

    const img = document.createElement("img");
    img.src = url;
    img.alt = file.name;
    thumb.appendChild(img);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      screenshotFiles.splice(index, 1);
      renderThumbs();
    });
    thumb.appendChild(removeBtn);

    thumbsEl.appendChild(thumb);
  });
}

function buildIssueBody() {
  const version = chrome.runtime.getManifest().version;
  const lines = [
    `**DOI Grabber version:** ${version}`,
    "",
    "### Description",
    descriptionEl.value.trim() || "_(none provided)_",
  ];

  if (codeEl.value.trim()) {
    lines.push("", "### Code / logs", "```", codeEl.value.trim(), "```");
  }

  if (screenshotFiles.length) {
    lines.push(
      "",
      "### Screenshots",
      `_(${screenshotFiles.length} file${screenshotFiles.length === 1 ? "" : "s"} selected — drag them into this box to attach: ${screenshotFiles
        .map((f) => f.name)
        .join(", ")})_`
    );
  }

  return lines.join("\n");
}

document.getElementById("btn-submit").addEventListener("click", () => {
  if (!titleEl.value.trim()) {
    statusEl.className = "error";
    statusEl.textContent = "Please add a title first.";
    return;
  }

  if (GITHUB_REPO.startsWith("YOUR_GITHUB_USERNAME")) {
    statusEl.className = "error";
    statusEl.textContent = "No GitHub repo configured yet — use \"Email Instead\" for now.";
    return;
  }

  const prefix = reportType === "bug" ? "[Bug] " : "[Feature] ";
  const title = prefix + titleEl.value.trim();
  const body = buildIssueBody();
  const label = reportType === "bug" ? "bug" : "enhancement";

  const url =
    `https://github.com/${GITHUB_REPO}/issues/new` +
    `?title=${encodeURIComponent(title)}` +
    `&body=${encodeURIComponent(body)}` +
    `&labels=${encodeURIComponent(label)}`;

  chrome.tabs.create({ url });
  statusEl.className = "ok";
  statusEl.textContent = "Opened GitHub — attach screenshots there.";
});

document.getElementById("fallback-email-address").textContent = FALLBACK_EMAIL;

// mailto: links depend on the OS having a default mail app registered —
// with none configured, clicking one does nothing at all, silently. Copying
// the report as text works regardless of mail setup.
document.getElementById("btn-email-fallback").addEventListener("click", async () => {
  const prefix = reportType === "bug" ? "Bug report: " : "Feature request: ";
  const subject = prefix + (titleEl.value.trim() || "(no title)");
  const body = buildIssueBody().replace(/```/g, "");
  const text = `To: ${FALLBACK_EMAIL}\nSubject: ${subject}\n\n${body}`;

  try {
    await navigator.clipboard.writeText(text);
    statusEl.className = "ok";
    statusEl.textContent = `Copied — paste into an email to ${FALLBACK_EMAIL}.`;
  } catch (err) {
    statusEl.className = "error";
    statusEl.textContent = "Couldn't copy to clipboard: " + err.message;
  }
});
