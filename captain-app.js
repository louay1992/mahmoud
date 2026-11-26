/* Endpoints come from app-config.js, shared with Android and the build script. */
const {supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_KEY} = globalThis.DELIVERY_CONFIG;
const authGate = new DeliverySession("sb-captain-auth");
const offline = new DeliveryOffline({role:"captain",storageKey:"sb-captain-auth",blocked:()=>authGate.blocked});
const sb = offline.wrap(supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth:{storageKey:"sb-captain-auth"}}));
/* حماية من الضغط المتكرر: تجاهل الضغطة الثانية أثناء تنفيذ عملية أو خلال لحظات */
let _lc=0,_le=null;
document.addEventListener("click",e=>{ const b=e.target.closest&&e.target.closest("button"); if(!b || b.closest("#pdg") || b.hasAttribute("data-push-diagnostic")) return;
  const now=Date.now();
  if((typeof busy!=="undefined"&&busy>0)||(_le===b&&now-_lc<800)){ e.stopPropagation(); e.preventDefault(); return }
  _le=b; _lc=now },true);

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let CUR = "", BIZ = "";
const money = n => Number(n || 0).toLocaleString("en-US", {maximumFractionDigits: 2}) + (CUR ? " " + CUR : "");
const waNum=p=>{ let d=String(p||"").replace(/[٠-٩]/g,c=>"٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D/g,""); const cc=(D.settings.phone_country||"").replace(/\D/g,""); if(d.startsWith("00")) d=d.slice(2); else if(d.startsWith("0")&&cc) d=cc+d.slice(1); return d };
const waUrl=o=>"https://wa.me/"+waNum(o.customer_phone)+"?text="+encodeURIComponent(`السلام عليكم ${o.customer_name}، أنا ${me?me.name:"كابتن التوصيل"}${BIZ?" من "+BIZ:""}، كابتن توصيل طلبك رقم #${o.order_no}. المبلغ المطلوب: ${money(o.total)}.`);
const mapUrl=o=>{try{const u=new URL(o.map_url||(o.customer_address?"https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(o.customer_address):""));return /^https?:$/.test(u.protocol)?esc(u.href):""}catch(_){return""}};
const when = s => { if(!s) return ""; const d=new Date(s), n=new Date(), t=d.toLocaleTimeString("ar-EG",{hour:"numeric",minute:"2-digit"});
  const day=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime(), diff=Math.round((day(n)-day(d))/864e5);
  return (diff===0?"اليوم":diff===1?"أمس":d.toLocaleDateString("ar-EG",{day:"numeric",month:"numeric",year:d.getFullYear()===n.getFullYear()?undefined:"numeric"}))+" "+t };
const admNoteAt = o => { const e=(D.ev&&D.ev[o.id]||[]).filter(x=>(x.note||"").startsWith("ملاحظة من الإداري")).pop(); return e?e.created_at:o.created_at };
const dt = s => s ? new Date(s).toLocaleString("ar-EG", {dateStyle: "short", timeStyle: "short"}) : "";

/* ===== الأيقونات ===== */
const IC = {
 box:'<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
 store:'<path d="M3 21V9l9-6 9 6v12"/><path d="M8 21v-7h8v7"/>',
 wallet:'<path d="M3 7a2 2 0 012-2h13v4"/><path d="M3 7v11a2 2 0 002 2h15V9H5a2 2 0 01-2-2z"/><circle cx="16.5" cy="14.5" r="1"/>',
 bell:'<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
 phone:'<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z"/>',
 phoneoff:'<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z"/><path d="M2 2l20 20"/>',
 truck:'<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/>',
 check:'<path d="M20 6L9 17l-5-5"/>',
 checkc:'<circle cx="12" cy="12" r="10"/><path d="M8 12.5l3 3 5-6"/>',
 x:'<path d="M18 6L6 18M6 6l12 12"/>',
 xc:'<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
 refresh:'<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15"/>',
 logout:'<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
 tag:'<path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8z"/><circle cx="7" cy="7" r="1.2"/>',
 note:'<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
 lock:'<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
 inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.5-6.9A2 2 0 0016.8 4H7.2a2 2 0 00-1.7 1.1z"/>',
 undo:'<path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/>',
 search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
 chev:'<path d="M6 9l6 6 6-6"/>',
 mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
 eye:'<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
 pin:'<path d="M21 10c0 7-9 12-9 12S3 17 3 10a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/>',
 wa:'<path d="M21 11.5a8.5 8.5 0 01-12.6 7.4L3 20.5l1.7-5.2A8.5 8.5 0 1121 11.5z"/><path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.6-2-1-.9.8a5 5 0 01-2.3-2.3l.8-.9-1-2z"/>',
 msg:'<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
 cash:'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
 sparkle:'<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
 hourglass:'<path d="M6 2h12M6 22h12M7 2v4a5 5 0 002 4 5 5 0 01-2 4v4M17 2v4a5 5 0 01-2 4 5 5 0 002 4v4"/>'
};
const waIc = () => `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>`;
const ic = (n, cls="") => `<svg class="i ${cls}" viewBox="0 0 24 24">${IC[n]||""}</svg>`;

const ST = {new:"جديد", assigned:"جديد", in_delivery:"قيد التوصيل", no_answer:"لم يتم الرد", closed:"مغلق", other:"ملاحظة أخرى", delivered:"مُسلَّم", cancelled:"ملغي", returned:"مُرجَع"};
const SCOL = {new:"#f59e0b",assigned:"#f59e0b",in_delivery:"#2563eb",no_answer:"#ea580c",closed:"#475569",other:"#0891b2",delivered:"#16a34a",cancelled:"#ef4444",returned:"#7c3aed"};
const SICO = {assigned:"inbox",in_delivery:"truck",no_answer:"phoneoff",closed:"lock",other:"note",delivered:"checkc",cancelled:"xc"};
const OPEN = ["assigned","in_delivery","no_answer","closed","other"];

let toastT;
function toast(m, kind){ const t=$("toast"); t.className=kind||""; t.innerHTML=(kind==="err"?ic("xc"):kind==="ok"?ic("checkc"):kind==="bell"?ic("bell"):"")+`<span>${esc(m)}</span>`; requestAnimationFrame(()=>t.classList.add("on")); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove("on"),3200) }
let busy=0, lastSelf=0;
async function run(p, ok){ busy++; $("bar").classList.add("on"); lastSelf=Date.now();
  try{ const {error}=await p; if(error){toast(error.message,"err");return false} if(ok)toast(ok,"ok"); return true }
  finally{ if(--busy<=0){ busy=0; $("bar").classList.remove("on") } } }

let me=null, D={orders:[],stock:[],payments:[],balance:null,ev:{},settings:{},pr:{}}, tab="orders", q="";

/* ===== الدخول والبدء ===== */
function hideSplash(){ $("splash").classList.add("off") }
function boot(){ return offline.boot(onlineBoot); }
async function onlineBoot(){
  if(authGate.blocked){ authGate.clearSession(); showLogin(); return }
  const {data:{session}} = await offline.onlineSession(sb.auth);
  if(authGate.blocked){ showLogin(); return }
  if(!session){ await offline.invalidate(); showLogin(); return }
  const em=String(session.user.email||"").toLowerCase();
  const {data,error:profileError} = await sb.from("captains").select("*").eq("email",em).limit(1);
  if(profileError)throw Object.assign(new Error(profileError.message),{code:offline.networkError({error:profileError})?"NETWORK":"ACCESS_DENIED"});
  if(authGate.blocked){ showLogin(); return }
  if(!data || !data.length || data[0].active===false || String(data[0].email||"").toLowerCase()!==em){ await offline.invalidate(); toast("هذا الحساب غير مرتبط بكابتن","err"); await sb.auth.signOut(); showLogin(); return }
  me = data[0];
  await offline.attach(session,{captain:me});
  $("login").style.display="none"; $("app").style.display="block";
  $("av").textContent=(me.name||"ك").trim().charAt(0); $("hn").textContent=me.name;
  if(await load(true)===false)throw Error("core data unavailable"); if(authGate.blocked) return; go("orders"); appRefresh.restoreView(); hideSplash(); startLive(); initNotifUI(); ensurePush(); checkUpdate(); openPushTarget();
}
function showLogin(){ $("app").style.display="none"; $("login").style.display="flex"; hideSplash() }
function offlineLogin(){me=null;LSEQ++;D={orders:[],stock:[],payments:[],balance:null,ev:{},settings:{},pr:{},notifs:[]};showLogin();$("main").innerHTML="";$("modal").style.display="none";document.querySelectorAll(".dlg").forEach(d=>d.remove());Promise.resolve(sb.removeAllChannels?.()).catch(()=>{});}
const loginId=v=>{ v=String(v||"").trim(); if(v.includes("@")) return v.toLowerCase();
  let d=v.replace(/[٠-٩]/g,x=>"٠١٢٣٤٥٦٧٨٩".indexOf(x)).replace(/[۰-۹]/g,x=>"۰۱۲۳۴۵۶۷۸۹".indexOf(x)).replace(/\D/g,"");
  if(d.startsWith("00963")) d="0"+d.slice(5); else if(d.startsWith("963")) d="0"+d.slice(3); else if(d.length===9&&d[0]==="9") d="0"+d;
  return d+"@captain.local" };
async function login(){
  const b=$("lbtn"), em=$("em").value.trim(), pw=$("pw").value; if(!em||!pw) return toast("اكتب رقم الموبايل وكلمة المرور","err");
  b.disabled=true; b.classList.add("load");
  if(authGate.blocked) authGate.beginLogin();
  const {error} = await sb.auth.signInWithPassword({email:loginId(em), password:pw});
  b.disabled=false; b.classList.remove("load");
  if(error) return toast("فشل الدخول: تحقق من البيانات","err");
  authGate.completeLogin();
  $("splash").classList.remove("off"); boot();
}
async function logout(){
  if(authGate.exiting || !await ask("تسجيل الخروج","هل تريد الخروج من حسابك؟","نعم، خروج","r","logout")) return;
  await authGate.logout({auth:sb.auth,detach:()=>dropPush(),reload:()=>location.reload(),lock:()=>{
    void offline.invalidate();
    me=null; D={orders:[],stock:[],payments:[],balance:null,ev:{},settings:{},pr:{},notifs:[]}; LSEQ++; showLogin(); $("main").innerHTML="";
    $("modal").style.display="none"; document.querySelectorAll(".dlg").forEach(d=>d.remove());
    $("em").value=""; $("pw").value=""; $("lbtn").disabled=true;
    Promise.resolve(sb.removeAllChannels?.()).catch(()=>{});
  }});
}

/* ===== تحميل البيانات + كشف الجديد ===== */
let firstLoad=true;
let LSEQ=0;
async function load(initial,{signal}={}){
  const seq=++LSEQ, who=me&&me.id;
  const r = await Promise.all([
    sb.rpc("working_orders",{p_history_limit:200,p_captain:me.id}),
    sb.from("stock").select("qty, products(name)").eq("warehouse_id",me.warehouse_id||"00000000-0000-0000-0000-000000000000"),
    sb.from("captain_payments").select("*").eq("captain_id",me.id).order("created_at",{ascending:false}),
    sb.from("captain_balances").select("*").eq("captain_id",me.id).limit(1),
    sb.from("settings").select("*"),
    sb.from("order_events").select("*").order("created_at",{ascending:true}).limit(1000),
    sb.from("price_requests").select("*").order("created_at",{ascending:false}).limit(300),
    sb.from("notifications").select("*").order("created_at",{ascending:false}).limit(150),
  ].map(x=>signal&&x.abortSignal?x.abortSignal(signal):x));
  if(signal?.aborted||seq!==LSEQ||!me||me.id!==who||authGate.blocked) return false;
  const bad=r.find(x=>x.error); if(bad){ if(!initial) throw new Error('تعذّر تحميل البيانات'); toast('تعذّر تحميل البيانات. حاول مجددًا.','err'); return false; }
  const prev=D.orders;
  D.orders=r[0].data||[]; D.stock=(r[1].data||[]).sort((a,b)=>(a.products?.name||"").localeCompare(b.products?.name||"","ar"));
  D.payments=r[2].data||[]; D.balance=(r[3].data||[])[0]||null;
  const st=Object.fromEntries((r[4].data||[]).map(x=>[x.key,x.value])); CUR=st.currency||""; BIZ=st.business_name||""; D.settings=st;
  $("hs").textContent=BIZ||"جاهز لاستلام الطلبات";
  D.pr={}; (r[6].data||[]).forEach(x=>{ (D.pr[x.order_id]=D.pr[x.order_id]||[]).push(x) });
  D.ev={}; (r[5].data||[]).forEach(e=>(D.ev[e.order_id]=D.ev[e.order_id]||[]).push(e));
  const n=D.orders.filter(o=>OPEN.includes(o.status)).length; setBadge(n);
  D.notifs=r[7].data||[]; detectNotifs();
  await offline.checkpoint(D);return true;
}
function setBadge(n){
  $("t_orders").innerHTML=ic("box")+"<span>طلباتي</span>"+(n?`<i class="bd">${n}</i>`:"");
  try{ navigator.setAppBadge&&(n?navigator.setAppBadge(n):navigator.clearAppBadge()) }catch(e){}
}
/* كشف: طلب جديد، ملاحظة من الإداري، قرار على طلب تعديل السعر، دفعة جديدة */
function detect(prev){
  const key="cap_seen_"+me.id; let S; try{ S=JSON.parse(localStorage.getItem(key)||"null") }catch(e){ S=null }
  const cur={o:{},p:D.payments.map(x=>x.id),r:{}};
  D.orders.forEach(o=>cur.o[o.id]={n:o.note||"",s:o.status,t:Number(o.total),a:(o.customer_address||"")+"|"+(o.map_url||"")});
  Object.values(D.pr).flat().forEach(x=>cur.r[x.id]=x.status);
  if(S){
    const quiet=Date.now()-lastSelf<5000, msgs=[];
    const fresh=D.orders.filter(o=>!S.o[o.id]&&o.status==="assigned");
    if(fresh.length) msgs.push(fresh.length===1?["طلب جديد #"+fresh[0].order_no,fresh[0].customer_name+" — "+money(fresh[0].total),"o"+fresh[0].id]:["لديك "+fresh.length+" طلبات جديدة","افتح التطبيق لمراجعتها","newo"]);
    const decided=new Set(Object.values(D.pr).flat().filter(x=>S.r[x.id]==="pending"&&x.status!=="pending").map(x=>x.order_id));
    D.orders.forEach(o=>{ const b=S.o[o.id]; if(!b) return;
      if((o.note||"")!==b.n && o.note) msgs.push(["ملاحظة من الإداري — طلب #"+o.order_no,o.note,"n"+o.id]);
      else if(b.t!==undefined&&(Number(o.total)!==b.t||((o.customer_address||"")+"|"+(o.map_url||""))!==b.a)&&!quiet&&!decided.has(o.id)) msgs.push(["تم تعديل الطلب #"+o.order_no,Number(o.total)!==b.t?"الإجمالي الجديد "+money(o.total):"تغيّر عنوان الزبون","e"+o.id+o.total]);
      else if(!quiet && o.status!==b.s) msgs.push(["تغيّرت حالة الطلب #"+o.order_no,"أصبحت: "+(ST[o.status]||o.status),"s"+o.id]) });
    Object.values(D.pr).flat().forEach(x=>{ if(S.r[x.id]==="pending"&&x.status!=="pending"){ const o=D.orders.find(z=>z.id===x.order_id)||{};
      msgs.push([x.status==="approved"?"تمت الموافقة على تعديل السعر":"تم رفض تعديل السعر","طلب #"+(o.order_no||"")+(x.admin_note?" — "+x.admin_note:""),"r"+x.id]) } });
    const newPay=D.payments.filter(x=>!S.p.includes(x.id)); if(newPay.length) msgs.push(["تم تسجيل دفعة",money(newPay[0].amount)+(newPay[0].note?" — "+newPay[0].note:""),"p"+newPay[0].id]);
    msgs.slice(0,4).forEach((m,i)=>setTimeout(()=>notify(m[0],m[1],m[2]),i*900));
  }
  try{ localStorage.setItem(key,JSON.stringify(cur)) }catch(e){}
}
function render_if_idle(){ if($("modal").style.display==="flex"||document.querySelector(".dlg")) return; if(document.activeElement&&/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return; const y=scrollY; render(); scrollTo(0,y) }
async function refresh(){ return appRefresh.refresh({reason:'live'}); }
async function manualRefresh(){ if(offline.readonly)return offline.retry(); return appRefresh.manual(); }
function go(t){ tab=t; if(t==="acc")ASUB="";["orders","stock","acc"].forEach(k=>$("t_"+k).classList.toggle("on",k===t||(k==="acc"&&t==="stock"))); document.body.classList.add("anim"); render(); scrollTo({top:0,behavior:"instant"}); setTimeout(()=>document.body.classList.remove("anim"),700) }
function render(){ ({orders:vOrders,stock:vStock,acc:vAcc,notifs:vNotifs})[tab]() }

/* ===== الإشعارات ===== */
let actx;
function beep(){ try{ actx=actx||new (window.AudioContext||window.webkitAudioContext)(); const t=actx.currentTime;
  [[880,0],[1175,.16]].forEach(([f,d])=>{ const o=actx.createOscillator(),g=actx.createGain(); o.connect(g); g.connect(actx.destination); o.type="sine"; o.frequency.value=f;
    g.gain.setValueAtTime(.0001,t+d); g.gain.exponentialRampToValueAtTime(.3,t+d+.02); g.gain.exponentialRampToValueAtTime(.0001,t+d+.3); o.start(t+d); o.stop(t+d+.32) }) }catch(e){} }
async function notify(title, body, tag){
  toast(title+(body?" — "+body:""),"bell"); beep(); try{ navigator.vibrate&&navigator.vibrate([200,100,200]) }catch(e){}
  if(pushClient.native?.expected) return;
  if(document.hidden && "Notification" in window && Notification.permission==="granted"){
    const opt={body,tag,icon:"/icons/captain-192.png",badge:"/icons/captain-192.png",dir:"rtl",lang:"ar",renotify:true,vibrate:[200,100,200],data:{url:"/captain.html"}};
    try{ const reg=await pushClient.registration(); await reg.showNotification(title,opt) }catch(e){ console.warn("notification display",e) } }
}
const NME=()=>String((me&&me.email)||"").toLowerCase();

/* ===== مركز الإشعارات ===== */
const NK={new_order:["طلبات"],order_edit:["طلبات"],order_removed:["طلبات"],staff_order:["طلبات"],status:["الحالات"],admin_note:["ملاحظات"],captain_note:["ملاحظات"],payment:["دفعات"],price_request:["أسعار"],price_decision:["أسعار"]};
const NCAT=[["all","الكل"],["unread","غير مقروء"],["طلبات","الطلبات"],["الحالات","الحالات"],["ملاحظات","الملاحظات"],["دفعات","الدفعات"],["أسعار","الأسعار"]];
const NLV={info:"#2563eb",success:"#16a34a",warn:"#f59e0b",danger:"#ef4444"};
let NF="all", NU=new Set();
const nUnread=n=>!(n.read_by||[]).includes(NME());
const nCat=n=>(NK[n.kind]||["أخرى"])[0];
function nDay(s){ const d=new Date(s), t=new Date(), y=new Date(t.getFullYear(),t.getMonth(),t.getDate()-1);
  if(d.toDateString()===t.toDateString()) return "اليوم"; if(d.toDateString()===y.toDateString()) return "أمس";
  return d.toLocaleDateString("ar-EG",{weekday:"long",day:"numeric",month:"long"}) }
function nBadge(){ const c=(D.notifs||[]).filter(nUnread).length; return c?`<i class="nbd">${c>99?"99+":c}</i>`:"" }
function markRead(){
  if(offline.denied())return false;
  const ids=(D.notifs||[]).filter(nUnread).map(n=>n.id); if(!ids.length) return;
  ids.forEach(i=>NU.add(i)); const m=NME();
  D.notifs.forEach(n=>{ if(ids.includes(n.id)) n.read_by=[...(n.read_by||[]),m] }); initNotifUI();
  sb.rpc("mark_notifications_read",{p_ids:ids}).then(()=>{},()=>{});
}
function markAllRead(){ markRead(); vNotifs() }
function vNotifs(){
  const all=D.notifs||[]; (all.filter(nUnread)).forEach(n=>NU.add(n.id));
  const cnt=k=>k==="all"?all.length:k==="unread"?all.filter(n=>NU.has(n.id)).length:all.filter(n=>nCat(n)===k).length;
  const list=all.filter(n=>NF==="all"||(NF==="unread"?NU.has(n.id):nCat(n)===NF));
  let h=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">الإشعارات</h2>${NU.size?`<button class="btn" style="min-height:36px;padding:0 12px;background:#eaf1ff;color:#1d4ed8;font-size:13px" onclick="NU=new Set();vNotifs()">تعليم الكل كمقروء</button>`:""}</div>`;
  if(!pushClient.enabled&&notifState()!=="na") h+=`<div id="push-enable-card" class="card" style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a"><div style="flex:1;font-size:14px">فعّل إشعارات الجهاز لتصلك التنبيهات والتطبيق مغلق</div><button class="btn btn-p" style="min-height:36px;padding:0 14px" onclick="bellClick().then(vNotifs)">تفعيل</button></div>`;
  h+=`<div class="nchips">${NCAT.map(([k,l])=>`<button class="${NF===k?"on":""}" onclick="NF='${k}';vNotifs()">${l} <i>${cnt(k)}</i></button>`).join("")}</div>`;
  if(!list.length) h+=`<div class="card mut" style="text-align:center;padding:30px 14px">لا توجد إشعارات${NF!=="all"?" في هذا التصنيف":" بعد"}.</div>`;
  let last="";
  list.forEach(n=>{ const dd=nDay(n.created_at); if(dd!==last){ h+=`<div class="nday">${dd}</div>`; last=dd }
    h+=`<div class="nc ${NU.has(n.id)?"nu":""}" style="border-inline-start-color:${NLV[n.level]||NLV.info}" ${n.order_id?`onclick="openNotif('${n.order_id}')"`:""}>
      <div class="nh"><b>${esc(n.title)}</b><span>${new Date(n.created_at).toLocaleTimeString("ar-EG",{hour:"numeric",minute:"2-digit"})}</span></div>
      <div class="nb">${esc(n.body)}</div>
      <div class="nf"><span class="ncat">${nCat(n)}</span>${n.order_id?`<span class="nlk">عرض الطلب ‹</span>`:""}</div></div>`; });
  $("main").innerHTML=h; markRead();
}
function openNotif(oid){ if(!(D.orders||[]).some(o=>o.id===oid)) return toast("الطلب غير متاح","err"); openOrder(oid) }
async function openPushTarget(){
  const params=new URLSearchParams(location.search), id=params.get("order"), incoming=params.get("notification")==="1";
  if(!incoming) return;
  params.delete("notification"); params.delete("order"); history.replaceState(null,"",location.pathname+(params.size?"?"+params:"")+location.hash);
  if(!id||!/^[0-9a-f-]{36}$/i.test(id)){ go("notifs"); return }
  if(!D.orders.some(x=>x.id===id)){ const {data,error}=await sb.from("orders").select("*, order_items(id, qty, unit_price, list_price, products(name))").eq("id",id).eq("captain_id",me.id).maybeSingle(); if(error||!data){ toast(offline.readonly?"هذا الطلب غير محفوظ على الجهاز. افتحه عند عودة الاتصال.":"هذا الطلب غير متاح لحسابك الحالي","err"); return } D.orders.push(data) }
  openOrder(id);
}
function detectNotifs(){
  const key="nseen_"+NME(); let S; try{ S=JSON.parse(localStorage.getItem(key)||"null") }catch(e){ S=null }
  const ids=(D.notifs||[]).map(n=>n.id);
  if(S&&tab!=="notifs"){ const fresh=D.notifs.filter(n=>!S.includes(n.id)&&nUnread(n)).slice(0,4).reverse();
    fresh.forEach((n,i)=>setTimeout(()=>notify(n.title,n.body.split("\n").slice(0,2).join(" · "),"n"+n.id),i*900)) }
  try{ localStorage.setItem(key,JSON.stringify(ids.slice(0,150))) }catch(e){}
  initNotifUI();
}
const pushClient=new DeliveryPush({
  scope:"/captain", keyUrl:SUPABASE_URL+DELIVERY_CONFIG.functionsPath+"/send-push", apiKey:SUPABASE_KEY,
  save:args=>sb.rpc("save_push_subscription",args), remove:args=>sb.rpc("remove_push_subscription",args), session:()=>authGate.blocked?Promise.resolve({data:{session:null}}):sb.auth.getSession()
});
globalThis.addEventListener?.("delivery-native-ready",async()=>{ if(!authGate.blocked&&(offline.readonly||navigator.onLine===false)){initNotifUI();return;} if(authGate.blocked){ pushClient.native.unbind().catch(()=>{}); initNotifUI(); return } const {data}=await sb.auth.getSession(); if(data.session && !authGate.blocked) ensurePush(); else pushClient.native.unbind().catch(e=>console.warn("native logout",e)); initNotifUI() });
function notifState(){ return pushClient.permission }
function initNotifUI(){ const b=$("bell"); b.innerHTML=ic("bell")+(pushClient.enabled?"":'<i class="dot"></i>'); b.classList.toggle("on",pushClient.enabled) }
async function bellClick(){
  const s=notifState();
  if(s==="na") return toast("المتصفح لا يدعم الإشعارات","err");
  if(s==="denied"&&!pushClient.native?.expected) return toast("الإشعارات محظورة. فعّلها من إعدادات الموقع/التطبيق","err");
  try{
    if(s!=="granted" && await pushClient.requestPermission()!=="granted") return pushDiag();
    await ensurePush({strict:true});
    beep(); toast("الإشعارات مفعّلة — ستصلك الطلبات الجديدة وملاحظات الإداري","ok"); render();
  }catch(e){ initNotifUI(); toast("تعذّر تفعيل الإشعارات. راجع نتيجة الفحص.","err"); await pushDiag(e.name+": "+e.message) }
}

/* تعرض الأداة الإذن الفعلي ونتيجة الطلب والحفظ كلّاً على حدة. */
async function pushDiag(initialLog=""){
  return openDeliveryPushDiagnostics({client:pushClient,role:"captain",initialLog,enable:()=>ensurePush({strict:true}),refreshUI:initNotifUI,escape:esc});
}
async function ensurePush({strict=false}={}){
  if(offline.denied())return false;
  try{
    if(authGate.blocked){ if(strict) throw new Error("سجّل الدخول أولاً"); return false }
    if(!(!!me)) { if(strict) throw new Error("سجّل الدخول أولاً"); return false }
    if(strict && pushClient.native?.expected && !pushClient.native.port) throw new Error(pushClient.native.channelError());
    if(pushClient.native?.expected) await pushClient.native.ready();
    if(authGate.blocked){ if(strict) throw new Error("سجّل الدخول أولاً"); return false }
    if(notifState()!=="granted" && !strict) return false;
    await pushClient.subscribe(); return true;
  }catch(e){ if(strict) throw e; console.warn("push",e); return false }
  finally{ initNotifUI(); if(pushClient.enabled){ $("push-enable-card")?.remove(); $("push-banner")?.remove() } }
}
async function dropPush(){ await pushClient.unsubscribe() }
/* تحديث لحظي من القاعدة + احتياطي بالاستعلام الدوري */
let rt, deb;
function startLive(){
  if(rt){Promise.resolve(sb.removeChannel?.(rt)).catch(()=>{});rt=null;}
  const kick=()=>{ clearTimeout(deb); deb=setTimeout(refresh,500) };
  try{ rt=sb.channel("cap-live").on("postgres_changes",{event:"*",schema:"public",table:"orders"},kick)
      .on("postgres_changes",{event:"*",schema:"public",table:"captain_payments"},kick)
      .on("postgres_changes",{event:"*",schema:"public",table:"price_requests"},kick).on("postgres_changes",{event:"INSERT",schema:"public",table:"notifications"},kick).subscribe() }catch(e){}
}
function checkUpdate(){ return appRefresh.checkUpdate(); }
function applyUpdate(){ return appRefresh.applyUpdate(true); }


/* ===== واجهة الطلبات ===== */
const GROUPS=[
 ["assigned","طلبات جديدة","طلبات وصلتك حديثاً. اضغط «قيد التوصيل» عندما تبدأ بتوصيل الطلب.",true],
 ["in_delivery","قيد التوصيل","طلبات بدأت توصيلها وأنت في طريقك لتسليمها.",true],
 ["no_answer","لم يتم الرد","اتصل بالزبون مجدداً، ثم «إعادة المحاولة» أو سلّم الطلب.",true],
 ["closed","مغلق","هاتف الزبون مغلق. أعد المحاولة لاحقاً.",true],
 ["other","ملاحظات أخرى","طلبات عليها ملاحظة خاصة.",true],
 ["cancelled","ملغية","يمكنك استرجاع أي طلب ملغي ليعود «جديداً».",false],
 ["delivered","مُسلَّمة","",false]];
const itemsLine=o=>`<div class="items">${o.order_items.map(i=>{const d=Number(i.unit_price)-Number(i.list_price);return `<div class="it"><span class="q">×${i.qty}</span><span class="nm">${esc(i.products?.name)}</span><span class="pr">${money(i.unit_price)}</span></div>`}).join("")}</div>`;
function prPending(o){ return (D.pr[o.id]||[]).find(x=>x.status==="pending") }
function prBox(o){
  const l=(D.pr[o.id]||[])[0]; if(!l) return "";
  const st={pending:["بانتظار موافقة الإداري على تعديل الإجمالي","#fff7e0","#8a5a00","hourglass"],approved:["وافق الإداري على تعديل الإجمالي","#e6f7ec","#166534","checkc"],rejected:["رفض الإداري تعديل الإجمالي","#fdeaea","#991b1b","xc"]}[l.status];
  if(l.status!=="pending"&&(Date.now()-new Date(l.decided_at))>3*864e5) return "";
  return `<div class="pr-box" style="background:${st[1]};color:${st[2]}"><b>${ic(st[3])} ${st[0]}</b><div>الإجمالي: ${money(l.old_total)} ← <b>${money(l.new_total)}</b></div><div style="opacity:.85">السبب: ${esc(l.reason)}</div>${l.admin_note?`<div>ملاحظة الإداري: ${esc(l.admin_note)}</div>`:""}</div>`;
}
function oActs(o, primaryOnly=false){
  const k=o.status;
  const deliver=()=>`<button class="btn btn-g" onclick="quick('${o.id}','delivered')">${ic("checkc")} تم التسليم</button>`;
  if(["no_answer","closed","other"].includes(k)){
    const retry=`<button class="btn btn-p" onclick="quick('${o.id}','in_delivery')">${ic("refresh")} إعادة المحاولة</button>`;
    return primaryOnly ? retry : retry+deliver();
  }
  return k==="assigned" ? `<button class="btn btn-p" onclick="quick('${o.id}','in_delivery')">${ic("truck")} قيد التوصيل</button>`
   : k==="in_delivery" ? deliver()
   : k==="cancelled" ? `<button class="btn btn-p" onclick="restore('${o.id}')">${ic("undo")} استرجاع الطلب</button>` : "";
}
let expandedOrderId=null;
function compactOrder(o){
  const phone=esc(o.customer_phone?.trim()), address=esc(o.customer_address?.trim()||"لا يوجد عنوان مسجّل");
  const name=esc(o.customer_name), number=esc(o.order_no), status=esc(ST[o.status]||o.status);
  return `<div class="order-compact">
    <div class="order-compact-row">
      <button type="button" class="order-toggle" aria-expanded="${expandedOrderId===o.id}" aria-controls="order-full-${o.id}" onclick="toggleOrderCard(this)">
        <span class="no" dir="ltr">#${number}</span><b class="order-ellipsis" title="${name}">${name}</b><span class="tag">${status}</span>
      </button>
      ${phone?`<a class="order-call-icon" href="tel:${phone}" aria-label="اتصل بالزبون ${name}">${ic("phone")}</a>`:""}
    </div>
    <div class="order-compact-row order-contact">
      ${phone?`<a dir="ltr" href="tel:${phone}">${phone}</a>`:'<span>لا يوجد رقم مسجّل</span>'}
      <span class="order-ellipsis" title="${address}">${address}</span>
    </div>
    <div class="order-compact-row order-compact-footer">
      <span class="order-amount">المطلوب <b>${money(o.total)}</b></span>
      ${oActs(o,true)}
      <span class="order-chevron" aria-hidden="true">${ic("chev")}</span>
    </div>
  </div>`;
}
function toggleOrderCard(source){
  const card=source.closest(".oc2"), previous=$("groups").querySelector(".oc2.is-expanded");
  if(previous){
    previous.classList.remove("is-expanded");
    previous.querySelector(".order-toggle").setAttribute("aria-expanded","false");
  }
  const opening=previous!==card;
  card.classList.toggle("is-expanded",opening);
  card.querySelector(".order-toggle").setAttribute("aria-expanded",String(opening));
  expandedOrderId=opening?card.dataset.orderId:null;
  card.querySelector(opening?".order-collapse":".order-toggle").focus({preventScroll:true});
  if(card.getBoundingClientRect().top<document.querySelector("header").getBoundingClientRect().bottom){
    card.scrollIntoView({block:"start",behavior:"instant"});
  }
}
function openOrderCard(card){
  if(card.querySelector(".order-toggle").getClientRects().length) toggleOrderCard(card);
  else openOrder(card.dataset.orderId);
}
function oc2(o){
  const k=o.status, pp=prPending(o);
  const items=o.order_items.map(i=>`<div class="pi"><span class="q">×${i.qty}</span><span class="pn">${esc(i.products?.name)}</span><span class="pv">${money(Number(i.unit_price)*i.qty)}</span></div>`).join("");
  return `<article class="oc2 s-${k}${expandedOrderId===o.id?" is-expanded":""}" data-order-id="${o.id}" style="cursor:pointer" onclick="if(!event.target.closest('a,button'))openOrderCard(this)">
    ${compactOrder(o)}
    <div class="order-full" id="order-full-${o.id}">
    <div class="r1"><span class="no">#${o.order_no}</span><div class="nm"><b>${esc(o.customer_name)}</b><span>أُنشئ ${when(o.created_at)}</span></div>
      <div style="text-align:end"><span class="tag">${ic(SICO[k]||"box")}${ST[k]||k}</span><div class="mut" style="font-size:12px;margin-top:3px">بتاريخ ${when(o.status_at||o.created_at)}</div></div>
      <button type="button" class="order-collapse" aria-label="طيّ الطلب #${o.order_no}" onclick="toggleOrderCard(this)">${ic("chev")}</button>
    </div>
    <div class="info">
      <a class="ph" href="tel:${esc(o.customer_phone)}">${ic("phone")}<span dir="ltr">${esc(o.customer_phone)}</span></a>
      ${o.customer_address?`<div class="ad">${ic("pin")}<span>${esc(o.customer_address)}</span></div>`:'<div class="ad mut">لا يوجد عنوان مسجّل</div>'}
    </div>
    <div class="prods">${items}
      <div class="sum"><span>منتجات ${money(o.items_total)} + توصيل ${money(o.delivery_fee)}</span><span class="tt">المطلوب: <b>${money(o.total)}</b></span></div></div>
    ${o.note?`<div class="flag a">${ic("msg")}<div><b>ملاحظة الإداري</b> <span class="mut">· ${when(admNoteAt(o))}</span><br>${esc(o.note)}</div></div>`:""}
    ${o.captain_note&&k!=="delivered"?`<div class="flag">${ic("note")}<div><b>ملاحظتك</b> <span class="mut">· ${when(o.captain_note_at||o.status_at)}</span><br>${esc(o.captain_note)}</div></div>`:""}
    ${pp?`<div class="flag">${ic("hourglass")}<div>بانتظار موافقة الإداري على تعديل السعر (${money(pp.old_total)} ← ${money(pp.new_total)})</div></div>`:""}
    <div class="bar"><div class="ac">${oActs(o)}</div><div class="ic"><a class="ib w" href="${waUrl(o)}" target="_blank" rel="noopener" aria-label="واتساب">${waIc()}<span>واتساب</span></a>${mapUrl(o)?`<a class="ib m" href="${mapUrl(o)}" target="_blank" rel="noopener" aria-label="الخريطة">${ic("pin")}<span>الخريطة</span></a>`:""}${OPEN.includes(k)?`<button class="ib d" onclick="openStatus('${o.id}')" aria-label="تغيير الحالة">${ic("note")} تغيير حالة الطلب</button>`:""}</div></div>
    </div>
  </article>`;
}
function oDetail(o){
  const evs=D.ev[o.id]||[], k=o.status;
  const priceBtns=OPEN.includes(k)?`<div class="acts2" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn btn-o btn-sm" onclick="closeStatus();openStatus('${o.id}')">${ic("note")} تغيير الحالة / ملاحظة</button>${!prPending(o)?`<button class="btn btn-t btn-sm" onclick="closeStatus();openPriceReq('${o.id}')">${ic("tag")} طلب تعديل السعر</button>`:""}${D.settings.captain_can_edit_price==="true"?`<button class="btn btn-t btn-sm" onclick="closeStatus();openPrices('${o.id}')">${ic("cash")} تعديل مباشر</button>`:""}</div>`:"";
  return `<div class="r1" style="display:flex;justify-content:space-between;gap:10px"><div><b style="font-size:18px">#${o.order_no} — ${esc(o.customer_name)}</b><div class="mut">${dt(o.created_at)}</div></div><div style="text-align:end"><span class="tag">${ic(SICO[k]||"box")}${ST[k]||k}</span><div class="mut" style="font-size:12px;margin-top:3px">بتاريخ ${when(o.status_at||o.created_at)}</div></div></div>
   <div class="dsec"><div class="dh">الزبون</div><a class="call" href="tel:${esc(o.customer_phone)}">${ic("phone")}<span dir="ltr">${esc(o.customer_phone)}</span></a>
     <div class="qa"><a class="qb wa" href="${waUrl(o)}" target="_blank" rel="noopener">${waIc()} واتساب</a>${mapUrl(o)?`<a class="qb mp" href="${mapUrl(o)}" target="_blank" rel="noopener">${ic("pin")} الخريطة</a>`:""}</div>
     ${o.customer_address?`<div class="addr">${ic("pin")}<span>${esc(o.customer_address)}</span></div>`:""}</div>
   <div class="dsec"><div class="dh">المنتجات</div>${itemsLine(o)}
     <div class="tot"><div><div class="mut">المطلوب من الزبون</div><div class="amt">${money(o.total)}</div></div><div class="mut" style="text-align:end">منتجات ${money(o.items_total)}<br>توصيل ${money(o.delivery_fee)}</div></div></div>
   ${(o.note||o.captain_note||prBox(o))?`<div class="dsec"><div class="dh">الملاحظات</div>
    ${o.note?`<div class="note adm">${ic("msg")}<div><b>من الإداري:</b> ${esc(o.note)}<div class="mut" style="font-size:12px">بتاريخ ${when(admNoteAt(o))}</div></div></div>`:""}
    ${o.captain_note?`<div class="note">${ic("note")}<div>${esc(o.captain_note)}<div class="mut" style="font-size:12px">كتبتها بتاريخ ${when(o.captain_note_at||o.status_at)}</div></div></div>`:""}
    ${prBox(o)}</div>`:""}
   ${evs.length>1?`<details class="tl"><summary>سجل الطلب (${evs.length})</summary>${evs.map(e=>`<div><b style="color:${SCOL[e.status]||"#64748b"}">${ST[e.status]||e.status}</b> · ${dt(e.created_at)}${e.note?" — "+esc(e.note):""}</div>`).join("")}</details>`:""}
   ${k==="delivered"?`<div class="mut" style="margin-top:6px">${ic("checkc")} سُلِّم ${dt(o.delivered_at)}</div>`:""}${priceBtns}`;
}
function openOrder(id){ const o=D.orders.find(x=>x.id===id); if(o) sheet("تفاصيل الطلب",oDetail(o)) }
function matches(o){ const t=q.trim().toLowerCase(); return !t||[o.customer_name,o.customer_phone,String(o.order_no)].some(v=>String(v||"").toLowerCase().includes(t)) }
const EMPTY_SVG='<svg viewBox="0 0 80 80" fill="none"><circle cx="40" cy="40" r="34" fill="#eef3ff"/><path d="M22 34l18-10 18 10v20L40 64 22 54z" fill="#fff" stroke="#93b4f8" stroke-width="2.5" stroke-linejoin="round"/><path d="M22 34l18 10 18-10M40 44v20" stroke="#93b4f8" stroke-width="2.5" stroke-linejoin="round"/></svg>';
let TF=null;
const SBAR=[["assigned","جديدة"],["in_delivery","قيد التوصيل"],["no_answer","لم يتم الرد"],["closed","مغلق"],["other","ملاحظات"],["delivered","مُسلَّمة"],["cancelled","ملغية"]];
function vOrders(){
  const cnt=k=>D.orders.filter(o=>o.status===k).length;
  if(!TF||!SBAR.some(x=>x[0]===TF)) TF=["assigned","in_delivery","no_answer","closed","other"].find(k=>cnt(k)>0)||"assigned";
  const nb=!pushClient.enabled&&notifState()!=="na"&&!localStorage.getItem("nb_dismiss");
  $("main").innerHTML = `${nb?`<div id="push-banner" class="banner n">${ic("bell")}<div><b>فعّل الإشعارات</b><span>لتصلك الطلبات الجديدة وملاحظات الإداري فوراً</span></div><button class="btn" onclick="bellClick().then(()=>render())">تفعيل</button><button class="btn" data-push-diagnostic onclick="pushDiag()" style="margin-inline-start:6px">فحص</button></div>`:""}
  <div class="sbar" id="sbar">${SBAR.map(([k,l])=>{const n=cnt(k);return `<button class="sch ${TF===k?"on":""} ${n&&(k==="assigned"||k==="no_answer")?"hot":""}" style="--c:${SCOL[k]}" onclick="TF='${k}';vOrders();scrollTo({top:0})">${l}<span class="n">${n}</span></button>`}).join("")}</div>
  <div class="search" style="margin-bottom:12px">${ic("search")}<input id="oq" placeholder="بحث بالاسم أو الموبايل أو الرقم" value="${esc(q)}" oninput="q=this.value;drawOrders()"></div>
  <div id="groups"></div>`;
  drawOrders();
  const on=document.querySelector("#sbar .on"); on&&on.scrollIntoView({inline:"center",block:"nearest"});
}
function drawOrders(){
  const t=q.trim(), all=D.orders.filter(o=>o.status===TF), hint=(GROUPS.find(g=>g[0]===TF)||[])[2];
  const list=(t?D.orders.filter(matches):all).slice(0,100);
  if(!list.some(o=>o.id===expandedOrderId)) expandedOrderId=null;
  $("groups").innerHTML=`${!t&&hint?`<div class="hint" style="padding:0 4px 10px;color:var(--mut);font-size:13.5px">${hint}</div>`:""}`+(list.length?`<div class="olist">${list.map(oc2).join("")}</div>`:`<div class="empty">${EMPTY_SVG}<b>لا توجد طلبات</b></div>`);
}
const jump=k=>{TF=k;vOrders()};
let GO={};

/* ===== النوافذ ===== */
function ask(title,html,ok,cls,icon){
  return new Promise(res=>{
    const d=document.createElement("div"); d.className="dlg";
    const col=cls==="r"?"#ef4444":cls==="p"?"#2563eb":"#16a34a";
    d.innerHTML=`<div><div class="di" style="--dc:${col}">${ic(icon||(cls==="r"?"xc":"checkc"))}</div><h3>${title}</h3><div class="bd">${html}</div>
      <div style="display:flex;gap:10px"><button class="btn btn-${cls||"g"}" style="flex:1" id="dk">${ok}</button><button class="btn btn-o" style="flex:1" id="dc">إلغاء</button></div></div>`;
    const done=v=>{d.remove();res(v)};
    d.querySelector("#dk").onclick=()=>done(true); d.querySelector("#dc").onclick=()=>done(false);
    d.onclick=e=>{if(e.target===d)done(false)}; document.body.appendChild(d);
  });
}
const askDeliver=id=>{const o=D.orders.find(x=>x.id===id);
  return ask("تأكيد التسليم",`هل سلّمت الطلب <b>#${o.order_no}</b> للزبون <b>${esc(o.customer_name)}</b>؟<br>المبلغ المستلم من الزبون:<div style="font-size:26px;font-weight:800;color:#15803d">${money(o.total)}</div><div class="mut">سيُخصم المنتجات من جردك ولا يمكن التراجع.</div>`,"نعم، تم التسليم","g","checkc")};
async function quick(id,k){
  if(k==="delivered"){ if(!await askDeliver(id)) return; if(await run(sb.rpc("deliver_order",{p_order:id,p_note:null}),"تم التسليم")) refresh(); return }
  if(await run(sb.rpc("set_order_status",{p_order:id,p_status:k,p_note:null}),k==="in_delivery"?"الطلب الآن قيد التوصيل":"تم")) refresh();
}
async function restore(id){ if(!await ask("استرجاع الطلب","استرجاع هذا الطلب ليعود «جديداً»؟","نعم، استرجاع","p","undo")) return;
  if(await run(sb.rpc("restore_order",{p_order:id,p_note:null}),"تم استرجاع الطلب")) refresh() }
function sheet(title,inner){ $("modal").innerHTML=`<div class="sheet"><div class="sh-h"><b>${title}</b><button class="x" onclick="closeStatus()">${ic("x")}</button></div>${inner}</div>`; $("modal").style.display="flex" }

/* طلب تعديل إجمالي الفاتورة */
function openPriceReq(id){
  const o=D.orders.find(x=>x.id===id);
  sheet(`طلب تعديل الإجمالي — #${o.order_no}`,`
   <div class="card" style="background:#f7f9fd;box-shadow:none"><div class="mut">إجمالي الفاتورة الحالي (شامل التوصيل)</div><div style="font-size:24px;font-weight:800">${money(o.total)}</div><div class="mut">منتجات ${money(o.items_total)} + توصيل ${money(o.delivery_fee)}</div></div>
   <label class="mut">الإجمالي المطلوب</label>
   <input id="pr_new" class="tx" type="number" min="0" step="0.01" value="${o.total}" inputmode="decimal" style="font-size:20px;font-weight:800">
   <div id="pr_d" style="margin:-2px 0 10px;font-weight:700"></div>
   <textarea id="pm_note" rows="2" placeholder="سبب طلب التعديل (مطلوب)"></textarea>
   <button class="btn btn-p btn-block" onclick="sendPriceReq('${id}')">${ic("tag")} إرسال الطلب للإداري</button>`);
  const cur=Number(o.total), upd=()=>{const v=parseFloat($("pr_new").value)||0,d=v-cur; $("pr_d").innerHTML=`<span style="color:${d>0?"#16a34a":d<0?"#dc2626":"#64748b"}">الفرق: ${d>0?"+":""}${money(d)}</span>`}; $("pr_new").oninput=upd; upd();
}
async function sendPriceReq(id){
  const o=D.orders.find(x=>x.id===id), note=$("pm_note").value.trim(), v=parseFloat($("pr_new").value);
  if(isNaN(v)||v<0) return toast("اكتب مبلغاً صحيحاً","err");
  if(v===Number(o.total)) return toast("المبلغ مطابق للإجمالي الحالي","err");
  if(v<Number(o.delivery_fee)) return toast("المبلغ أقل من أجرة التوصيل","err");
  if(!note) return toast("اكتب سبب طلب التعديل","err");
  if(await run(sb.rpc("request_price_change",{p_order:id,p_new_total:v,p_reason:note}),"تم إرسال الطلب للإداري")){ closeStatus(); refresh() }
}
/* تعديل مباشر (إن سمح الإداري) */
function openPrices(id){
  const o=D.orders.find(x=>x.id===id);
  sheet(`تعديل سعر الطلب #${o.order_no}`,`
   ${o.order_items.map(i=>`<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px"><div style="flex:1"><b>${esc(i.products?.name)}</b> × ${i.qty}</div>
     <input class="tx pp" style="max-width:130px;margin:0" data-id="${i.id}" data-old="${i.unit_price}" data-list="${i.list_price}" data-q="${i.qty}" type="number" min="0" step="0.01" value="${i.unit_price}" oninput="pricesTotal()"></div>`).join("")}
   <div id="pm_t" class="mut" style="margin:6px 0"></div>
   <textarea id="pm_note" rows="2" placeholder="سبب تعديل السعر (مطلوب)"></textarea>
   <button class="btn btn-p btn-block" onclick="savePrices('${id}')">حفظ السعر</button>`);
  pricesTotal();
}
function pricesTotal(){
  let sum=0,lst=0; document.querySelectorAll(".pp").forEach(e=>{sum+=(parseFloat(e.value)||0)*e.dataset.q; lst+=e.dataset.list*e.dataset.q});
  $("pm_t").innerHTML=`إجمالي المنتجات: <b>${money(sum)}</b>`;
}
async function savePrices(id){
  const note=$("pm_note").value.trim(); if(!note) return toast("اكتب سبب تعديل السعر","err");
  const all=[...document.querySelectorAll(".pp")].map(e=>({item_id:e.dataset.id,unit_price:parseFloat(e.value),old:parseFloat(e.dataset.old)}));
  if(all.some(p=>isNaN(p.unit_price)||p.unit_price<0)) return toast("سعر غير صالح","err");
  const ch=all.filter(p=>p.unit_price!==p.old); if(!ch.length) return toast("لم تغيّر أي سعر","err");
  if(await run(sb.rpc("update_order_prices",{p_order:id,p_prices:ch.map(({item_id,unit_price})=>({item_id,unit_price})),p_note:note}),"تم حفظ السعر")){ closeStatus(); refresh() }
}

/* نافذة تحديث الحالة */
const SOPTS=[{k:"in_delivery",l:"قيد التوصيل"},{k:"delivered",l:"تم التسليم"},{k:"no_answer",l:"لم يتم الرد"},{k:"closed",l:"مغلق"},{k:"other",l:"ملاحظة أخرى"},{k:"cancelled",l:"إلغاء الطلب"}];
let SM=null;
function openStatus(id){ const o=D.orders.find(x=>x.id===id); SM={id,k:SOPTS.some(x=>x.k===o.status)?o.status:null,note:o.captain_note||""}; drawStatus() }
function closeStatus(){ SM=null; $("modal").style.display="none"; $("modal").innerHTML="" }
function pickStatus(k){ SM.note=$("sm_note").value; SM.k=k; drawStatus() }
function drawStatus(){
  const o=D.orders.find(x=>x.id===SM.id);
  const ph=SM.k==="other"?"اكتب الملاحظة (مطلوبة)":SM.k==="cancelled"?"سبب الإلغاء (اختياري)":"ملاحظة (اختياري)";
  $("modal").innerHTML=`<div class="sheet" style="animation:none"><div class="sh-h"><b>#${o.order_no} — ${esc(o.customer_name)}</b><button class="x" onclick="closeStatus()">${ic("x")}</button></div>
    <div class="opts">${SOPTS.map(x=>`<button class="opt ${SM.k===x.k?"sel":""}" style="--sc:${SCOL[x.k]}" onclick="pickStatus('${x.k}')"><span class="oi">${ic(SICO[x.k])}</span>${x.l}</button>`).join("")}</div>
    <textarea id="sm_note" rows="3" placeholder="${ph}">${esc(SM.note)}</textarea>
    <button class="btn btn-p btn-block" onclick="submitStatus()" ${SM.k?"":"disabled"}>حفظ</button></div>`;
  $("modal").style.display="flex";
}
async function submitStatus(){
  const note=$("sm_note").value.trim(), k=SM.k, id=SM.id;
  if(k==="other"&&!note) return toast("اكتب الملاحظة","err");
  if(k==="cancelled"&&!await ask("إلغاء الطلب","هل تريد إلغاء هذا الطلب؟","نعم، إلغاء","r","xc")) return;
  if(k==="delivered"&&!await askDeliver(id)) return;
  const call = k==="delivered" ? sb.rpc("deliver_order",{p_order:id,p_note:note||null})
             : k==="cancelled" ? sb.rpc("cancel_order",{p_order:id,p_note:note||null})
             : sb.rpc("set_order_status",{p_order:id,p_status:k,p_note:note||null});
  if(await run(call,"تم الحفظ")){ closeStatus(); refresh() }
}

/* ===== الجرد والحساب ===== */
let SF="all", SQ="";
function vStock(){
  const low=Number(D.settings.low_stock||3);
  const all=D.stock||[];
  const st=q=>q<=0?"out":q<=low?"low":"ok";
  const units=all.reduce((a,s)=>a+Math.max(0,Number(s.qty)||0),0);
  const nLow=all.filter(s=>st(s.qty)==="low").length, nOut=all.filter(s=>st(s.qty)==="out").length;
  const cnt={all:all.length,low:nLow,out:nOut};
  $("main").innerHTML = `<button class="stk-back" onclick="go('acc')">${ic("back")||"→"} رجوع إلى حسابي</button><div class="stk-hero"><div><div class="stk-l">إجمالي القطع معي</div><div class="stk-n">${units}</div></div><div class="stk-ic">${ic("store")}</div></div>
   <div class="stk-tiles"><div class="stk-t"><b>${all.length}</b><span>صنف</span></div><div class="stk-t" style="color:#b45309"><b>${nLow}</b><span>منخفض</span></div><div class="stk-t" style="color:#dc2626"><b>${nOut}</b><span>نفد</span></div></div>
   <input id="stkq" class="stk-q" placeholder="ابحث عن منتج…" value="${esc(SQ)}" oninput="SQ=this.value;drawStock()">
   <div class="stk-ch">${[["all","الكل"],["low","منخفض"],["out","نفد"]].map(([k,l])=>`<button class="${SF===k?"on":""}" onclick="SF='${k}';vStock()">${l} <i>${cnt[k]}</i></button>`).join("")}</div>
   <div id="stklist"></div>`;
  drawStock();
}
function drawStock(){
  const low=Number(D.settings.low_stock||3), q=SQ.trim().toLowerCase();
  const st=n=>n<=0?"out":n<=low?"low":"ok";
  const rank={out:0,low:1,ok:2};
  const L={ok:"متوفر",low:"منخفض",out:"نفد"}, C={ok:"#16a34a",low:"#f59e0b",out:"#ef4444"};
  const list=(D.stock||[]).filter(s=>(SF==="all"||st(s.qty)===SF)&&(!q||String(s.products?.name||"").toLowerCase().includes(q)))
    .sort((x,y)=>rank[st(x.qty)]-rank[st(y.qty)]||String(x.products?.name).localeCompare(String(y.products?.name),"ar"));
  const mx=Math.max(10,low*3,...(D.stock||[]).map(s=>Number(s.qty)||0));
  $("stklist").innerHTML = list.length?list.map(s=>{const k=st(s.qty),p=Math.max(4,Math.min(100,Math.round((Number(s.qty)||0)/mx*100)));
    return `<div class="stk-c"><div class="stk-av" style="background:${C[k]}1a;color:${C[k]}">${esc(String(s.products?.name||"؟").trim().charAt(0))}</div>
     <div class="stk-m"><b>${esc(s.products?.name)}</b><div class="stk-bar"><i style="width:${k==="out"?0:p}%;background:${C[k]}"></i></div></div>
     <div class="stk-r"><div class="stk-q2" style="color:${C[k]}">${s.qty}</div><span class="stk-b" style="background:${C[k]}1a;color:${C[k]}">${L[k]}</span></div></div>`}).join("")
   :`<div class="empty" style="box-shadow:none">${EMPTY_SVG}<b>${(D.stock||[]).length?"لا نتائج مطابقة":"لا يوجد جرد مسجَّل"}</b><span>${(D.stock||[]).length?"جرّب تغيير البحث أو الفلتر":"سيضيف الإداري بضاعتك قريباً"}</span></div>`;
}
let ASUB="";
function dayLbl(d){ return new Date(d).toLocaleDateString("ar",{weekday:"long",day:"numeric",month:"long",year:"numeric"}) }
function dayKey(d){ const x=new Date(d); return x.getFullYear()+"-"+x.getMonth()+"-"+x.getDate() }
function vAccSub(){
  const T={orders:"الطلبات المسلّمة",pay:"الدفعات المسددة",fees:"أجور التوصيل"}[ASUB];
  let items;
  if(ASUB==="pay") items=(D.payments||[]).map(p=>({t:p.created_at,amt:Number(p.amount)||0,html:`<div class="row2"><div class="ri" style="background:#16a34a">${ic("check")}</div><div class="m"><b>دفعة مسددة</b><div class="mut">${new Date(p.created_at).toLocaleTimeString("ar",{hour:"numeric",minute:"2-digit"})}${p.note?" · "+esc(p.note):""}</div></div><b class="v">${money(p.amount)}</b></div>`}));
  else items=(D.orders||[]).filter(o=>o.status==="delivered").map(o=>{const t=o.delivered_at||o.status_at||o.created_at,amt=Number(ASUB==="fees"?o.delivery_fee:o.items_total)||0;
    return {t,amt,html:`<div class="row2" onclick="openOrder('${o.id}')" style="cursor:pointer"><div class="ri" style="background:${ASUB==="fees"?"#f59e0b":"#2563eb"}">${ic(ASUB==="fees"?"truck":"box")}</div><div class="m"><b>#${o.order_no} — ${esc(o.customer_name)}</b><div class="mut">${new Date(t).toLocaleTimeString("ar",{hour:"numeric",minute:"2-digit"})}${ASUB==="fees"?" · أجرة التوصيل":" · قيمة المنتجات"}</div></div><b class="v">${money(amt)}</b></div>`}});
  items.sort((a,b)=>new Date(b.t)-new Date(a.t));
  const g=[],idx={}; items.forEach(i=>{const k=dayKey(i.t); if(!(k in idx)){idx[k]=g.length;g.push({t:i.t,l:[],sum:0})} const e=g[idx[k]]; e.l.push(i.html); e.sum+=i.amt});
  const tot=items.reduce((a,i)=>a+i.amt,0);
  $("main").innerHTML=`<button class="stk-back" onclick="ASUB='';vAcc()">رجوع إلى حسابي</button>
   <div class="stk-hero"><div><div class="stk-l">مجموع ${T}</div><div class="stk-n" style="font-size:30px">${money(tot)}</div></div><div class="stk-ic" style="font-size:18px;font-weight:800">${items.length}</div></div>
   ${g.length?g.map(d=>`<div class="dayh"><b>${dayLbl(d.t)}</b><span>${money(d.sum)}</span></div><div class="card" style="padding:4px 12px">${d.l.join("")}</div>`).join(""):`<div class="empty" style="box-shadow:none">${EMPTY_SVG}<b>لا توجد بيانات بعد</b></div>`}`;
}
function vAcc(){
  if(ASUB) return vAccSub();
  const b=D.balance||{};
  const sq=(D.stock||[]).reduce((a,x)=>a+Math.max(0,Number(x.qty)||0),0);
  const row=(c,i,l,v,k)=>`<div class="acr" onclick="ASUB='${k}';vAcc()"><div class="acr-i" style="background:${c}">${ic(i)}</div><div class="acr-l">${l}</div><div class="acr-v">${v}</div><span class="acr-ch">‹</span></div>`;
  $("main").innerHTML = `<div class="bal"><div style="opacity:.85">المتبقي عليّ تسليمه للإدارة</div><div class="big">${money(b.balance)}</div><div style="opacity:.85;font-size:14px">${b.delivered_count||0} طلب مُسلَّم</div></div>
   <div class="card acr-card">
    ${row("#2563eb","box","مجموع الطلبات المسلّمة",money(b.delivered_total),"orders")}
    ${row("#16a34a","cash","مجموع الدفعات المسددة",money(b.paid_total),"pay")}
    ${row("#f59e0b","truck","مجموع أجور التوصيل",money(b.fees_total),"fees")}
   </div>
   <button class="stk-go" onclick="go('stock')"><span class="stk-gi">${ic("store")}</span><span style="flex:1;text-align:start"><b>جرد المستودع</b><small>${(D.stock||[]).length} صنف · ${sq} قطعة</small></span><span style="font-size:22px;color:#94a3b8">‹</span></button>
   <div class="card"><h2>${ic("wallet")} الدفعات المسددة</h2>${D.payments.length?D.payments.map(p=>`<div class="row2"><div class="ri" style="background:#16a34a">${ic("check")}</div><div class="m"><b>${dt(p.created_at)}</b>${p.note?`<div class="mut">${esc(p.note)}</div>`:""}</div><b class="v">${money(p.amount)}</b></div>`).join(""):`<div class="empty" style="box-shadow:none">${EMPTY_SVG}<b>لا توجد دفعات بعد</b></div>`}</div>`;
}

/* ===== تهيئة ===== */
$("i_mail").innerHTML=ic("mail"); $("i_lock").innerHTML=ic("lock"); $("eye").innerHTML=ic("eye");
$("eye").onclick=()=>{ const p=$("pw"); p.type=p.type==="password"?"text":"password" };
$("pw").addEventListener("keydown",e=>{ if(e.key==="Enter") login() }); $("em").addEventListener("keydown",e=>{ if(e.key==="Enter") $("pw").focus() });
$("rf").innerHTML=ic("refresh"); $("lo").innerHTML=ic("logout"); initNotifUI();
$("t_orders").innerHTML=ic("box")+"<span>طلباتي</span>"; $("t_stock").innerHTML=ic("store")+"<span>جرد المستودع</span>"; $("t_acc").innerHTML=ic("wallet")+"<span>حسابي</span>";
if(!pushClient.native?.embedded) pushClient.registration().catch(e=>console.warn("push registration",e));

const appRefresh=new DeliveryRefresh({
  offline,role:'captain',interval:20000,
  active:()=>!!me&&!authGate.blocked&&$('app').style.display!=='none'&&$('splash').classList.contains('off'),
  safe:()=>busy===0&&!(pushClient.native?.pending?.size)&&!$('pdg')&&$('modal').style.display!=='flex'&&!document.querySelector('.dlg')&&!(document.activeElement&&document.activeElement.matches('input,textarea,select,[contenteditable]')),
  toast,
  fetchData:async({signal})=>{
    const result=await load(false,{signal});
    if(result===false||signal.aborted||!me||authGate.blocked)return false;
    if(!appRefresh.safe())return false;
    const y=scrollY;render_if_idle();scrollTo({top:y,behavior:'instant'});return true;
  },
  captureView:()=>({owner:me?.id,tab,q,TF,SF,SQ,y:scrollY}),
  restoreView:v=>{
    if(v.owner!==me?.id)return;
    if(typeof v.q==='string')q=v.q.slice(0,200);if(SBAR.some(x=>x[0]===v.TF))TF=v.TF;
    if(['all','low','out'].includes(v.SF))SF=v.SF;if(typeof v.SQ==='string')SQ=v.SQ.slice(0,200);
    if(['orders','stock','acc','notifs'].includes(v.tab))go(v.tab);
    requestAnimationFrame(()=>scrollTo({top:Math.max(0,Number(v.y)||0),behavior:'instant'}));
  }
});
offline.configure({
  sessionEnded:()=>{authGate.closed=true;authGate.storage.setItem(authGate.marker,"1");authGate.clearSession();showLogin();$("main").innerHTML="";$("modal").style.display="none";location.reload();},
  toast,login:offlineLogin,safe:()=>!appRefresh.hasDraft()&&appRefresh.options.safe(),
  capture:()=>appRefresh.options.captureView(),reconnected:v=>appRefresh.options.restoreView(v),
  restore:async record=>{
    me=record.profile.captain;D=record.data;CUR=D.settings.currency||"";BIZ=D.settings.business_name||"";
    $("av").textContent=(me.name||"ك").trim().charAt(0);$("hn").textContent=me.name;$("hs").textContent=BIZ||"جاهز لاستلام الطلبات";
    $("login").style.display="none";$("app").style.display="block";firstLoad=false;
    setBadge(D.orders.filter(o=>OPEN.includes(o.status)).length);go("orders");hideSplash();initNotifUI();openPushTarget();
  }
});
offline.watch(sb.auth);
boot();
