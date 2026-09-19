// ============================================================
// X GYM — Member Portal
// نفس Supabase Backend المستخدم في لوحة الأدمن (نفس القيم
// الافتراضية الموجودة في index.html الخاص بالأدمن؛ لو الأدمن
// غيّر مشروع Supabase من شاشة الإعدادات، القيمة بتتحدث تلقائيًا
// لو الصفحتين على نفس الدومين لأنهم بيستخدموا نفس مفاتيح
// localStorage: xgym_sb_url / xgym_sb_key)
// ============================================================
const SB_URL = localStorage.getItem('xgym_sb_url') || 'https://hotheuohwywchcrydvxl.supabase.co';
const SB_KEY = localStorage.getItem('xgym_sb_key') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhvdGhldW9od3l3Y2hjcnlkdnhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNTA0OTAsImV4cCI6MjA5NTYyNjQ5MH0.plhZ_0ihIw1T7w0gKrvyxAGkU6iyvFd0k6PsuPk7ovY';
const MEMBER_PHOTO_BUCKET = 'member-photos';

const _sb = supabase.createClient(SB_URL, SB_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'xgym_member_session' }
});

let currentMember = null;   // JSON blob (data column) لبيانات العضو
let currentUserId = null;   // auth.uid()
let currentRowId = null;    // id (نص، رقم العضوية مثل XG-0001)
let attendanceRows = [];
let priceNames = {};
let _attSub = null, _memSub = null;

const STATUS_LABELS = { active:'نشط', expired:'منتهي', frozen:'مجمد', pending:'معلّق' };
const STATUS_ICONS  = { active:'fa-circle-check', expired:'fa-circle-xmark', frozen:'fa-lock', pending:'fa-clock' };
const STATUS_DOT_LABELS = { active:'عضويتك فعالة', expired:'عضويتك منتهية', frozen:'عضويتك مجمّدة', pending:'عضويتك معلّقة' };

function memberAuthEmail(id){
  return id.trim().toLowerCase().replace(/[^a-z0-9]/g,'') + '@xgym-members.app';
}
// لازم يطابق بالظبط نفس التطبيع المستخدم في الأدمن عند إنشاء/تحديث حساب العضو
function normalizePhone(phone){
  return (phone||'').replace(/[^0-9]/g,'');
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove('show'), 2600);
}

// ===================== الاستخدام بدون نت =====================
// بعد أول تسجيل دخول ناجح بنحفظ نسخة من بيانات العضو (الاشتراك + الحضور)
// على الموبايل، وعشان كده الصفحة والباركود بيفتحوا حتى من غير نت.
// أول ما النت يرجع بنجيب البيانات الجديدة تلقائيًا.
const SNAP_KEY = 'xgym_offline_snapshot';
let offlineMode = false;     // true = بنعرض بيانات محفوظة مش لحظية
let _snapSavedAt = null;

function withTimeout(promise, ms){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
function isNetworkError(err){
  if(!navigator.onLine) return true;
  if(!err) return false;
  return /fetch|network|load failed|timeout|abort/i.test(String(err.message || '') + ' ' + String(err.name || ''));
}

function saveOfflineSnapshot(){
  if(!currentMember || !currentRowId) return;
  try{
    _snapSavedAt = Date.now();
    localStorage.setItem(SNAP_KEY, JSON.stringify({
      userId: currentUserId, rowId: currentRowId, member: currentMember,
      attendance: attendanceRows.slice(0, 200), prices: priceNames, savedAt: _snapSavedAt
    }));
  }catch(e){ console.warn('snapshot save failed', e); }
}
function readOfflineSnapshot(){
  try{
    const s = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    return (s && s.rowId && s.member) ? s : null;
  }catch(e){ return null; }
}
function clearOfflineSnapshot(){
  try{ localStorage.removeItem(SNAP_KEY); }catch(e){}
  _snapSavedAt = null;
}

function updateOfflineBar(){
  const bar = document.getElementById('offline-bar');
  if(!bar) return;
  if(!offlineMode && navigator.onLine){ bar.classList.remove('show'); return; }
  const txt = document.getElementById('offline-bar-text');
  if(txt){
    txt.textContent = (offlineMode && _snapSavedAt)
      ? 'وضع عدم الاتصال — آخر تحديث للبيانات: ' + formatDate(new Date(_snapSavedAt).toISOString())
      : 'أنت غير متصل بالإنترنت';
  }
  bar.classList.add('show');
}

// يعرض آخر بيانات محفوظة (من غير أي اتصال بالسيرفر)
function applyOfflineSnapshot(snap){
  currentUserId = snap.userId;
  currentRowId = snap.rowId;
  currentMember = snap.member;
  attendanceRows = snap.attendance || [];
  priceNames = snap.prices || {};
  _snapSavedAt = snap.savedAt || null;
  offlineMode = true;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  const nav = document.getElementById('bottom-nav'); if(nav) nav.style.display = 'flex';
  renderHome(); renderAttendance(); renderBarcode();
  try{ initNotifications(); }catch(e){ console.warn(e); }
  updateOfflineBar();
}

// يحمّل صورة العضو في كاش الـService Worker عشان تظهر بدون نت
function warmPhotoCache(){
  const u = currentMember && currentMember.photo_url;
  if(u && navigator.onLine) fetch(u, { mode:'no-cors' }).catch(() => {});
}

// لما النت يرجع: هات البيانات الجديدة
let _syncing = false;
async function syncFromServer(){
  if(!offlineMode || !currentUserId || !navigator.onLine || _syncing) return;
  _syncing = true;
  try{
    const res = await withTimeout(_sb.auth.getSession(), 8000);
    const session = res && res.data && res.data.session;
    if(session){
      currentUserId = session.user.id;
      await loadMemberData();
      if(!offlineMode) showToast('تم تحديث بياناتك ✓');
    }else if(!(res && res.error && isNetworkError(res.error))){
      showToast('انتهت الجلسة — سجّل دخولك مرة أخرى');
      logout();
    }
  }catch(e){ /* النت لسه ضعيف — نفضل على البيانات المحفوظة */ }
  _syncing = false;
}
window.addEventListener('online', () => { updateOfflineBar(); syncFromServer(); });
window.addEventListener('offline', () => {
  updateOfflineBar();
  if(currentMember) showToast('انقطع الاتصال — التطبيق شغال بآخر بيانات محفوظة');
});
document.addEventListener('visibilitychange', () => { if(!document.hidden) syncFromServer(); });

// ===================== تسجيل الدخول =====================
async function doLogin(){
  const idInput = document.getElementById('login-id').value.trim();
  const pin = normalizePhone(document.getElementById('login-pin').value.trim());
  const errBox = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  errBox.style.display = 'none';

  if(!navigator.onLine){
    errBox.textContent = 'لا يوجد اتصال بالإنترنت — تسجيل الدخول محتاج نت';
    errBox.style.display = 'block';
    return;
  }

  if(!idInput || !pin){
    errBox.textContent = 'اكتب رقم العضوية ورقم الموبايل';
    errBox.style.display = 'block';
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الدخول...';

  const email = memberAuthEmail(idInput);
  const { data, error } = await _sb.auth.signInWithPassword({ email, password: pin });

  btn.disabled = false;
  btn.innerHTML = 'تسجيل الدخول';

  if(error || !data.session){
    console.warn('member login error:', error);
    if(error && /email/i.test(error.message||'') && /confirm/i.test(error.message||'')){
      errBox.textContent = 'الحساب محتاج تأكيد إيميل — اطلب من الأدمن يضغط "مزامنة/تفعيل الدخول" في بيانات العضو';
    }else{
      errBox.textContent = 'رقم العضوية أو رقم الموبايل غير صحيح' + (error?(' ('+error.message+')'):'');
    }
    errBox.style.display = 'block';
    return;
  }
  currentUserId = data.session.user.id;
  await loadMemberData();
}

async function tryRestoreSession(){
  const snap = readOfflineSnapshot();
  let session = null, err = null;
  try{
    const res = await withTimeout(_sb.auth.getSession(), 4000);
    session = (res && res.data && res.data.session) || null;
    err = (res && res.error) || null;
  }catch(e){ err = e; }

  if(session){
    currentUserId = session.user.id;
    await loadMemberData();
    return;
  }
  // مفيش جلسة صالحة دلوقتي: لو السبب انقطاع النت وعندنا بيانات محفوظة، اعرضها
  if(snap && (!navigator.onLine || (err && isNetworkError(err)))){
    applyOfflineSnapshot(snap);
  }
}

function logout(){
  if(_attSub) _sb.removeChannel(_attSub);
  if(_memSub) _sb.removeChannel(_memSub);
  // من غير نت: خروج محلي بس (طلب الخروج للسيرفر محتاج اتصال)
  _sb.auth.signOut(navigator.onLine ? undefined : { scope:'local' }).catch(() => {});
  clearOfflineSnapshot();
  offlineMode = false;
  currentMember = null; currentRowId = null; currentUserId = null;
  document.getElementById('app').style.display = 'none';
  const _nav = document.getElementById('bottom-nav'); if(_nav) _nav.style.display = 'none';
  if(typeof closeTrainingVideo === 'function') closeTrainingVideo();
  _trSystem = null; if(typeof renderTraining === 'function') renderTraining();
  if(typeof switchToMain === 'function') switchToMain('home');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-id').value = '';
  document.getElementById('login-pin').value = '';
}

// ===================== تحميل بيانات العضو =====================
async function loadMemberData(){
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  const snap = readOfflineSnapshot();
  const sameUser = !!snap && (!currentUserId || snap.userId === currentUserId);

  // مفيش نت خالص وعندنا بيانات محفوظة → اعرضها فورًا
  if(!navigator.onLine && sameUser){ applyOfflineSnapshot(snap); return; }

  document.getElementById('home-panel').innerHTML = '<div class="spinner"></div>';

  let row = null, error = null;
  try{
    const res = await withTimeout(
      _sb.from('xgym_members').select('id,data,photo_url,user_id').eq('user_id', currentUserId).single(),
      10000
    );
    row = res.data; error = res.error;
  }catch(e){ error = e; }

  if(error || !row){
    // النت ضعيف/مقطوع → نفضل على البيانات المحفوظة بدل ما نطلّع العضو
    if(sameUser && isNetworkError(error)){ applyOfflineSnapshot(snap); return; }
    showToast('تعذر جلب بياناتك — حاول تسجيل الدخول مرة أخرى');
    logout();
    return;
  }

  offlineMode = false;
  currentRowId = row.id;
  currentMember = { ...row.data, photo_url: row.photo_url || row.data.photo_url || null };

  await Promise.all([ loadPrices(), loadAttendance() ]);
  saveOfflineSnapshot();
  updateOfflineBar();
  renderHome();
  renderAttendance();
  renderBarcode();
  subscribeRealtime();
  initNotifications();
  warmPhotoCache();
}

async function loadPrices(){
  try{
    const { data, error } = await _sb.from('xgym_prices').select('key,name');
    if(error || !data){
      if(!Object.keys(priceNames).length){ const s = readOfflineSnapshot(); if(s) priceNames = s.prices || {}; }
      return;
    }
    priceNames = {};
    data.forEach(p => priceNames[p.key] = p.name);
  }catch(e){ console.warn('loadPrices failed', e); }
}

async function loadAttendance(){
  try{
    const { data, error } = await _sb
      .from('xgym_attendance')
      .select('*')
      .eq('member_id', currentRowId)
      .order('time', { ascending:false })
      .limit(200);
    if(error || !data){
      if(!attendanceRows.length){ const s = readOfflineSnapshot(); if(s && s.rowId === currentRowId) attendanceRows = s.attendance || []; }
      return;
    }
    attendanceRows = data;
  }catch(e){ console.warn('loadAttendance failed', e); }
}

// ===================== Realtime =====================
function subscribeRealtime(){
  if(_memSub) _sb.removeChannel(_memSub);
  if(_attSub) _sb.removeChannel(_attSub);

  _memSub = _sb.channel('member-row-'+currentRowId)
    .on('postgres_changes', { event:'*', schema:'public', table:'xgym_members', filter:`id=eq.${currentRowId}` },
      (payload) => {
        if(payload.new){
          currentMember = { ...payload.new.data, photo_url: payload.new.photo_url || payload.new.data.photo_url || null };
          renderHome();
          renderBarcode();
          renderNotifications();
          saveOfflineSnapshot();
        }
      })
    .subscribe();

  _attSub = _sb.channel('member-att-'+currentRowId)
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'xgym_attendance', filter:`member_id=eq.${currentRowId}` },
      (payload) => { loadAttendance().then(() => { renderAttendance(); renderNotifications(); saveOfflineSnapshot(); }); handleNewAttendance(payload.new); })
    .subscribe();
}

// ===================== حسابات الاشتراك =====================
function daysRemaining(){
  if(!currentMember.end) return 0;
  const end = new Date(currentMember.end + 'T23:59:59');
  const diff = Math.ceil((end - new Date()) / 86400000);
  return diff;
}
function computedStatus(){
  if(currentMember.status === 'frozen') return 'frozen';
  if(currentMember.status === 'pending') return 'pending';
  return daysRemaining() <= 0 ? 'expired' : 'active';
}

// ===================== عرض الرئيسية =====================
function renderHome(){
  const m = currentMember;
  const status = computedStatus();
  const dRem = Math.max(daysRemaining(), 0);
  const totalDays = m.days_total || m.duration || null;
  const startMs = new Date(m.start).getTime();
  const endMs = new Date(m.end).getTime();
  const nowMs = Date.now();
  const pct = endMs > startMs ? Math.min(100, Math.max(0, ((nowMs - startMs) / (endMs - startMs)) * 100)) : 0;

  const totalAttendance = attendanceRows.length;
  const lastAtt = attendanceRows[0];
  const recentAtt = attendanceRows.slice(0, 3);
  const firstName = (m.name||'').trim().split(' ')[0] || '';

  document.getElementById('home-panel').innerHTML = `
    <div class="greet-wrap">
      <div class="greet-hello">أهلاً، ${m.name||''} <span class="greet-wave">👋</span></div>
      <div class="greet-sub">جاهز تتمرن النهارده؟</div>
    </div>

    <div class="profile-card">
      <div class="profile-top">
        <div class="profile-photo-wrap" id="photo-wrap">
          ${m.photo_url ? `<img src="${m.photo_url}">` : (m.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2)}
          <label class="photo-upload-btn" for="photo-input"><i class="fas fa-camera"></i></label>
        </div>
        <div class="profile-info">
          <div class="profile-name">${m.name||''}</div>
          <div class="profile-id">${currentRowId}</div>
          <div class="status-dot-row status-${status}"><span class="dot"></span>${STATUS_DOT_LABELS[status]}</div>
        </div>
      </div>
      <input type="file" id="photo-input" accept="image/*" style="display:none" onchange="handlePhotoUpload(this)">

      <div class="profile-divider"></div>
      <div class="days-row">
        <div class="days-col">
          <div class="days-label">الأيام المتبقية</div>
          <div class="days-num">${status==='expired' ? 0 : dRem}<span class="days-unit">يوم</span></div>
        </div>
        <div class="end-col">
          <div class="end-label"><i class="fas fa-calendar-days"></i>تاريخ الانتهاء</div>
          <div class="end-val">${m.end ? formatEndDate(m.end) : '—'}</div>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${status==='expired'?100:pct}%"></div></div>
      ${totalDays ? `<div class="days-fraction">${status==='expired' ? totalDays : dRem} / ${totalDays}</div>` : ''}
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-icon"><i class="fas fa-dumbbell"></i></div>
        <div class="stat-val">${totalAttendance}</div>
        <div class="stat-label">إجمالي مرات الحضور</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i class="fas fa-calendar-check"></i></div>
        <div class="stat-val">${lastAtt ? formatRelativeAttendance(lastAtt.time) : '—'}</div>
        <div class="stat-label">آخر حضور</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i class="fas fa-clock"></i></div>
        <div class="stat-val">${status==='expired' ? 0 : dRem} يوم</div>
        <div class="stat-label">الأيام المتبقية</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon stat-icon-gold"><i class="fas fa-crown"></i></div>
        <div class="stat-val stat-val-gold">${STATUS_LABELS[status]}</div>
        <div class="stat-label">حالة الاشتراك</div>
      </div>
    </div>

    <div class="section-head">
      <div class="section-title">آخر النشاط</div>
      <div class="see-all" onclick="switchToMain('attendance')">عرض الكل</div>
    </div>
    ${recentAtt.length ? `
    <div class="activity-row">
      ${recentAtt.map(a => `
        <div class="activity-card">
          <div class="activity-icon"><i class="fas fa-calendar-day"></i></div>
          <div class="activity-date">${formatActivityDate(a.time)}</div>
          <div class="activity-time">${formatActivityTime(a.time)}</div>
          <div class="activity-tag">حضور</div>
        </div>
      `).join('')}
    </div>` : `<div class="empty-state"><i class="fas fa-calendar-xmark"></i>لا يوجد سجل حضور حتى الآن</div>`}
  `;
}

function formatDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('ar-EG', { day:'2-digit', month:'2-digit' }) + ' · ' + d.toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' });
}
function formatEndDate(iso){
  const d = new Date(iso);
  // علامة LRM عشان التاريخ يتعرض "28 Aug 2026" مش "Aug 2026 28" جوّه صفحة عربي
  return '\u200E' + d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) + '\u200E';
}
function formatActivityDate(iso){
  return new Date(iso).toLocaleDateString('en-CA').replace(/-/g,'/');
}
function formatActivityTime(iso){
  return new Date(iso).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
}
function formatRelativeAttendance(iso){
  const d = new Date(iso);
  const now = new Date();
  const time = formatActivityTime(iso);
  if(d.toDateString() === now.toDateString()) return 'اليوم ' + time;
  const y = new Date(now); y.setDate(now.getDate()-1);
  if(d.toDateString() === y.toDateString()) return 'أمس ' + time;
  return formatActivityDate(iso);
}

// ===================== رفع صورة البروفايل =====================
async function handlePhotoUpload(input){
  const file = input.files[0];
  if(!file) return;
  if(!navigator.onLine){ showToast('رفع الصورة محتاج اتصال بالإنترنت'); input.value = ''; return; }
  showToast('جاري رفع الصورة...');
  try{
    const resizedBlob = await resizeImage(file, 480);
    const path = `${currentUserId}/photo.jpg`;
    const { error: upErr } = await _sb.storage.from(MEMBER_PHOTO_BUCKET).upload(path, resizedBlob, { contentType:'image/jpeg', upsert:true });
    if(upErr) throw upErr;
    const { data } = _sb.storage.from(MEMBER_PHOTO_BUCKET).getPublicUrl(path);
    const url = data.publicUrl + '?t=' + Date.now();
    const { error: updErr } = await _sb.from('xgym_members').update({ photo_url:url }).eq('id', currentRowId);
    if(updErr) throw updErr;
    currentMember.photo_url = url;
    saveOfflineSnapshot();
    warmPhotoCache();
    renderHome();
    showToast('تم تحديث صورتك بنجاح');
  }catch(e){
    console.warn(e);
    showToast('تعذر رفع الصورة — حاول مرة أخرى');
  }
}

function resizeImage(file, maxSize){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e => img.src = e.target.result;
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if(width > height && width > maxSize){ height *= maxSize/width; width = maxSize; }
      else if(height > maxSize){ width *= maxSize/height; height = maxSize; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('resize failed')), 'image/jpeg', 0.85);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===================== الحضور =====================
function renderAttendance(){
  const wrap = document.getElementById('attendance-panel');

  const now = new Date();
  const monthCount = attendanceRows.filter(a=>{
    const d = new Date(a.time);
    return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
  }).length;
  const totalEl = document.getElementById('att-total-val');
  const monthEl = document.getElementById('att-month-val');
  if(totalEl) totalEl.textContent = attendanceRows.length;
  if(monthEl) monthEl.textContent = monthCount;

  if(!attendanceRows.length){
    wrap.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-xmark"></i>لا يوجد سجل حضور حتى الآن</div>`;
    return;
  }
  wrap.innerHTML = attendanceRows.map(a => `
    <div class="att-item-v2">
      <div class="att-pill">حضور</div>
      <div class="att-item-info">
        <div class="att-item-time">${formatActivityTime(a.time)}</div>
        <div class="att-item-date">${formatActivityDate(a.time)}</div>
      </div>
      <div class="att-item-cal"><i class="fas fa-calendar-days"></i></div>
    </div>
  `).join('');
}

// ===================== الباركود =====================
// JsBarcode بيمسح الـstyle بتاع العنصر بعد الرسم (وده كان سبب خروج الباركود
// برّه الكارت في الموبايل)، فبنحدد المقاس بنفسنا ونرجّع الـstyle بعد الرسم.
// كل خط (module) بياخد عدد صحيح من بكسلات الشاشة عشان الخطوط تطلع حادة
// وأسهل في قراءة الاسكانر.
function drawBarcode(selector, code, availWidth, opts){
  opts = opts || {};
  const el = document.querySelector(selector);
  if(!el) return null;
  const quiet = opts.quiet != null ? opts.quiet : 2;      // مسافة فاضية على الجنبين (بالـmodule)
  try{
    // 1) رسمة تجريبية عشان نعرف عدد الـmodules الفعلي للكود ده
    JsBarcode(el, code, { format:'CODE128', width:1, height:10, margin:0, displayValue:false });
    const modules = parseFloat(el.getAttribute('width')) + quiet * 2;

    // 2) أكبر عدد صحيح من بكسلات الشاشة لكل module بيتّسع في العرض المتاح
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(1, Math.floor((availWidth * dpr) / modules));
    const w = Math.min(px / dpr, opts.maxModule || 4);

    // 3) الرسمة النهائية
    JsBarcode(el, code, {
      format:'CODE128', width:w, height:opts.height || 90, displayValue:true,
      font:'Arial', fontSize:opts.fontSize || 14, textMargin:4,
      marginLeft:quiet * w, marginRight:quiet * w,
      marginTop: opts.marginTop != null ? opts.marginTop : 6,
      marginBottom: opts.marginBottom != null ? opts.marginBottom : 4,
      background:'#ffffff', lineColor:'#000000'
    });
  }catch(e){ console.warn('barcode render error', e); return null; }
  el.style.cssText = 'display:block;margin:0 auto;max-width:100%;height:auto;shape-rendering:crispEdges';
  return el;
}

// العرض المتاح جوّه كارت الباركود (لو التاب مخفي بنقدّره من عرض الشاشة)
function passBarcodeAvail(){
  const card = document.querySelector('.pass-barcode-card');
  if(card && card.clientWidth > 0){
    const cs = getComputedStyle(card);
    return card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }
  return Math.min(window.innerWidth, 480) - 32 - 40 - 2 - 24;
}

function renderBarcode(){
  const m = currentMember;
  const code = m.barcode || currentRowId;
  const status = computedStatus();

  // بطاقة العضوية (Membership Pass)
  const photoWrap = document.getElementById('pass-photo-wrap');
  if(photoWrap) photoWrap.innerHTML = m.photo_url
    ? `<img src="${m.photo_url}" alt="">`
    : (m.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2);
  const nameEl = document.getElementById('pass-name');
  if(nameEl) nameEl.textContent = m.name || '';
  const idEl = document.getElementById('pass-id');
  if(idEl) idEl.textContent = currentRowId;
  const statusEl = document.getElementById('pass-status-row');
  if(statusEl) statusEl.innerHTML = `<span class="pass-status-pill status-${status}"><span class="dot"></span>${STATUS_DOT_LABELS[status]}</span>`;
  const expEl = document.getElementById('pass-expiry-val');
  if(expEl) expEl.textContent = m.end ? formatEndDate(m.end) : '—';

  drawBarcode('#member-barcode-svg', code, passBarcodeAvail(), { height:90, fontSize:14 });
}

// ---- عرض الباركود مكبّرًا (شاشة كاملة بيضاء) ----
let _bcRotated = false;
let _wakeLock = null;

async function acquireWakeLock(){
  try{
    if('wakeLock' in navigator){
      _wakeLock = await navigator.wakeLock.request('screen');
      _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    }
  }catch(e){ /* مش كل المتصفحات بتدعمه */ }
}
function releaseWakeLock(){
  try{ if(_wakeLock){ _wakeLock.release(); _wakeLock = null; } }catch(e){}
}
document.addEventListener('visibilitychange', () => {
  const modal = document.getElementById('barcode-modal');
  if(!document.hidden && modal && modal.classList.contains('show') && !_wakeLock) acquireWakeLock();
});

function renderModalBarcode(){
  if(!currentMember) return;
  const code = currentMember.barcode || currentRowId;
  const svg = document.getElementById('member-barcode-svg-modal');
  const stage = document.getElementById('bc-stage');
  if(!svg || !stage) return;
  const vw = window.innerWidth, vh = window.innerHeight;

  if(!_bcRotated){
    stage.style.width = ''; stage.style.height = '';
    drawBarcode('#member-barcode-svg-modal', code, Math.min(vw, 520) - 32, { height:140, fontSize:16, quiet:4 });
    return;
  }
  // وضع التدوير: الباركود بياخد طول الشاشة كله (خطوط أعرض وأطول)
  const barH = Math.max(90, Math.min(240, vw - 32 - 46));
  drawBarcode('#member-barcode-svg-modal', code, vh - 250, { height:barH, fontSize:16, quiet:4 });
  const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
  stage.style.width = h + 'px'; stage.style.height = w + 'px';
  svg.style.cssText = 'display:block;position:absolute;left:50%;top:50%;max-width:none;' +
    'width:' + w + 'px;height:' + h + 'px;transform:translate(-50%,-50%) rotate(90deg);shape-rendering:crispEdges';
}

function updateRotateBtn(){
  const b = document.getElementById('bc-rotate-btn');
  if(b) b.innerHTML = _bcRotated
    ? '<i class="fas fa-rotate-left"></i> الوضع العادي'
    : '<i class="fas fa-rotate"></i> تكبير (تدوير)';
}
function toggleBarcodeRotate(){
  _bcRotated = !_bcRotated;
  updateRotateBtn();
  renderModalBarcode();
}

function showFullBarcode(){
  const sub = document.getElementById('bc-modal-sub');
  if(sub) sub.textContent = (currentMember.name || '') + ' | ' + currentRowId;
  const status = computedStatus();
  const st = document.getElementById('bc-modal-status');
  if(st){ st.className = 'bc-status status-' + status; st.innerHTML = '<span class="dot"></span>' + STATUS_DOT_LABELS[status]; }
  _bcRotated = false;
  updateRotateBtn();
  document.body.classList.add('bc-open');      // يخفي شريط التنقل السفلي
  document.getElementById('barcode-modal').classList.add('show');
  renderModalBarcode();
  acquireWakeLock();        // الشاشة متطفيش وهو معروض
}
function closeFullBarcode(){
  document.getElementById('barcode-modal').classList.remove('show');
  document.body.classList.remove('bc-open');
  releaseWakeLock();
}

// لو الشاشة اتقلبت أو اتغيّر حجمها: أعد رسم الباركود على المقاس الجديد
let _bcResizeTimer = null;
function onBarcodeResize(){
  clearTimeout(_bcResizeTimer);
  _bcResizeTimer = setTimeout(() => {
    if(!currentMember) return;
    const modal = document.getElementById('barcode-modal');
    if(modal && modal.classList.contains('show')) renderModalBarcode();
    const panel = document.getElementById('barcode-panel-wrap');
    if(panel && panel.classList.contains('active')) renderBarcode();
  }, 150);
}
window.addEventListener('resize', onBarcodeResize);
window.addEventListener('orientationchange', onBarcodeResize);

// صورة الباركود للتحميل/الطباعة: بنرسم باركود جديد بدقة عالية (مش النسخة اللي على الشاشة)
function getBarcodeDataURL(){
  return new Promise(resolve=>{
    const code = currentMember.barcode || currentRowId;
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try{
      JsBarcode(tmp, code, {
        format:'CODE128', width:3, height:70, displayValue:true, font:'Arial', fontSize:16, textMargin:3,
        marginLeft:30, marginRight:30, marginTop:6, marginBottom:4, background:'#ffffff', lineColor:'#000000'
      });
    }catch(e){ resolve(null); return; }
    const svgData = new XMLSerializer().serializeToString(tmp);
    const blob = new Blob([svgData], { type:'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const S = 2;   // دقة مضاعفة عشان الصورة تطلع حادة
    const canvas = document.createElement('canvas');
    canvas.width = 560 * S; canvas.height = 220 * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,560,220);
    const grad = ctx.createLinearGradient(0,0,560,0);
    grad.addColorStop(0,'#2563EB'); grad.addColorStop(1,'#1D4ED8');
    ctx.fillStyle = grad; ctx.fillRect(0,0,560,7);
    ctx.fillStyle = '#111'; ctx.font = 'bold 22px Arial'; ctx.textAlign = 'center';
    ctx.fillText('X GYM', 280, 40);
    ctx.fillStyle = '#333'; ctx.font = 'bold 15px Arial';
    ctx.fillText(currentMember.name||'', 280, 64);
    ctx.fillStyle = '#777'; ctx.font = '12px Arial';
    ctx.fillText((priceNames[currentMember.type]||currentMember.type||'')+' | '+currentRowId, 280, 84);
    const img = new Image();
    img.onload = () => {
      const bw = Math.min(500, img.width); const bh = img.height * (bw/img.width);
      ctx.drawImage(img, (560-bw)/2, 95, bw, bh);
      URL.revokeObjectURL(url);
      ctx.fillStyle = grad; ctx.fillRect(0,213,560,7);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function downloadBarcode(){
  getBarcodeDataURL().then(dataUrl=>{
    if(!dataUrl){ showToast('تعذر إنشاء الصورة'); return; }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'barcode_' + currentRowId + '.png';
    a.click();
  });
}

function printBarcode(){
  getBarcodeDataURL().then(dataUrl=>{
    const w = window.open('', '_blank', 'width=500,height=400');
    w.document.write(`<html><body style="text-align:center;margin:0;padding:20px">
      ${dataUrl?`<img src="${dataUrl}" style="max-width:100%">`:''}
      <\x73cript>window.onload=()=>{window.print();window.close();}<\/script>
    </body></html>`);
    w.document.close();
  });
}

// ===================== التنقل بين التابات =====================
function switchTab(tab){
  document.querySelectorAll('.tab-panel').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el=>el.classList.remove('active'));
  document.getElementById(tab+'-panel').classList.add('active');
  document.getElementById('nav-'+tab).classList.add('active');
}


// ===================== الإشعارات (داخل التطبيق فقط) =====================
const notifLogKey  = () => 'xgym_notif_log_' + currentRowId;
const notifSeenKey = () => 'xgym_notif_seen_' + currentRowId;
const notifCatchKey = () => 'xgym_notif_catchup_' + currentRowId;
const notifDailyKey = () => 'xgym_daily_notif_' + currentRowId;

function attTag(row){ return 'att-' + (row && row.id != null ? row.id : (row ? row.time : '')); }
function todayKey(){ return new Date().toLocaleDateString('en-CA'); }

function getNotifLog(){
  try{ return JSON.parse(localStorage.getItem(notifLogKey()) || '[]'); }catch(e){ return []; }
}
// يضيف إشعار للسجل (بدون تكرار) — يرجّع true لو كان جديد
function pushNotifLog(entry){
  const log = getNotifLog();
  if(log.some(n => n.id === entry.id)) return false;
  log.unshift(entry);
  log.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  try{ localStorage.setItem(notifLogKey(), JSON.stringify(log.slice(0, 30))); }catch(e){}
  return true;
}

// هل كان الاشتراك منتهيًا وقت الحضور ده؟
function expiredAt(iso){
  if(!currentMember || !currentMember.end) return false;
  return new Date(iso) > new Date(currentMember.end + 'T23:59:59');
}
function attendanceEntry(row){
  const time = formatActivityTime(row.time);
  if(expiredAt(row.time)){
    return { id: attTag(row), type:'expired', time: row.time,
             text: 'تم تسجيل حضورك الساعة ' + time + ' — اشتراكك منتهي، برجاء التجديد' };
  }
  return { id: attTag(row), type:'att', time: row.time,
           text: 'تم تسجيل حضورك في X GYM الساعة ' + time };
}

// حضور جديد لحظيًا (والتطبيق مفتوح)
function handleNewAttendance(row){
  if(!row) return;
  const entry = attendanceEntry(row);
  if(pushNotifLog(entry)){
    showToast((entry.type === 'expired' ? '⚠️ ' : '✅ ') + entry.text);
    renderNotifications();
  }
}

// حضور حصل والتطبيق مقفول → يظهر كإشعار أول ما العضو يفتح التطبيق
function catchUpAttendance(){
  const last = attendanceRows[0] ? attendanceRows[0].time : '';
  const prev = localStorage.getItem(notifCatchKey());
  if(prev === null){ if(last) localStorage.setItem(notifCatchKey(), last); return; } // أول مرة: من غير تراكم قديم
  attendanceRows.filter(a => a.time > prev).forEach(a => pushNotifLog(attendanceEntry(a)));
  if(last) localStorage.setItem(notifCatchKey(), last);
}

// تذكير يومي بالأيام المتبقية (مرة كل يوم عند فتح التطبيق)
function dailyReminderText(){
  const d = daysRemaining();
  if(d <= 0) return null;
  if(d === 1) return 'باقي يوم واحد فقط على انتهاء اشتراكك';
  return 'باقي ' + d + ' يوم على انتهاء اشتراكك';
}
function maybeShowDailyReminder(){
  if(computedStatus() !== 'active') return;
  if(localStorage.getItem(notifDailyKey()) === todayKey()) return;
  const text = dailyReminderText();
  if(!text) return;
  localStorage.setItem(notifDailyKey(), todayKey());
  pushNotifLog({ id:'daily-' + todayKey(), type:'daily', time:new Date().toISOString(), text });
  showToast('⏳ ' + text);
}

// ---- قائمة الإشعارات ----
const NOTIF_ICONS = { att:'fa-circle-check', daily:'fa-hourglass-half', expired:'fa-triangle-exclamation' };

function renderNotifications(){
  const list = document.getElementById('notif-list');
  if(!list || !currentMember) return;
  const items = [];

  // حالة الاشتراك الحالية دايمًا فوق
  const status = computedStatus();
  if(status === 'expired'){
    items.push(`<div class="notif-item"><i class="fas fa-circle-xmark" style="color:var(--red)"></i><div class="notif-text">اشتراكك منتهي — برجاء التجديد.</div></div>`);
  } else if(status === 'active' && dailyReminderText()){
    items.push(`<div class="notif-item"><i class="fas fa-hourglass-half"></i><div class="notif-text">${dailyReminderText()}</div></div>`);
  }

  const log = getNotifLog();
  log.forEach(n => {
    const color = n.type === 'expired' ? 'style="color:var(--red)"' : '';
    items.push(`<div class="notif-item"><i class="fas ${NOTIF_ICONS[n.type] || 'fa-bell'}" ${color}></i><div class="notif-text">${n.text}<br><span style="color:var(--text3);font-size:11px">${formatActivityDate(n.time)} · ${formatActivityTime(n.time)}</span></div></div>`);
  });

  if(!items.length) items.push(`<div class="empty-state" style="padding:26px 14px"><i class="fas fa-bell-slash"></i>لا توجد إشعارات</div>`);
  list.innerHTML = items.join('');

  // النقطة الحمراء: فيه إشعارات جديدة لم تُشاهد
  const seen = localStorage.getItem(notifSeenKey()) || '';
  const dot = document.getElementById('notif-dot');
  if(dot) dot.style.display = log.some(n => (n.time || '') > seen) ? 'block' : 'none';
}

function toggleNotifications(){
  const panel = document.getElementById('notif-panel');
  if(!panel) return;
  const open = panel.classList.toggle('show');
  if(open){
    localStorage.setItem(notifSeenKey(), new Date().toISOString());
    const dot = document.getElementById('notif-dot'); if(dot) dot.style.display = 'none';
  }
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notif-panel');
  if(panel && panel.classList.contains('show') && !e.target.closest('.notif-wrap')) panel.classList.remove('show');
});

function initNotifications(){
  try{
    catchUpAttendance();
    maybeShowDailyReminder();
    renderNotifications();
  }catch(e){ console.warn('initNotifications error', e); }
}

// ===================== أنظمة التدريب =====================
// البيانات في ملف training-data.js (TRAINING_SYSTEMS)
let _trSystem = null;   // null = قائمة الأنظمة، غير كده = index النظام المفتوح

function esc(t){
  return String(t == null ? '' : t).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function ytId(url){
  const m = (url||'').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}
function vimeoId(url){
  const m = (url||'').match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m ? m[1] : null;
}
function isFileVideo(url){ return /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i.test(url||''); }
function videoThumb(v){
  if(v.thumb) return v.thumb;
  const id = ytId(v.url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}
function trainingSystems(){
  return (typeof TRAINING_SYSTEMS !== 'undefined' && Array.isArray(TRAINING_SYSTEMS)) ? TRAINING_SYSTEMS : [];
}

function renderTraining(){
  const wrap = document.getElementById('training-panel');
  const titleEl = document.getElementById('training-title');
  if(!wrap) return;
  const systems = trainingSystems();

  // ---- قائمة الأنظمة ----
  if(_trSystem === null || !systems[_trSystem]){
    _trSystem = null;
    if(titleEl) titleEl.textContent = 'أنظمة التدريب';
    if(!systems.length){
      wrap.innerHTML = `<div class="empty-state"><i class="fas fa-dumbbell"></i>لا توجد أنظمة تدريب حتى الآن</div>`;
      return;
    }
    wrap.innerHTML = systems.map((s, i) => {
      const n = (s.videos || []).length;
      return `
      <div class="tr-card" onclick="openTrainingSystem(${i})">
        <div class="tr-card-ico"><i class="fas ${esc(s.icon || 'fa-dumbbell')}"></i></div>
        <div class="tr-card-info">
          <div class="tr-card-title">${esc(s.title)}</div>
          ${s.subtitle ? `<div class="tr-card-sub">${esc(s.subtitle)}</div>` : ''}
          <div class="tr-chips">
            ${s.level ? `<span class="tr-chip">${esc(s.level)}</span>` : ''}
            <span class="tr-chip tr-chip-dim"><i class="fas fa-circle-play"></i> ${n} فيديو</span>
          </div>
        </div>
        <div class="tr-card-arrow"><i class="fas fa-chevron-left"></i></div>
      </div>`;
    }).join('');
    return;
  }

  // ---- تفاصيل نظام + فيديوهاته ----
  const s = systems[_trSystem];
  const videos = s.videos || [];
  if(titleEl) titleEl.textContent = s.title;
  wrap.innerHTML = `
    ${s.description ? `<div class="tr-hero">${esc(s.description)}</div>` : ''}
    <div class="att-list-heading">الفيديوهات (${videos.length})</div>
    ${videos.length ? videos.map((v, j) => {
      const th = videoThumb(v);
      return `
      <div class="tr-video" onclick="playTrainingVideo(${_trSystem}, ${j})">
        <div class="tr-thumb"${th ? ` style="background-image:url('${esc(th)}')"` : ''}>
          <span class="tr-play"><i class="fas fa-play"></i></span>
          ${v.duration ? `<span class="tr-dur">${esc(v.duration)}</span>` : ''}
        </div>
        <div class="tr-vinfo">
          <div class="tr-vtitle">${esc(v.title || ('فيديو ' + (j + 1)))}</div>
          ${v.note ? `<div class="tr-vnote">${esc(v.note)}</div>` : ''}
        </div>
      </div>`;
    }).join('') : `<div class="empty-state"><i class="fas fa-video-slash"></i>لم تتم إضافة فيديوهات لهذا النظام بعد</div>`}
  `;
}

function openTrainingSystem(i){ _trSystem = i; renderTraining(); window.scrollTo(0, 0); }
function trainingBack(){
  if(_trSystem !== null){ _trSystem = null; renderTraining(); window.scrollTo(0, 0); }
  else if(typeof switchToMain === 'function') switchToMain('home');
}

function playTrainingVideo(si, vi){
  const v = ((trainingSystems()[si] || {}).videos || [])[vi];
  if(!v) return;
  if(!v.url){ showToast('الفيديو هيتضاف قريبًا'); return; }
  if(!navigator.onLine){ showToast('الفيديو محتاج اتصال بالإنترنت'); return; }
  const yt = ytId(v.url), vm = vimeoId(v.url);
  let html = '';
  if(yt){
    html = `<iframe src="https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&rel=0&playsinline=1&modestbranding=1" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  } else if(vm){
    html = `<iframe src="https://player.vimeo.com/video/${vm}?autoplay=1" allow="autoplay; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  } else if(isFileVideo(v.url)){
    html = `<video src="${esc(v.url)}" controls autoplay playsinline preload="metadata"></video>`;
  } else {
    window.open(v.url, '_blank', 'noopener');   // أي رابط تاني يتفتح في تاب جديد
    return;
  }
  document.getElementById('video-frame').innerHTML = html;
  document.getElementById('video-meta-title').textContent = v.title || '';
  document.getElementById('video-meta-note').textContent = v.note || '';
  document.getElementById('video-modal').classList.add('show');
}
function closeTrainingVideo(){
  document.getElementById('video-modal').classList.remove('show');
  document.getElementById('video-frame').innerHTML = '';   // يوقف الفيديو
}
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeTrainingVideo(); });

// ===================== بدء التشغيل =====================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-pin').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  document.getElementById('login-id').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('login-pin').focus(); });
  renderTraining();
  tryRestoreSession();
});

// تسجيل الـService Worker — يخزّن شكل التطبيق عشان يفتح فورًا من غير نت
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW register failed:', e));
  });
}

// ===================== تحميل التطبيق (PWA Install) =====================
let deferredInstallPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();               // امنع البانر التلقائي واستخدم الزرار بتاعنا
  deferredInstallPrompt = e;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const b = document.getElementById('install-btn');
  if (b) b.style.display = 'none';
  showToast('تم تثبيت التطبيق ✓');
});

function openInstallModal(){
  const steps = document.getElementById('install-steps');
  steps.innerHTML = isIOS()
    ? '<li>افتح الصفحة في <b>Safari</b></li><li>اضغط زرار المشاركة <b><i class="fas fa-arrow-up-from-bracket"></i></b> اللي تحت</li><li>اختار <b>إضافة إلى الشاشة الرئيسية</b></li><li>اضغط <b>إضافة</b></li>'
    : '<li>افتح قائمة المتصفح <b>⋮</b> (فوق)</li><li>اختار <b>تثبيت التطبيق</b> أو <b>إضافة إلى الشاشة الرئيسية</b></li><li>اضغط <b>تثبيت</b></li>';
  document.getElementById('install-modal').classList.add('show');
}
function closeInstallModal(){ document.getElementById('install-modal').classList.remove('show'); }

async function handleInstallClick(){
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') showToast('جاري تثبيت التطبيق...');
    deferredInstallPrompt = null;
  } else {
    openInstallModal();             // iPhone أو متصفح مفيهوش تثبيت مباشر
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('install-btn');
  if (!btn || isStandalone()) return;   // لو التطبيق مفتوح كتطبيق أصلًا، الزرار مايظهرش
  btn.style.display = 'flex';
  btn.addEventListener('click', handleInstallClick);
  document.getElementById('install-modal').addEventListener('click', (e) => { if (e.target.id === 'install-modal') closeInstallModal(); });
});