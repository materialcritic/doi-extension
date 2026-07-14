// Expands Sci-Hub's PDF viewer to fill the entire tab by hiding everything
// else on the page (sidebar, buttons, header) — mirrors the behavior of the
// standalone "Entire Screen Sci-Hub Document Viewer" extension.
(function () {
  function findViewer() {
    return document.querySelector(
      'embed[type="application/pdf"], embed[src], iframe#pdf, iframe[src*=".pdf"], iframe[src]'
    );
  }

  function expand() {
    const viewer = findViewer();
    if (!viewer) return false;

    Array.from(document.body.children).forEach((el) => {
      if (el !== viewer && !el.contains(viewer)) {
        el.style.setProperty("display", "none", "important");
      }
    });

    let node = viewer;
    while (node && node !== document.body) {
      node.style.setProperty("position", "fixed", "important");
      node.style.setProperty("top", "0", "important");
      node.style.setProperty("left", "0", "important");
      node.style.setProperty("width", "100vw", "important");
      node.style.setProperty("height", "100vh", "important");
      node.style.setProperty("margin", "0", "important");
      node.style.setProperty("padding", "0", "important");
      node.style.setProperty("border", "none", "important");
      node.style.setProperty("z-index", "2147483647", "important");
      node = node.parentElement;
    }

    document.documentElement.style.setProperty("overflow", "hidden", "important");
    document.body.style.setProperty("margin", "0", "important");
    document.body.style.setProperty("overflow", "hidden", "important");
    return true;
  }

  if (!expand()) {
    // Sci-Hub sometimes injects the PDF embed slightly after initial load.
    const observer = new MutationObserver(() => {
      if (expand()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 8000);
  }
})();
