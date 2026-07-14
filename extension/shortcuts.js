// Single-key shortcuts for popup buttons — active only while the popup
// itself has focus. Separate from chrome.commands (Alt+D / Alt+F, which
// work page-wide) because Chrome caps chrome.commands at 4 assignable
// shortcuts total, nowhere near enough for every popup button.
const POPUP_SHORTCUT_ACTIONS = [
  { id: "download", label: "Download", btnId: "btn-run", defaultKey: "d" },
  { id: "copyDoi", label: "Copy DOI", btnId: "btn-copy", defaultKey: "c" },
  { id: "copyLink", label: "Copy Sci-Hub Link", btnId: "btn-link", defaultKey: "l" },
  { id: "viewSciHub", label: "View on Sci-Hub", btnId: "btn-view", defaultKey: "v" },
  { id: "author", label: "More by This Author", btnId: "btn-author", defaultKey: "a" },
  { id: "downloadAll", label: "Download All Works", btnId: "btn-download-all", defaultKey: "w" },
  { id: "collaborators", label: "Common Collaborators", btnId: "btn-collaborators", defaultKey: "o" },
  { id: "issue", label: "Download This Issue", btnId: "btn-issue", defaultKey: "i" },
  { id: "qr", label: "QR Code", btnId: "btn-qr", defaultKey: "q" },
  { id: "references", label: "References", btnId: "btn-references", defaultKey: "r" },
  { id: "citedBy", label: "Cited By", btnId: "btn-cited-by", defaultKey: "b" },
  { id: "search", label: "Search Google Instead", btnId: "btn-search", defaultKey: "g" },
];

function getPopupShortcutMap(callback) {
  chrome.storage.sync.get(["popupShortcuts"], (settings) => {
    const overrides = settings.popupShortcuts || {};
    const map = {};
    POPUP_SHORTCUT_ACTIONS.forEach((a) => {
      const val = overrides[a.id] !== undefined ? overrides[a.id] : a.defaultKey;
      map[a.id] = (val || "").toLowerCase();
    });
    callback(map);
  });
}
