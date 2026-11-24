/* Phone motion and dialog semantics. Data and authorization stay in the application. */
(() => {
  const phone=matchMedia('(max-width:719px)'),reduce=matchMedia('(prefers-reduced-motion:reduce)');
  const ease='cubic-bezier(.2,.8,.2,1)',animations=new Set();
  const itemRowsSeen=new WeakSet();
  let opener=null,overlay=null,panelNode=null,screen='',startY=null,drag=null,backNext=false;
  const enabled=()=>(phone.matches||!!overlay||!!document.querySelector('.aw-page'))&&typeof ACC!=='undefined'&&ACC.role!=='none';
  function play(el,frames,duration=220){
    if(!el||!enabled()||reduce.matches||!el.animate)return;
    for(const a of el.getAnimations())a.cancel();
    const a=el.animate(frames,{duration,easing:ease});animations.add(a);
    a.finished.catch(()=>{}).finally(()=>animations.delete(a));return a;
  }
  function enter(key,back=false){
    if(!enabled()||screen===key)return;screen=key;
    back=back||backNext;backNext=false;play(document.getElementById('main'),[{opacity:.45,transform:`translateX(${back?12:-12}px)`},{opacity:1,transform:'translateX(0)'}]);
  }
  // Remove interactive DOM immediately; a short inert visual exit cannot close a newer dialog.
  function retire(node){
    if(!enabled()||reduce.matches||!node)return;
    const style=getComputedStyle(node);
    const ghost=node.cloneNode(true);ghost.removeAttribute('id');ghost.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
    ghost.setAttribute('aria-hidden','true');ghost.inert=true;ghost.classList.add('aw-retiring');
    Object.assign(ghost.style,{display:'flex',alignItems:style.alignItems,justifyContent:style.justifyContent,background:style.backgroundColor,padding:style.padding,backdropFilter:style.backdropFilter,zIndex:String((Number(style.zIndex)||60)-1)});
    document.body.appendChild(ghost);if(ghost.firstElementChild&&node.firstElementChild){const panel=getComputedStyle(node.firstElementChild);ghost.firstElementChild.scrollTop=node.firstElementChild.scrollTop;ghost.firstElementChild.style.transform=panel.transform;ghost.firstElementChild.style.opacity=panel.opacity;}const a=play(ghost,[{opacity:Number(style.opacity)},{opacity:0}],140);
    if(a)a.finished.catch(()=>{}).finally(()=>ghost.remove());else ghost.remove();
  }
  function controls(node){return [...node.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')].filter(n=>!n.disabled&&n.getClientRects().length);}
  function sync(){
    if(!enabled())return;
    const dialogs=[...document.querySelectorAll('.dlg:not(.aw-retiring)')],modal=document.getElementById('modal');
    const next=dialogs.at(-1)||(modal?.style.display==='flex'?modal:null);
    if(modal)modal.inert=dialogs.length>0;
    const app=document.getElementById('app');if(app)app.inert=!!next;
    document.body.classList.toggle('aw-overlay-open',!!next);
    if(next===overlay&&next?.firstElementChild===panelNode)return;
    if(!overlay&&next)opener=document.activeElement;
    const entering=next!==overlay;overlay=next;
    panelNode=next?.firstElementChild||null;
    if(next){
      const panel=next.firstElementChild;if(!panel)return;
      panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
      panel.setAttribute('aria-label',panel.querySelector('h1,h2,h3,.sh-h b')?.textContent||'تفاصيل');
      panel.tabIndex=-1;next.dataset.awOverlay='true';
      for(const other of dialogs)other.inert=other!==next;
      if(entering){play(next,[{opacity:0},{opacity:1}],180);play(panel,[{opacity:.5,transform:'translateY(28px)'},{opacity:1,transform:'translateY(0)'}],280);}
      panel.focus({preventScroll:true});
    }else{if(opener?.isConnected&&!opener.closest('[inert]'))opener.focus({preventScroll:true});opener=null;}
  }
  function dismiss(){
    const d=document.querySelector('.dlg:not(.aw-retiring):last-of-type')||[...document.querySelectorAll('.dlg:not(.aw-retiring)')].at(-1);
    if(d){const b=d.querySelector('#dc,#d3,#pkc');if(b)b.click();else d.click();}
    else if(document.getElementById('modal')?.style.display==='flex')closeStatus();
  }
  function init(){
    new MutationObserver(()=>{sync();decorate();}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style']});
    document.addEventListener('keydown',e=>{
      if(!enabled()||!overlay)return;
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();dismiss();return;}
      if(e.key!=='Tab')return;
      const list=controls(overlay),first=list[0],last=list.at(-1);if(!first){e.preventDefault();return;}
      if(!overlay.contains(document.activeElement)||(!e.shiftKey&&document.activeElement===last)){e.preventDefault();first.focus();}
      else if(e.shiftKey&&(document.activeElement===first||document.activeElement===overlay.firstElementChild)){e.preventDefault();last.focus();}
    },true);
    document.addEventListener('pointerdown',e=>{
      if(!enabled())return;const handle=e.target.closest('.sh-h,.aw-grabber');
      if(handle&&!e.target.closest('button,input,select,a')&&handle.closest('#modal')){drag=handle.closest('.sheet');startY=e.clientY;handle.setPointerCapture?.(e.pointerId);}
    },{passive:true});
    document.addEventListener('pointermove',e=>{if(drag&&startY!==null&&e.clientY>startY)drag.style.transform=`translateY(${Math.min((e.clientY-startY)*.65,160)}px)`;},{passive:true});
    document.addEventListener('pointerup',e=>{if(drag){const node=drag,from=node.style.transform;if(startY!==null&&e.clientY-startY>90)closeStatus();else{node.style.transform='';if(from)play(node,[{transform:from},{transform:'translateY(0)'}],180);}}drag=null;startY=null;},{passive:true});
    document.addEventListener('pointercancel',()=>{if(drag)drag.style.transform='';drag=null;startY=null;},{passive:true});decorate();
    document.addEventListener('toggle',e=>{if(e.target.matches?.('details.aw-details')&&e.target.open)play(e.target.querySelector(':scope > div'),[{opacity:.4,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],160);},true);
  }
  function decorate(){
    if(!enabled())return;
    document.querySelectorAll('#aw-order-form #orows>.row').forEach(row=>{if(!itemRowsSeen.has(row)){itemRowsSeen.add(row);play(row,[{opacity:.4,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],160);}});
    document.querySelectorAll('#modal .x').forEach(n=>{if(!n.hasAttribute('aria-label'))n.setAttribute('aria-label','إغلاق');});
    document.querySelectorAll('.dlg .f').forEach(f=>{const l=f.querySelector('label'),i=f.querySelector('input,textarea');if(l&&i&&i.id)l.htmlFor=i.id;});
    document.querySelectorAll('#main input,#main select,#modal input,#modal select,.dlg input,.dlg select').forEach(n=>{
      if(!n.hasAttribute('aria-label')&&!n.labels?.length)n.setAttribute('aria-label',n.placeholder||n.options?.[0]?.textContent||'قيمة');
      if(n.type==='number')n.inputMode=n.step==='1'?'numeric':'decimal';
    });
  }
  function reset(){animations.forEach(a=>a.cancel());animations.clear();document.querySelectorAll('.aw-retiring').forEach(n=>n.remove());screen='';opener=null;overlay=null;document.body.classList.remove('aw-overlay-open');const app=document.getElementById('app');if(app)app.inert=false;}
  reduce.addEventListener('change',()=>{if(reduce.matches)animations.forEach(a=>a.cancel());});
  globalThis.AdminMotion={enabled,play,enter,retire,reset,sync,reverse:()=>{backNext=true;}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
