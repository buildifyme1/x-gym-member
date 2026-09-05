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

// ===================== تسجيل الدخول =====================
async function doLogin(){
  const idInput = document.getElementById('login-id').value.trim();
  const pin = normalizePhone(document.getElementById('login-pin').value.trim());
  const errBox = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  errBox.style.display = 'none';

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
  const { data } = await _sb.auth.getSession();
  if(data && data.session){
    currentUserId = data.session.user.id;
    await loadMemberData();
  }
}

function logout(){
  if(_attSub) _sb.removeChannel(_attSub);
  if(_memSub) _sb.removeChannel(_memSub);
  _sb.auth.signOut();
  currentMember = null; currentRowId = null; currentUserId = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-id').value = '';
  document.getElementById('login-pin').value = '';
}

// ===================== تحميل بيانات العضو =====================
async function loadMemberData(){
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('home-panel').innerHTML = '<div class="spinner"></div>';

  const { data: row, error } = await _sb
    .from('xgym_members')
    .select('id,data,photo_url,user_id')
    .eq('user_id', currentUserId)
    .single();

  if(error || !row){
    showToast('تعذر جلب بياناتك — حاول تسجيل الدخول مرة أخرى');
    logout();
    return;
  }

  currentRowId = row.id;
  currentMember = { ...row.data, photo_url: row.photo_url || row.data.photo_url || null };

  await Promise.all([ loadPrices(), loadAttendance() ]);
  renderHome();
  renderAttendance();
  renderBarcode();
  subscribeRealtime();
}

async function loadPrices(){
  const { data } = await _sb.from('xgym_prices').select('key,name');
  priceNames = {};
  (data||[]).forEach(p => priceNames[p.key] = p.name);
}

async function loadAttendance(){
  const { data } = await _sb
    .from('xgym_attendance')
    .select('*')
    .eq('member_id', currentRowId)
    .order('time', { ascending:false })
    .limit(200);
  attendanceRows = data || [];
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
        }
      })
    .subscribe();

  _attSub = _sb.channel('member-att-'+currentRowId)
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'xgym_attendance', filter:`member_id=eq.${currentRowId}` },
      () => { loadAttendance().then(renderAttendance); })
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

  document.getElementById('home-panel').innerHTML = `
    <div class="profile-card">
      <div class="photo-outer">
        <div class="profile-photo-wrap" id="photo-wrap">
          ${m.photo_url ? `<img src="${m.photo_url}">` : (m.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2)}
        </div>
        <label class="photo-upload-btn" for="photo-input"><i class="fas fa-camera"></i></label>
      </div>
      <input type="file" id="photo-input" accept="image/*" style="display:none" onchange="handlePhotoUpload(this)">
      <div class="profile-name">${m.name||''}</div>
      <div class="profile-id">${currentRowId} ${priceNames[m.type]?' · '+priceNames[m.type]:''}</div>
      <span class="status-pill status-${status}"><i class="fas ${STATUS_ICONS[status]}"></i> ${STATUS_LABELS[status]}</span>
      <div class="days-remaining">
        <div class="days-num">${status==='expired' ? 0 : dRem}</div>
        <div class="days-label">يوم متبقي في الاشتراك</div>
        <div class="progress-track"><div class="progress-fill" style="width:${status==='expired'?100:pct}%"></div></div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val">${totalAttendance}</div><div class="stat-label">إجمالي الحضور</div></div>
      <div class="stat-card"><div class="stat-val">${lastAtt ? formatDate(lastAtt.time) : '—'}</div><div class="stat-label">آخر حضور</div></div>
    </div>

    <div class="info-card">
      <div class="info-row"><span class="info-row-label"><i class="fas fa-id-card"></i>رقم العضوية</span><span class="info-row-val">${currentRowId}</span></div>
      <div class="info-row"><span class="info-row-label"><i class="fas fa-tag"></i>نوع الاشتراك</span><span class="info-row-val">${priceNames[m.type]||m.type||'—'}</span></div>
      <div class="info-row"><span class="info-row-label"><i class="fas fa-calendar-check"></i>بداية الاشتراك</span><span class="info-row-val">${m.start||'—'}</span></div>
      <div class="info-row"><span class="info-row-label"><i class="fas fa-calendar-xmark"></i>نهاية الاشتراك</span><span class="info-row-val">${m.end||'—'}</span></div>
    </div>
  `;
}

function formatDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('ar-EG', { day:'2-digit', month:'2-digit' }) + ' · ' + d.toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' });
}

// ===================== رفع صورة البروفايل =====================
async function handlePhotoUpload(input){
  const file = input.files[0];
  if(!file) return;
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
  if(!attendanceRows.length){
    wrap.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-xmark"></i>لا يوجد سجل حضور حتى الآن</div>`;
    return;
  }
  wrap.innerHTML = attendanceRows.map(a => `
    <div class="att-item">
      <div class="att-icon"><i class="fas fa-right-to-bracket"></i></div>
      <div>
        <div class="att-date">${new Date(a.time).toLocaleDateString('ar-EG',{weekday:'long',day:'2-digit',month:'2-digit'})}</div>
        <div class="att-time">${new Date(a.time).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'})}${a.session?' · '+a.session:''}</div>
      </div>
    </div>
  `).join('');
}

// ===================== الباركود =====================
function renderBarcode(){
  const code = currentMember.barcode || currentRowId;
  document.getElementById('bc-name').textContent = currentMember.name || '';
  document.getElementById('bc-sub').textContent = (priceNames[currentMember.type]||currentMember.type||'') + ' | ' + currentRowId;
  try{
    JsBarcode('#member-barcode-svg', code, {
      format:'CODE128', width:2.2, height:80, displayValue:true,
      font:'Arial', fontSize:13, margin:6, background:'#ffffff', lineColor:'#000000'
    });
  }catch(e){ console.warn('barcode render error', e); }
}

function getBarcodeDataURL(){
  return new Promise(resolve=>{
    const svg = document.getElementById('member-barcode-svg');
    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type:'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 560; canvas.height = 220;
    const ctx = canvas.getContext('2d');
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
      const bw = Math.min(440, img.width); const bh = img.height * (bw/img.width);
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

// ===================== بدء التشغيل =====================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-pin').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  document.getElementById('login-id').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('login-pin').focus(); });
  tryRestoreSession();
});
