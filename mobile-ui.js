/* Field hints, responsive records, and the visual viewport are shared by both apps. */
(() => {
  const editable = el => el && el.matches("input:not([type=checkbox]):not([type=radio]),textarea,select");
  function viewport() {
    const v = window.visualViewport;
    document.documentElement.style.setProperty("--visual-height", (v?.height || innerHeight) + "px");
    document.documentElement.style.setProperty("--visual-top", (v?.offsetTop || 0) + "px");
    const keyboard = !!editable(document.activeElement) && innerHeight - (v?.height || innerHeight) > 120;
    document.body.classList.toggle("mobile-keyboard-open", keyboard);
  }
  function enhance() {
    document.querySelectorAll("main input,main textarea,#modal input,#modal textarea,.dlg input,.dlg textarea").forEach(el => {
      if (!el.hasAttribute("aria-label") && !el.labels?.length && el.placeholder) el.setAttribute("aria-label", el.placeholder);
      if (el.type === "number" && !el.inputMode) el.inputMode = el.step && el.step !== "1" ? "decimal" : "numeric";
      if (!el.enterKeyHint && el.tagName === "INPUT") el.enterKeyHint = "next";
    });
    document.querySelectorAll("main table").forEach(table => {
      const rows = [...table.rows];
      if (!rows.length || !rows[0].querySelector("th")) return;
      const labels = [...rows[0].cells].map(cell => cell.textContent.trim());
      const simple = labels.length >= 3 && rows.slice(1).every(row => row.cells.length === labels.length && [...row.cells].every(cell => cell.colSpan === 1));
      table.classList.toggle("mobile-cards", simple);
      if (simple) rows.slice(1).forEach(row => [...row.cells].forEach((cell, i) => {
        if (cell.dataset.label !== labels[i]) cell.dataset.label = labels[i];
      }));
    });
  }
  const start = () => {
    viewport(); enhance();
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; enhance(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.visualViewport?.addEventListener("resize", viewport);
    window.visualViewport?.addEventListener("scroll", viewport);
    window.addEventListener("resize", viewport);
    document.addEventListener("focusin", () => { viewport(); setTimeout(() => { if (matchMedia("(max-width:719px)").matches && editable(document.activeElement)) document.activeElement.scrollIntoView({ block: "nearest" }); }, 250); });
    document.addEventListener("focusout", () => setTimeout(viewport, 150));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
