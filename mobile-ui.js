/* Field hints, responsive records, and the visual viewport are shared by both apps. */
(() => {
  globalThis.copyText = async text => {
    if (typeof pushClient !== 'undefined' && pushClient.native?.embedded) return pushClient.native.copyText(String(text));
    if (!navigator.clipboard?.writeText) throw new Error('النسخ غير متاح');
    return navigator.clipboard.writeText(String(text));
  };
  globalThis.saveCsv = async (filename, text) => {
    if (typeof pushClient !== 'undefined' && pushClient.native?.embedded) return pushClient.native.saveCsv(filename, text);
    const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  globalThis.handleNativeBack = () => {
    const diagnostic=document.getElementById('pdg');if(diagnostic?.closeDiagnostics){diagnostic.closeDiagnostics();return true;}
    const dialog=document.querySelector('.dlg');if(dialog){const cancel=dialog.querySelector('#d3,#dc');if(cancel)cancel.click();else dialog.click();return true;}
    if(document.getElementById('modal')?.style.display==='flex'){closeStatus();return true;}
    const home=typeof ACC!=='undefined'?(ACC.role==='staff'?visTabs()[0]?.[0]:'home'):'orders';
    if(home&&typeof tab!=='undefined'&&typeof go==='function'&&tab!==home){go(home);return true;}
    return false;
  };
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
