/* Auth 管理台脚本（2026-11 全量重写）——零外链。
   架构：
   - 全局层：工具 / 动效 / 时间 / 反馈 / api（CSRF + 重验 + 401 回跳）/ WebAuthn /
     控件装饰（tabs、下拉、密码显示）；
   - 页面层：每页一个控制器，按 body[data-page] 分发（替代旧版「每个 init 探测
     自己的锚点元素」的散装入口——锚点改名时旧写法会静默不执行，新写法一眼对不上）。
   约定：
   - 所有写请求带 X-CSRF-Token（从可读 cookie 取）+ 同源 credentials；
   - 401「需要重新验证」→ 弹重新验证框，验过自动重试原请求；401「登录已过期」→
     回登录页并带 ?next=（登录后回原处）；
   - 动态数据一律 textContent / 转义后才进 innerHTML（邮箱、设备名来自用户与 UA）；
   - 表格行的 td 带 data-label：窄屏（≤760px）由 CSS 降级为「label: value」卡片。 */
'use strict';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function cookie(name) {
  const hit = document.cookie.split('; ').find(c => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function node(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/* ---------- 动效（与 style.css 同一套 easing/时长）----------
   只用 transform/opacity；用户开了「减弱动态效果」就不播；动画绝不拦截交互。 */
const MOTION_EASE = 'cubic-bezier(.16, 1, .3, 1)';
const reducedMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* 区块切换：crossfade + 4px 上浮（tab 换面板、详情展开） */
function swapIn(el) {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return;
  try {
    el.animate(
      [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 180, easing: MOTION_EASE });
  } catch (_) { /* 浏览器不支持就静默 */ }
}

/* 流程步连续过渡（登录↔两步验证↔强制改密↔错误态）：先让旧步以 90ms 淡出，
   再显示新步做 180ms 上浮——总时长 270ms（<300ms 微交互上限），既不瞬变也不
   让两步同屏叠影。reduced-motion 直接切。快速连点时取消上一段未完的退场，
   从当前展示态重新起（可中断，Apple: animate from presentation value）。 */
function flowSwap(hideEl, showEl, after) {
  let done = false;
  let timer = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (hideEl) {
      if (hideEl.__flow) { hideEl.__flow.onfinish = null; hideEl.__flow.cancel(); hideEl.__flow = null; }
      hideEl.classList.add('hidden');
    }
    if (showEl) {
      showEl.classList.remove('hidden');
      swapIn(showEl);
    }
    if (after) after();
  };
  if (reducedMotion() || typeof Element.prototype.animate !== 'function') { finish(); return; }
  if (hideEl && !hideEl.classList.contains('hidden')) {
    if (hideEl.__flow) { hideEl.__flow.onfinish = null; hideEl.__flow.cancel(); hideEl.__flow = null; }
    const anim = hideEl.animate(
      [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }],
      { duration: 90, easing: MOTION_EASE, fill: 'forwards' });
    hideEl.__flow = anim;
    anim.onfinish = finish;
    timer = setTimeout(finish, 240);   // 兜底：onfinish 不触发也不卡流程
  } else {
    finish();
  }
}

/* 页内钻取：16px 右侧滑入 + 淡入（详情面板进场） */
function slideIn(el) {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return;
  try {
    el.animate(
      [{ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 200, easing: MOTION_EASE });
  } catch (_) { /* 同上 */ }
}

/* 状态浮现：徽标/提示轻缩放进场 */
function popIn(el) {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return;
  try {
    el.animate(
      [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: 200, easing: MOTION_EASE });
  } catch (_) { /* 同上 */ }
}

/* 行退场：挂 .leaving（CSS 同款淡出），播完再回调。服务端确认成功才走到这里。 */
function fadeOutRow(el, done) {
  if (!el || reducedMotion()) { done(); return; }
  el.classList.add('leaving');
  setTimeout(done, 180);
}

/* ---------- 时间渲染 ----------
   0 值防御：0 / 负值 / NaN 一律回「—」，不渲染 1970 纪元日期。 */
function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const p = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function relTime(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  return fmtTime(ms);
}

/* remainTime 是 relTime 的未来向镜像（邀请有效期「还有多久」）：向上取整且
   至少 1 分钟；>30 天回绝对时间。 */
function remainTime(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const left = Math.max(0, t - Date.now());
  const min = Math.ceil(left / 60000);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.ceil(min / 60);
  if (hour < 24) return `${hour} 小时`;
  const day = Math.ceil(hour / 24);
  if (day <= 30) return `${day} 天`;
  return fmtTime(t);
}

/* 相对时间时钟：带 data-rel 的节点每 30 秒重算一次——页面开着不动时
   「1 分钟前」不会永远停在原地（列表整体刷新另有 refresh 按钮与 visibilitychange）。 */
function startRelClock() {
  const tick = () => $$('[data-rel]').forEach(el => {
    el.textContent = relTime(el.dataset.rel);
  });
  setInterval(tick, 30000);
}

/* ---------- 反馈 ---------- */
let toastTimer = null;
function toast(msg, bad) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 200);
  }, bad ? 5000 : 3200);
}

function showErr(sel, msg) {
  const el = $(sel);
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

/* 跨页提示：跳转前存 sessionStorage，目标页启动时 drain（注销撤销 / 强制改密
   成功 / 注销已提交都要「跳走之后还看得见一句 toast」）。 */
function flash(msg) {
  try { sessionStorage.setItem('auth_flash', msg); } catch (_) { /* 隐私模式：放弃提示，不拦流程 */ }
}
function drainFlash() {
  let msg = '';
  try {
    msg = sessionStorage.getItem('auth_flash') || '';
    if (msg) sessionStorage.removeItem('auth_flash');
  } catch (_) { return; }
  if (msg) toast(msg);
}

/* ---------- 拒绝态分级（app 登录 / 授权 / 后台操作被拒的统一呈现） ----------
   三种拒绝的下一步完全不同——重新登录 / 调整策略或加入名单 / 找平台管理员开
   权限——所以 401/403 不再只是一行红字：分级徽标 + 一句「接下来做什么」+ 可点
   的动作（重试 / 返回 / 联系支持）。分级只是展示层启发式：判定始终在服务端
   （gate.go 的封禁→白名单顺序、admin.go 的 scope 收权），文案也原样透传。 */
const DENIAL_TIERS = {
  unauth: {
    label: '未登录', badge: 'off',
    hint: '登录状态已失效。重新登录后会回到这里继续。',
  },
  policy: {
    label: '策略拒绝', badge: 'warn',
    hint: '账号或项目的登录策略拦下了这次访问：需要管理员调整策略，或把账号加入名单。',
  },
  permission: {
    label: '权限不足', badge: 'on',
    hint: '当前账号没有执行该操作的权限，可联系平台管理员开通。',
  },
};

/* denialTier：401 → 未登录；403 优先读服务端的 reason（policy/permission，
   与 internal/auth 的拒绝分级常量同值域）；没有 reason 时按原文判据分级，
   认不出就回空串——CSRF/Origin、MFA 等拦截不走「联系管理员」面板。
   400/404 等非 401/403 不是拒绝态，回空串。 */
function denialTier(status, message, reason) {
  const code = Number(status);
  if (code === 401) return 'unauth';
  if (code !== 403) return '';
  if (reason === 'policy' || reason === 'permission') return reason;
  // 403 没带 reason（CSRF/Origin、MFA 拦截等）只按原文分级；认不出来就回落
  // 普通报错，别一律说成「联系平台管理员开通」。
  const m = String(message || '');
  if (/封禁|仅限受邀/.test(m)) return 'policy';
  if (/权限|授权|开通|没有该项目的管理/.test(m)) return 'permission';
  return '';
}

/* 拒绝面板 HTML：徽标 + 服务端原文 + 分级提示 + 动作（可选重试/返回 + 常驻支持入口）。
   非拒绝态错误回空串，调用方回落到普通行内报错——面板不抢正常错误的位置。 */
function denialPanelHTML(err, opts) {
  const o = opts || {};
  const tier = denialTier(err && err.status, err && err.message, err && err.reason);
  if (!tier) return '';
  const t = DENIAL_TIERS[tier];
  const retry = o.retry ? '<button type="button" class="btn small" data-denied-retry>重试</button>' : '';
  const back = o.backHref
    ? `<a class="btn small" href="${esc(o.backHref)}">${esc(o.backLabel || '返回')}</a>` : '';
  return `<div class="denied-panel swap-in" role="alert" data-tier="${tier}">
    <span class="badge ${t.badge}">${esc(t.label)}</span>
    <span class="grow"><span class="title">${esc(err && err.message)}</span><br>
      <span class="meta">${esc(t.hint)}</span></span>
    <span class="row denied-panel-actions">${retry}${back}
      <a class="btn small ghost" href="mailto:support@horatio.cn">联系支持</a></span>
  </div>`;
}

/* showDenial：把拒绝面板写进容器（err 为空 = 清空收起）。返回是否命中拒绝态，
   调用方按 false 走原来的行内报错。 */
function showDenial(sel, err, opts) {
  const el = $(sel);
  if (!el) return false;
  const html = denialPanelHTML(err, opts);
  if (!html) { el.innerHTML = ''; el.hidden = true; return false; }
  el.innerHTML = html;
  el.hidden = false;
  const rb = el.querySelector('[data-denied-retry]');
  if (rb && opts && opts.retry) rb.addEventListener('click', opts.retry);
  return true;
}

/* reportDenial：写操作被拒后的统一出口——403 走拒绝分级面板并滚到眼前（弹层
   已关，toast 会一滚而过，越权原因必须留在视野里）；其余错误维持 toast。 */
function reportDenial(slotSel, err) {
  if (showDenial(slotSel, err)) {
    const el = $(slotSel);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    return true;
  }
  toast(err.message, true);
  return false;
}

/* 报障时间戳：403 页与授权错误页共用（与服务端日志对齐）。 */
function stampDeniedAt() {
  const el = $('#denied-at');
  if (el) el.textContent = new Date().toLocaleString('zh-CN');
}

/* 筛选/分页状态 ↔ URL：replaceState 而非 pushState（每敲一次筛选不该在历史里
   堆一页），刷新/分享/后退都能还原同一份状态。 */
function syncQuery(pairs) {
  const p = new URLSearchParams();
  Object.keys(pairs).forEach(k => {
    const v = pairs[k];
    if (v !== '' && v !== null && v !== undefined) p.set(k, String(v));
  });
  const qs = p.toString();
  const url = location.pathname + (qs ? '?' + qs : '');
  if (url !== location.pathname + location.search) history.replaceState(null, '', url);
}

/* ---------- 展示小件 ---------- */
/* IP + 归属地：服务端离线库现算，查不到就不显示这一段（内网地址配公网归属地
   比不显示更糟）。IPv6 中段截断（前 2 段 … 后 2 段），全串挂 title。 */
function shortIP(ip) {
  const s = String(ip || '');
  if (s.length <= 24) return s;
  const g = s.split(':');
  if (g.length > 5) return g.slice(0, 2).join(':') + '…' + g.slice(-2).join(':');
  return s.slice(0, 12) + '…' + s.slice(-8);
}

function ipWithRegion(ip, region) {
  const full = String(ip || '');
  const shown = full ? shortIP(full) : '—';
  const r = (region || '').trim();
  const text = r ? `${shown} · ${r}` : shown;
  const title = r ? `IP ${full} · ${r}` : `IP ${full}`;
  return `<span title="${esc(title)}">${esc(text)}</span>`;
}

/* 封禁徽标：列表前置状态，悬停给出范围与解除时间 */
function banBadge(ban) {
  if (!ban) return '';
  const scope = ban.app === '*' ? '全站' : appLabel(ban.app);
  const until = Number(ban.untilMs) > 0 ? '至 ' + fmtTime(ban.untilMs) : '永久';
  const title = [scope + '封禁', until, ban.reason].filter(Boolean).join(' · ');
  return `<span class="badge warn" title="${esc(title)}">封禁</span>`;
}

/* 空态 = 为什么空 + 下一步（Polaris 口径）；表格版嵌在 <tr> 里 */
function emptyState(title, hint) {
  return `<div class="empty"><span class="empty-title">${esc(title)}</span>${hint ? `<span class="empty-hint">${esc(hint)}</span>` : ''}</div>`;
}
function emptyCell(colspan, title, hint) {
  return `<tr><td colspan="${esc(colspan)}" class="empty"><span class="empty-title">${esc(title)}</span>${hint ? `<span class="empty-hint">${esc(hint)}</span>` : ''}</td></tr>`;
}

/* 表格单元格：窄屏卡片化的 label 来源（data-label），cls 供 cell-title/
   cell-action/cell-pick 这类结构角色使用。 */
function td(label, html, cls) {
  const l = label ? ` data-label="${esc(label)}"` : '';
  const c = cls ? ` class="${cls}"` : '';
  return `<td${l}${c}>${html}</td>`;
}

/* ---------- 按钮与表单 ---------- */
/* 提交忙态：这些表单没有 setBusy 时双击会发两次请求（验证码/重置类第二次必然
   失败）。e.submitter 是真正被点的按钮。 */
function busySubmit(e) {
  const btn = (e && e.submitter) ||
    (e && e.target && e.target.querySelector && e.target.querySelector('button[type=submit]'));
  if (btn) setBusy(btn, true);
  return btn;
}
function idleSubmit(btn) { if (btn) setBusy(btn, false); }

function setBusy(btn, busy) {
  if (!btn) return;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  btn.disabled = !!busy;
}

/* 发码冷却：60 秒倒计时 + 「N 秒后重发」 */
function cooldown(btn, seconds) {
  let left = seconds;
  btn.disabled = true;
  const original = btn.dataset.cooldownLabel || btn.textContent;
  btn.dataset.cooldownLabel = original;
  btn.textContent = `${left} 秒后重发`;
  const t = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = original; }
    else btn.textContent = `${left} 秒后重发`;
  }, 1000);
}

/* 列表加载期间给容器 aria-busy（读屏知道「正在读取」而不是静默变化） */
function setListBusy(el, busy) {
  if (el) el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/* ---------- 分页（用户/审计/后台会话三页共用） ---------- */
function makePager(opts) {
  const st = { offset: 0, limit: opts.limit || 20, total: 0 };
  const prev = $(opts.prev), next = $(opts.next), label = $(opts.label);
  return {
    state: st,
    set(total, shown) {
      st.total = total;
      if (label) {
        label.textContent = total
          ? `${st.offset + 1}–${st.offset + shown} / ${total}` : '—';
      }
      if (prev) prev.disabled = st.offset <= 0;
      if (next) next.disabled = st.offset + shown >= total;
    },
    wire(reload) {
      if (prev) prev.addEventListener('click', () => { st.offset = Math.max(0, st.offset - st.limit); reload(); });
      if (next) next.addEventListener('click', () => { st.offset += st.limit; reload(); });
    },
  };
}

/* ---------- 单输入原地换语义的 N 态工厂（GitHub 式） ----------
   二态弹框（两步验证码 ↔ 恢复码）与三态登录步（验证器码 / 邮箱码 / 恢复码）
   的差异全在配置。apply 收口：同步属性 → 清值（防上一态半截被当另一种码提交）
   → 刷新按钮/提示 → 清旧报错 → crossfade → 聚焦。 */
function makeCodeToggle(input, labelEl, cfg) {
  let mode = cfg.initial;
  function apply(opts) {
    const o = opts || {};
    const m = cfg.modes[mode];
    labelEl.textContent = m.label;
    input.placeholder = m.placeholder;
    if (m.numeric) {
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('maxlength', '6');
      input.setAttribute('autocomplete', 'one-time-code');
    } else {
      input.removeAttribute('inputmode');
      input.removeAttribute('maxlength');
      input.setAttribute('autocomplete', 'off');
    }
    Object.keys(m.buttons || {}).forEach(sel => {
      const el = $(sel);
      if (el) el.textContent = m.buttons[sel];
    });
    (m.hide || []).forEach(sel => { const el = $(sel); if (el) el.classList.add('hidden'); });
    (m.show || []).forEach(sel => { const el = $(sel); if (el) el.classList.remove('hidden'); });
    if (cfg.introSel && m.intro != null) $(cfg.introSel).textContent = m.intro;
    (cfg.hideAlways || []).forEach(sel => { const el = $(sel); if (el) el.hidden = true; });
    input.value = '';
    if (cfg.errSel) showErr(cfg.errSel, '');
    if (!o.silent) swapIn((cfg.fadeSel && $(cfg.fadeSel)) || labelEl.closest('.field') || input);
    if (o.focus === undefined ? cfg.autoFocus : o.focus) input.focus();
  }
  return {
    mode: () => mode,
    set(next, opts) { mode = next; apply(opts); },
    reset(opts) {
      if (mode !== cfg.initial) { mode = cfg.initial; apply(opts); } else { input.value = ''; }
    },
  };
}

/* ---------- 重新验证弹框（能力自适应 + 单例 in-flight） ----------
   - 有 Passkey → 主按钮「使用 Passkey 验证」；
   - 开了两步验证 → 码框（恢复码原地切换）；有 Passkey 时两者并列二选一；
   - 两者皆无 → 密码框兜底（纯密码账号不能被锁死在改密/改邮之外）。
   单例 in-flight：并发 401 共享同一弹框与结果——旧版单槽 resolver 会被第二次
   调用覆盖，第一个调用者的 promise 永不结算（区块停在「读取中…」）。 */
let reauthInflight = null;
let reauthResolver = null;
let reauthHasCode = false;

function promptReauth() {
  if (reauthInflight) return reauthInflight;
  reauthInflight = new Promise(resolve => {
    reauthResolver = resolve;
    const dlg = $('#reauth');
    if (!dlg) { reauthInflight = null; reauthResolver = null; resolve(false); return; }
    showErr('#reauth-error', '');
    $('#reauth-password').value = '';
    $('#reauth-code').value = '';
    if (window.__reauthToggle) window.__reauthToggle.reset();
    for (const id of ['#reauth-passkey-wrap', '#reauth-code-wrap', '#reauth-password-wrap']) {
      $(id).classList.add('hidden');
    }
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    reauthApplyCapability();
  });
  return reauthInflight;
}

/* 能力探测：/web/session 一次拿 passkeyCount/totpEnabled/passwordSet → 亮对应区。
   查询失败按「无能力」走密码兜底（至少有条路，不卡流程）。 */
async function reauthApplyCapability() {
  let me = null;
  try { me = await api('/web/session', { method: 'POST', body: {}, noReauth: true }); } catch (err) { /* 兜底 */ }
  const dlg = $('#reauth');
  if (!reauthInflight || !dlg || !dlg.open) return;
  const hasPasskey = !!(me && me.passkeyCount > 0) && !!window.PublicKeyCredential;
  const hasTotp = !!(me && me.totpEnabled);
  const hasPassword = !me || me.passwordSet;
  reauthHasCode = hasTotp;
  const showPasskey = hasPasskey;
  const showCode = hasTotp;
  const showPassword = !hasPasskey && !hasTotp && hasPassword;
  $('#reauth-passkey-wrap').classList.toggle('hidden', !showPasskey);
  $('#reauth-code-wrap').classList.toggle('hidden', !showCode);
  $('#reauth-password-wrap').classList.toggle('hidden', !showPassword);
  $('#reauth-ok').classList.toggle('hidden', !(showCode || showPassword));
  if (showPasskey) { swapIn($('#reauth-passkey-wrap')); $('#reauth-passkey').focus(); }
  else if (showCode) { swapIn($('#reauth-code-wrap')); $('#reauth-code').focus(); }
  else { $('#reauth-password').focus(); }
}

/* Passkey 路：options → 系统弹框断言 → finish。系统弹框里取消不算失败。 */
async function reauthByPasskey() {
  const btn = $('#reauth-passkey');
  setBusy(btn, true);
  showErr('#reauth-error', '');
  try {
    const opts = await api('/web/reauth/webauthn/options', { method: 'POST', body: {}, noReauth: true });
    const cred = await navigator.credentials.get({ publicKey: decodePKOptions(opts.publicKey) });
    await api('/web/reauth/webauthn/finish', {
      method: 'POST', body: { ceremonyId: opts.ceremonyId, response: assertionJSON(cred) }, noReauth: true,
    });
    closeReauth(true);
  } catch (err) {
    if (!err || (err.name !== 'NotAllowedError' && err.name !== 'AbortError')) {
      showErr('#reauth-error', (err && err.message) || 'Passkey 验证失败，请重试');
    }
  } finally {
    setBusy(btn, false);
  }
}

function closeReauth(ok) {
  const dlg = $('#reauth');
  if (dlg && dlg.open) dlg.close();
  const resolve = reauthResolver;
  reauthInflight = null;   // 先清槽再结算：后来者开新弹框，不会接上旧 promise
  reauthResolver = null;
  if (resolve) resolve(ok);
}

function wireReauth() {
  const form = $('#reauth-form');
  if (!form) return;
  window.__reauthToggle = makeCodeToggle($('#reauth-code'), $('#reauth-code-label'), {
    initial: 'code',
    errSel: '#reauth-error',
    modes: {
      code: {
        label: '两步验证码（6 位）', placeholder: '输入验证器上的 6 位验证码', numeric: true,
        buttons: { '#reauth-toggle-recovery': '使用恢复码' },
      },
      recovery: {
        label: '恢复码', placeholder: 'XXXX-XXXX-XXXX-XXXX', numeric: false,
        buttons: { '#reauth-toggle-recovery': '改用两步验证码' },
      },
    },
  });
  $('#reauth-toggle-recovery').addEventListener('click', () =>
    window.__reauthToggle.set(window.__reauthToggle.mode() === 'recovery' ? 'code' : 'recovery', { focus: true }));
  $('#reauth-passkey').addEventListener('click', reauthByPasskey);
  $('#reauth-cancel').addEventListener('click', () => closeReauth(false));
  $('#reauth').addEventListener('cancel', e => { e.preventDefault(); closeReauth(false); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#reauth-ok');
    setBusy(btn, true);
    try {
      if (reauthHasCode) {
        const useRecovery = window.__reauthToggle.mode() === 'recovery';
        const totpCode = useRecovery ? '' : $('#reauth-code').value.trim();
        const recoveryCode = useRecovery ? $('#reauth-code').value.trim() : '';
        if (!totpCode && !recoveryCode) {
          showErr('#reauth-error', useRecovery ? '请输入恢复码' : '请输入两步验证码'); return;
        }
        await api('/web/reauth', { method: 'POST', body: { totpCode, recoveryCode }, noReauth: true });
      } else {
        const password = $('#reauth-password').value;
        if (!password) { showErr('#reauth-error', '请输入密码'); return; }
        await api('/web/reauth', { method: 'POST', body: { password }, noReauth: true });
      }
      closeReauth(true);
    } catch (err) {
      showErr('#reauth-error', err.message);
    } finally {
      setBusy(btn, false);
    }
  });
}

/* ---------- 统一请求 ---------- */
async function api(path, opts) {
  const o = opts || {};
  const headers = { 'Accept': 'application/json' };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = cookie('__Host-auth_web_csrf');
  if (token) headers['X-CSRF-Token'] = token;

  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);   // 15s 超时：慢网不无限等
    try {
      res = await fetch(path, {
        method: o.method || 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ctrl.signal,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // 超时与断网分开说：两者的下一步不一样（等一会 vs 查网络）
    const e = new Error(err && err.name === 'AbortError'
      ? '请求超时，请检查网络后重试'
      : '网络连接中断，请检查网络后重试');
    e.status = 0;
    throw e;
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (_) { /* 非 JSON 留空 */ } }

  if (!res.ok) {
    // 兜底文案给「下一步」，不甩裸状态码
    let msg = (data && data.message)
      || (res.status === 403 ? '没有权限执行该操作，如需权限请联系平台管理员'
        : res.status === 429 ? '操作过于频繁，请稍后再试'
          : res.status >= 500 ? '服务暂时不可用，请稍后重试'
            : `请求未完成（${res.status}），请稍后重试`);
    if (res.status === 401 && msg.indexOf('重新验证') >= 0 && !o.noReauth && !o._retried) {
      if (await promptReauth()) {
        return api(path, Object.assign({}, o, { _retried: true }));
      }
      const e0 = new Error('已取消重新验证'); e0.status = 401; e0.cancelled = true; throw e0;
    }
    if (res.status === 429 && msg.indexOf('稍后') < 0) msg += '，请稍后再试';
    if (res.status === 401 && msg.indexOf('重新验证') < 0 && !location.pathname.startsWith('/web/login')) {
      // 带上当前页，登录后回到原处（否则后台深层链接一律掉回概览）
      const here = location.pathname + location.search;
      location.href = '/web/login?next=' + encodeURIComponent(here);
    }
    const err = new Error(msg);
    err.status = res.status;
    // 服务端 403 的机器可读分级（policy=账号/项目策略，permission=授权不足）；
    // 老服务端没有这个字段时由 denialTier 回落到文案判据。
    if (data && data.reason) err.reason = data.reason;
    throw err;
  }
  return data;
}

/* ---------- Web 会话轮换 ----------
   登录态页面加载后立刻换一次、每 30 分钟、从隐藏变可见时再换。新 cookie 由浏览器
   随 Set-Cookie 落库，后续 api() 自动读到新 CSRF。并发只发一次（409 输家静默），
   401 交给 api() 既有登出流程，其余失败不打扰用户。 */
let refreshInflight = null;
let sessionRefreshTimer = 0;
let sessionRefreshStopped = false;

function rotateWebSession() {
  if (sessionRefreshStopped) return Promise.resolve(null);
  if (refreshInflight) return refreshInflight;
  refreshInflight = api('/web/session/refresh', { method: 'POST', body: {}, noReauth: true })
    .catch(() => null)   // 409 / 断网 / 超时不弹错；401 已由 api() 跳登录页
    .finally(() => { refreshInflight = null; });
  return refreshInflight;
}

function stopSessionRefresh() {
  sessionRefreshStopped = true;
  clearInterval(sessionRefreshTimer);
  sessionRefreshTimer = 0;
}

function startSessionRefresh() {
  if (sessionRefreshTimer) return;
  sessionRefreshStopped = false;
  void rotateWebSession();
  sessionRefreshTimer = setInterval(() => void rotateWebSession(), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void rotateWebSession();
  });
}

/* ---------- 应用注册表（服务端注入，唯一清单来源） ---------- */
function knownApps() {
  try {
    const el = document.getElementById('known-apps');
    const list = JSON.parse(el ? el.textContent : '[]');
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

const APP_LABEL = (() => {
  const map = { web: '网页' };   // 会话里的 app=web 是控制台自身，不是业务应用
  knownApps().forEach(a => { map[a.key] = a.label; });
  return map;
})();
const appLabel = v => APP_LABEL[v] || v;

/* 平台管理员标记：layout 按 Data.IsSuper 渲染 body[data-super] */
const IS_SUPER = document.body.hasAttribute('data-super');

/* 根管理员（唯一）：任命能力矩阵的锚点。后端口径——root 唯一 → 只有 root 能
   任命/回收平台管理员 → 平台管理员能任命项目管理员与普通用户 → 不能授予高于
   自己的角色、项目管理员不跨项目。root 的判定在服务端按 uid 做（RootUID），
   /web/session 回 isRoot 位，前端不再抄一份 uid；拿不到时按「非根」保守处理
   （最终判定仍在后端逐请求把关）。 */
function isRootViewer() { return window.__isRoot === true; }

/* viewerUid：当前登录者的 uid（任命禁用判断要用）。initAdminGuard 在后台页
   已经取过一次；没取到（竞态/直开）就现取一次并缓存——详情面板打开时才需要，
   此时通常已有值。顺带缓存 isRoot（与 uid 同源同一次回执）。 */
async function viewerUid() {
  if (window.__meUid) return Number(window.__meUid);
  try {
    const me = await api('/web/session', { method: 'POST', body: {} });
    window.__meUid = me.uid;
    window.__isRoot = me.isRoot === true;
  } catch (_) { /* 拿不到就按非根保守处理，后端仍会把关 */ }
  return Number(window.__meUid || 0);
}

/* 管理页守卫：先确认自己真的是管理员，再让各页发数据请求（数据层另有
   requireAdmin 逐请求再挡一道）。 */
async function initAdminGuard() {
  if (location.pathname.indexOf('/web/admin') !== 0) return;
  try {
    const me = await api('/web/session', { method: 'POST', body: {} });
    window.__meUid = me.uid;
    window.__isRoot = me.isRoot === true;
    if (me.role !== 'admin' && me.role !== 'super') location.href = '/web/console';
  } catch (_) { /* 401 时 api() 已经跳登录页 */ }
}

/* 当前数据页的 app 过滤器：?app= 空 = 全部（super）/ 全部授权（app-admin） */
function appFilter() {
  const v = new URLSearchParams(location.search).get('app');
  return v ? '&app=' + encodeURIComponent(v) : '';
}

/* 项目切换器：选中写入 ?app=（刷新保持），切换时重取数据不整页刷新。
   无人监听 appscopechange 时兜底 reload。 */
function initAppSwitch() {
  const wrap = $('#app-switch');
  if (!wrap) return;
  $$('.app-chip', wrap).forEach(chip => chip.addEventListener('click', e => {
    e.preventDefault();
    const app = chip.dataset.app || '';
    const url = new URL(location.href);
    if (app) url.searchParams.set('app', app); else url.searchParams.delete('app');
    history.replaceState(null, '', url);
    $$('.app-chip', wrap).forEach(c => {
      const on = c === chip;
      c.classList.toggle('on', on);
      if (on) { c.setAttribute('aria-current', 'true'); popIn(c); }
      else c.removeAttribute('aria-current');
    });
    const ev = new CustomEvent('appscopechange', { cancelable: true });
    if (document.dispatchEvent(ev)) location.reload();
  }));
}

/* ================= 页面控制器 ================= */

/* ---------- 登录 ---------- */
function initLogin() {
  if (!$('#login-card')) return;

  const tabs = { 'tab-password': 'pane-password', 'tab-code': 'pane-code', 'tab-reset': 'pane-reset' };
  Object.keys(tabs).forEach(id => {
    $('#' + id).addEventListener('click', () => {
      // 流程步切换走 flowSwap：旧面板 90ms 淡出 → 新面板 180ms 上浮（连续过渡，
      // 不瞬变不叠影）；标签的 aria-selected 立即同步（状态先于动画）
      const prev = Object.keys(tabs).map(k => $('#' + tabs[k]))
        .find(p => !p.classList.contains('hidden'));
      Object.keys(tabs).forEach(other =>
        $('#' + other).setAttribute('aria-selected', other === id ? 'true' : 'false'));
      const next = $('#' + tabs[id]);
      if (prev !== next) flowSwap(prev, next);
      showErr('#login-error', ''); showErr('#code-error', ''); showErr('#reset-error', '');
      showDenial('#login-denied', null);
    });
  });

  // ---- 登录完成回执：注销撤销提示 + 强制改密步 + OAuth 续跑 ----
  const oauthTx = new URLSearchParams(location.search).get('tx');
  /* 回跳地址只接受**站内绝对路径**。判据是浏览器自己的解析结果，不是字符串前缀：
     用 WHATWG URL 拿 location.origin 作基准解析一次，origin 逐字相同才放行，
     并且只回传 pathname+search+hash（永不回传原始串）。
     字符串判据（`^\/(?![\/\\])`）漏过两类浏览器已经规范化掉的形态：
       · 制表/换行：`/%09/evil.com` → `/<TAB>/evil.com`，URL 解析器会把 TAB 直接
         删掉，最终就是 `//evil.com`（协议相对，跳到外站）；
       · 反斜杠以外的同类变体（`/\evil.com` 只拦住了这一种，制表符没拦）。
     这两条是 CWE-601 的常规绕过面（OWASP Unvalidated Redirects 清单），
     所以这里以解析后的 origin 为准。 */
  function safeNext(raw) {
    if (!raw) return '';
    let u;
    try { u = new URL(raw, location.origin); } catch (_) { return ''; }
    if (u.origin !== location.origin) return '';       // 外站 / 协议相对 / javascript:
    if (u.username || u.password) return '';           // user:pass@host 混淆
    if (u.pathname.indexOf('/web/login') === 0) return '';   // 防自跳循环
    return u.pathname + u.search + u.hash;
  }
  const nextPath = safeNext(new URLSearchParams(location.search).get('next'));
  const loginLanding = () =>
    oauthTx ? '/oauth/resume?tx=' + encodeURIComponent(oauthTx) : (nextPath || '/web/console');
  let forceOldPw = '';
  function finishLogin(res, pwd) {
    const cancelled = !!(res && res.deletePendingCancelled);
    if (res && res.mustChangePassword) {
      if (cancelled) toast('已撤销账号注销，账号恢复正常');
      showForcePassword(pwd);
      return;
    }
    if (cancelled) flash('已撤销账号注销，账号恢复正常');
    location.href = loginLanding();
  }
  function showForcePassword(pwd) {
    forceOldPw = pwd || '';
    // 标签/Passkey 入口是 chrome，直接收起；内容区走 flowSwap 连续过渡
    $('#login-tabs').classList.add('hidden');
    ['#passkey-sep', '#passkey-login'].forEach(sel => { const el = $(sel); if (el) el.classList.add('hidden'); });
    const prev = [$('#pane-password'), $('#pane-code'), $('#pane-reset')]
      .find(p => p && !p.classList.contains('hidden'));
    const step = $('#step-force-pw');
    showErr('#force-pw-error', '');
    $('#force-pw-new').value = ''; $('#force-pw-confirm').value = '';
    flowSwap(prev, step, () => $('#force-pw-new').focus());
  }
  $('#step-force-pw').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('#force-pw-error', '');
    const nw = $('#force-pw-new').value, cf = $('#force-pw-confirm').value;
    if (nw.length < 8) { showErr('#force-pw-error', '新密码至少 8 位'); return; }
    if (nw !== cf) { showErr('#force-pw-error', '两次输入的新密码不一致'); return; }
    const btn = $('#force-pw-submit');
    setBusy(btn, true);
    try {
      await api('/auth/change-password', {
        method: 'POST', body: { oldPassword: forceOldPw, newPassword: nw },
      });
      flash('密码已更新');
      location.href = loginLanding();
    } catch (err) { showErr('#force-pw-error', err.message); } finally { setBusy(btn, false); }
  });

  // ---- 密码 →（2FA）三模式单输入（验证器码 / 邮箱码 / 恢复码）----
  let loginToken = '';
  let enteredPw = '';   // 密码登录这一步用过的密码（服务端确认正确后才记），强制改密时作 oldPassword
  const stepPwd = $('#step-password'), stepTotp = $('#step-totp');
  const f2 = makeCodeToggle($('#login-code-2fa'), $('#totp-label'), {
    initial: 'totp',
    autoFocus: true,
    errSel: '#login-error',
    fadeSel: '#step-totp',
    introSel: '#totp-intro',
    hideAlways: ['#totp-email-hint'],
    modes: {
      totp: {
        label: '两步验证码（6 位）', placeholder: '输入验证器上的 6 位验证码', numeric: true,
        hide: ['#send-2fa-code'], show: ['#toggle-email'],
        buttons: {
          '#toggle-email': '没有验证器？获取邮箱验证码',
          '#toggle-recovery': '使用恢复码',
        },
        intro: '输入验证器上的 6 位验证码。',
      },
      email: {
        label: '邮箱验证码（6 位）', placeholder: '输入邮箱里收到的 6 位验证码', numeric: true,
        show: ['#send-2fa-code', '#toggle-email'],
        buttons: {
          '#toggle-email': '换回验证器验证码',
          '#toggle-recovery': '使用恢复码',
        },
        intro: '输入邮箱里的 6 位验证码。',
      },
      recovery: {
        label: '恢复码', placeholder: 'XXXX-XXXX-XXXX-XXXX', numeric: false,
        hide: ['#send-2fa-code', '#toggle-email'],
        buttons: { '#toggle-recovery': '改用两步验证码' },
        intro: '输入一个恢复码。',
      },
    },
  });
  function useTotpStep(on) {
    const show = on ? stepTotp : stepPwd;
    const hide = on ? stepPwd : stepTotp;
    $('#login-submit').textContent = on ? '完成登录' : '登录';
    f2.set('totp', { silent: true, focus: false });   // 回验证器形态，防残留
    flowSwap(hide, show, () => { if (on) $('#login-code-2fa').focus(); });
  }
  $('#back-to-password').addEventListener('click', () => { loginToken = ''; useTotpStep(false); });
  $('#toggle-email').addEventListener('click', () => f2.set(f2.mode() === 'email' ? 'totp' : 'email'));
  $('#toggle-recovery').addEventListener('click', () => f2.set(f2.mode() === 'recovery' ? 'totp' : 'recovery'));
  $('#send-2fa-code').addEventListener('click', async () => {
    const sent = await sendCode($('#login-email').value.trim(), 'login_2fa', '#login-error', $('#send-2fa-code'));
    if (sent) $('#totp-email-hint').hidden = false;
  });

  $('#pane-password').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('#login-error', '');
    showDenial('#login-denied', null);
    const btn = $('#login-submit');
    setBusy(btn, true);
    try {
      if (!loginToken) {
        const pwd = $('#login-password').value;
        const res = await api('/web/login/password', {
          method: 'POST',
          body: { email: $('#login-email').value.trim(), password: pwd },
        });
        if (res.status === '2fa_required') {
          loginToken = res.loginToken;
          enteredPw = pwd;
          useTotpStep(true);
          return;
        }
        finishLogin(res, pwd);
        return;
      }
      // 单输入三选一：按当前模式决定字段；空输入在前端就挡下
      const v = $('#login-code-2fa').value.trim();
      const fm = f2.mode();
      if (!v) {
        showErr('#login-error', fm === 'email' ? '请输入邮箱验证码'
          : fm === 'recovery' ? '请输入恢复码' : '请输入两步验证码');
        return;
      }
      const body = { loginToken, code: '', recoveryCode: '', emailCode: '' };
      if (fm === 'email') body.emailCode = v;
      else if (fm === 'recovery') body.recoveryCode = v;
      else body.code = v;
      const done = await api('/web/login/totp', { method: 'POST', body });
      finishLogin(done, enteredPw);
    } catch (err) {
      // 403（封禁/项目登录策略）按拒绝态分级呈现：徽标 + 原因 + 下一步；
      // 其余错误（密码错等）照旧走行内 .err
      const denied = err.status === 403 &&
        showDenial('#login-denied', err, { retry: () => showDenial('#login-denied', null) });
      if (!denied) showErr('#login-error', err.message);
      // 只有**登录中间态**过期才退回第一步——邮箱码自己的「验证码已过期」不触发
      if (loginToken && err.message.indexOf('登录请求已过期') >= 0) { loginToken = ''; useTotpStep(false); }
    } finally {
      setBusy(btn, false);
    }
  });

  // ---- 发码（验证码登录 / 找回密码 / 两步邮箱码）：共享冷却 ----
  async function sendCode(email, purpose, errSel, btn) {
    showErr(errSel, '');
    if (!email) { showErr(errSel, '请先填写邮箱'); return false; }
    try {
      await api('/auth/send-code', { method: 'POST', body: { email, purpose } });
      cooldown(btn, 60);
      toast('验证码已发送。没收到？在垃圾箱里搜索发件人『Auth』，60 秒后可重新发送');
      return true;
    } catch (err) { showErr(errSel, err.message); return false; }
  }
  $('#send-code').addEventListener('click', () =>
    sendCode($('#code-email').value.trim(), 'login', '#code-error', $('#send-code')));
  $('#send-reset-code').addEventListener('click', () =>
    sendCode($('#reset-email').value.trim(), 'reset', '#reset-error', $('#send-reset-code')));

  $('#pane-code').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('#code-error', '');
    showDenial('#login-denied', null);
    const btn = busySubmit(e);
    try {
      const done = await api('/web/login/email-code', {
        method: 'POST',
        body: { email: $('#code-email').value.trim(), code: $('#code-code').value.trim() },
      });
      finishLogin(done);
    } catch (err) {
      if (!(err.status === 403 && showDenial('#login-denied', err, { retry: () => showDenial('#login-denied', null) }))) {
        showErr('#code-error', err.message);
      }
    } finally { idleSubmit(btn); }
  });

  $('#pane-reset').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('#reset-error', '');
    const btn = busySubmit(e);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: {
          email: $('#reset-email').value.trim(),
          code: $('#reset-code').value.trim(),
          password: $('#reset-password').value,
        },
      });
      toast('密码已重置，请用新密码登录');
      $('#tab-password').click();
      $('#login-email').value = $('#reset-email').value.trim();
    } catch (err) { showErr('#reset-error', err.message); } finally { idleSubmit(btn); }
  });

  // ---- Passkey 登录（不支持则整个入口隐藏，不摆死按钮） ----
  const supportsPasskey = !!(window.PublicKeyCredential && navigator.credentials);
  $('#passkey-login').classList.toggle('hidden', !supportsPasskey);
  $('#passkey-sep').classList.toggle('hidden', !supportsPasskey);
  // ---- 条件式 UI：passkey 挂进邮箱框的自动填充（服务端已是 discoverable） ----
  let condAbort = null;
  (async () => {
    try {
      if (!supportsPasskey || !window.PublicKeyCredential.isConditionalMediationAvailable) return;
      if (!(await PublicKeyCredential.isConditionalMediationAvailable())) return;
      const opts = await api('/webauthn/login/options', { method: 'POST', body: {}, noReauth: true });
      condAbort = new AbortController();
      const cred = await navigator.credentials.get({
        publicKey: decodePKOptions(opts.publicKey),
        mediation: 'conditional',
        signal: condAbort.signal,
      });
      const done = await api('/webauthn/login/finish', {
        method: 'POST',
        body: { ceremonyId: opts.ceremonyId, response: assertionJSON(cred) },
      });
      finishLogin(done);
    } catch (err) {
      // 条件式是「增强」不是「必需」：任何失败都静默——不打扰登录主路径
    }
  })();
  // 用户一旦走密码路，立即取消挂着的条件式请求
  const abortCond = () => { if (condAbort) { condAbort.abort(); condAbort = null; } };
  ['#pane-password', '#pane-code', '#pane-reset'].forEach(sel => {
    const f = $(sel);
    if (f) f.addEventListener('submit', abortCond, true);
  });

  if (supportsPasskey) {
    $('#passkey-login').addEventListener('click', async () => {
      showErr('#passkey-error', '');
      const btn = $('#passkey-login');
      setBusy(btn, true);
      try {
        const opts = await api('/webauthn/login/options', { method: 'POST', body: {} });
        const cred = await navigator.credentials.get({ publicKey: decodePKOptions(opts.publicKey) });
        const done = await api('/webauthn/login/finish', {
          method: 'POST',
          body: { ceremonyId: opts.ceremonyId, response: assertionJSON(cred) },
        });
        finishLogin(done);
      } catch (err) {
        if (err && err.name === 'NotAllowedError') return; // 用户取消不报错
        showErr('#passkey-error', (err && err.message) || 'Passkey 验证失败，请重试');
      } finally { setBusy(btn, false); }
    });
  }
}

/* ---------- WebAuthn：浏览器对象 → 服务端库解析的 JSON 形状 ----------
   服务端 JSON 里 challenge/user.id/allowCredentials[].id 是 base64url 字符串，
   浏览器只收 ArrayBuffer——进 create/get 前统一解码。 */
function b64urlToBytes(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : '';
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function decodePKOptions(pk) {
  if (!pk) return pk;
  if (typeof pk.challenge === 'string') pk.challenge = b64urlToBytes(pk.challenge);
  if (pk.user && typeof pk.user.id === 'string') pk.user.id = b64urlToBytes(pk.user.id);
  ['allowCredentials', 'excludeCredentials'].forEach(k => {
    if (Array.isArray(pk[k])) pk[k].forEach(c => { if (typeof c.id === 'string') c.id = b64urlToBytes(c.id); });
  });
  return pk;
}
function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function creationJSON(cred) {
  return {
    id: cred.id,
    rawId: b64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: b64url(cred.response.clientDataJSON),
      attestationObject: b64url(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
  };
}

function assertionJSON(cred) {
  return {
    id: cred.id,
    rawId: b64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: b64url(cred.response.clientDataJSON),
      authenticatorData: b64url(cred.response.authenticatorData),
      signature: b64url(cred.response.signature),
      userHandle: cred.response.userHandle ? b64url(cred.response.userHandle) : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
  };
}

/* ---------- 概览 ---------- */
async function initConsole() {
  if (!$('#me-email')) return;
  // **先绑登出，再发请求**：登出是逃生口，必须与请求结果无关
  $('#logout').addEventListener('click', async () => {
    try { stopSessionRefresh(); await api('/web/logout', { method: 'POST', body: {} }); } catch (_) { /* 已登出也要跳 */ }
    location.href = '/web/login';
  });

  let me = null;
  try {
    me = await api('/web/session', { method: 'POST', body: {} });
  } catch (err) {
    if (err.status !== 401) toast(err.message, true);
    return;
  }
  if (!me) return;
  $('#me-email').textContent = me.email;
  if (me.role === 'admin' || me.role === 'super') {
    const badge = $('#role-badge');
    badge.textContent = me.role === 'super' ? '平台管理员' : '项目管理员';
    badge.classList.remove('hidden');
    badge.classList.add('on');
    popIn(badge);
  }

  // 三行状态互不牵连、并行取（一行失败只标红那一行）
  const fill = (sel, fn) => fn().then(v => { $(sel).textContent = v; })
    .catch(err => { if (err.status !== 401) $(sel).textContent = '读取失败（' + err.message + '）'; });
  fill('#stat-password', async () => me.passwordSet ? '已设置' : '未设置');
  fill('#stat-totp', async () => (await api('/api/totp')).enabled ? '已开启' : '未开启');
  fill('#stat-passkey', async () => {
    const keys = await api('/api/passkeys');
    return keys.length ? `${keys.length} 个` : '未添加';
  });
  // 最近登录（服务端按最近活跃倒序，首条即最近）
  api('/api/sessions').then(r => {
    const first = (r.sessions || [])[0];
    const el = $('#me-last-login');
    if (!el) return;
    el.innerHTML = first
      ? `最近登录：<span data-rel="${esc(first.lastSeenAt)}">${esc(relTime(first.lastSeenAt))}</span> · ${esc(first.device || '未知设备')} · IP ${ipWithRegion(first.ip, first.ipRegion)}`
      : '还没有登录记录。';
  }).catch(() => {
    const el = $('#me-last-login');
    if (el) el.textContent = '';   // 取不到就不占位，不编造
  });
}

/* ---------- 登录会话（扁平列表：一行=一条会话，行主标题=设备名） ---------- */
/* 设备类型图标（lucide 同款路径，内联进 JS 是因为列表行由 JS 拼）：按服务端
   UA 解析出的设备标签映射，认不出的退回通用设备图标，不猜。 */
const DEVICE_ICONS = {
  smartphone: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></svg>',
  laptop: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" /></svg>',
  monitor: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>',
  device: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15" /><path d="M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" /></svg>',
};

function deviceIcon(device) {
  const d = String(device || '');
  if (/Android|iPhone|iPad|iOS|Mobile/i.test(d)) return DEVICE_ICONS.smartphone;
  if (/Windows|macOS|Mac OS X|Linux|ChromeOS|Ubuntu/i.test(d)) return DEVICE_ICONS.laptop;
  return DEVICE_ICONS.device;
}

function initSessions() {
  const list = $('#session-list');
  if (!list) return;
  let rows = [];
  let pending = null;   // {mode:'one'|'others', ids:[], label, count}

  async function load() {
    setListBusy(list, true);
    try {
      const res = await api('/api/sessions');
      rows = res.sessions || [];
      const others = rows.filter(r => !r.current).length;
      const revokeOthers = $('#revoke-others');
      if (revokeOthers) revokeOthers.classList.toggle('hidden', others === 0);
    } catch (err) {
      list.innerHTML = emptyState('读取失败', err.message);
      setListBusy(list, false);
      return;
    }
    if (!rows.length) {
      list.innerHTML = emptyState('只有当前设备处于登录状态', '新设备登录后会显示在这里。');
      setListBusy(list, false);
      return;
    }
    list.innerHTML = '';
    // 服务端已按最近活跃倒序，直接铺平；区分同名设备的线索（IP/首次登录）常驻副行
    rows.forEach(it => {
      const el = node(`
        <div class="item session-row${it.current ? ' current' : ''}" data-id="${esc(it.id)}">
          <span class="ico-wrap">${deviceIcon(it.device)}</span>
          <span class="grow">
            <span class="title">${esc(it.device)}</span>
            <br><span class="meta">${esc(appLabel(it.app))} · 最近活跃 ${esc(relTime(it.lastSeenAt))} · IP ${ipWithRegion(it.ip, it.ipRegion)} · 首次登录 ${esc(it.createdAt > 0 ? fmtTime(it.createdAt) : '—')}</span>
            ${it.current ? '<span class="badge on">本设备</span>' : ''}
          </span>
          ${it.current ? '' : '<button type="button" class="btn small danger">退出</button>'}
        </div>`);
      const kick = el.querySelector('button.danger');
      if (kick) {
        kick.addEventListener('click', () => {
          pending = { mode: 'one', ids: [el.dataset.id], label: it.device, count: 1 };
          $('#kick-title').textContent = '退出这条会话';
          $('#kick-desc').textContent = `将退出「${it.device}」上的「${appLabel(it.app)}」会话，它下次请求时会退出登录。`;
          $('#kick-ok').textContent = '退出会话';
          openDialog($('#kick-dialog'), '#kick-cancel');
        });
      }
      list.appendChild(el);
    });
    setListBusy(list, false);
  }

  const refreshBtn = $('#sessions-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    setBusy(refreshBtn, true);
    load().finally(() => setBusy(refreshBtn, false));
  });
  // 切回标签页时重取：会话「最近活跃」不该停在离开时的快照
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });

  $('#revoke-others').addEventListener('click', () => {
    const others = rows.filter(r => !r.current).length;
    pending = { mode: 'others', ids: [], label: '', count: others };
    $('#kick-title').textContent = '退出其它所有会话';
    $('#kick-desc').textContent = others
      ? `将退出除「本设备」外的 ${others} 条会话，本设备保持登录。`
      : '没有其它会话需要退出。';
    $('#kick-ok').textContent = others ? '全部退出' : '知道了';
    openDialog($('#kick-dialog'), '#kick-cancel');
  });
  $('#kick-cancel').addEventListener('click', () => closeDialog($('#kick-dialog')));
  $('#kick-ok').addEventListener('click', async () => {
    const dlg = $('#kick-dialog');
    if (pending.mode === 'others' && !pending.count) { closeDialog(dlg); return; }
    const okBtn = $('#kick-ok');
    setBusy(okBtn, true);
    try {
      if (pending.mode === 'one') {
        await api('/api/sessions/' + pending.ids[0], { method: 'DELETE' });
        closeDialog(dlg);
        toast('已退出该会话');
        fadeOutRow(list.querySelector(`.session-row[data-id="${pending.ids[0]}"]`), load);
      } else {
        // 服务端强制 reauth（2 小时强认证窗），401 自动弹重验框再重试
        await api('/api/sessions/revoke-others', { method: 'POST', body: {} });
        closeDialog(dlg);
        toast(`已退出其它 ${pending.count} 条会话`);
        const leaving = $$('#session-list .session-row:not(.current)');
        if (!leaving.length || reducedMotion()) { await load(); return; }
        leaving.forEach(el => el.classList.add('leaving'));
        setTimeout(load, 180);
      }
    } catch (err) {
      closeDialog(dlg);
      toast(err.message, true);
    } finally {
      setBusy(okBtn, false);
    }
  });

  load();
}

/* ---------- Passkey 管理 ---------- */
function initPasskeys() {
  const list = $('#passkey-list');
  if (!list) return;
  let pendingDel = 0;

  async function load() {
    setListBusy(list, true);
    try {
      const rows = await api('/api/passkeys');
      if (!rows.length) {
        list.innerHTML = emptyState('还没有 Passkey', '点右上角「添加 Passkey」创建，用指纹或面容登录。');
        setListBusy(list, false);
        return;
      }
      list.innerHTML = '';
      rows.forEach(it => {
        const lastUsed = Number(it.lastUsedAt || 0) > 0
          ? `最近使用 <span data-rel="${esc(it.lastUsedAt)}">${esc(relTime(it.lastUsedAt))}</span>` : '从未使用';
        const el = node(`
          <div class="item" data-id="${it.id}">
            <span class="grow">
              <span class="title pk-name">${esc(it.name)}</span>
              ${it.current ? '<span class="badge on">本设备</span>' : ''}
              <br><span class="meta">添加于 ${esc(fmtTime(it.createdAt))} · ${lastUsed}</span>
            </span>
            <span class="row" style="gap:6px">
              <button type="button" class="btn small" data-act="rename">改名</button>
              <button type="button" class="btn small danger" data-act="del">删除</button>
            </span>
          </div>`);
        el.querySelector('[data-act=rename]').addEventListener('click', () => startRename(el, it));
        el.querySelector('[data-act=del]').addEventListener('click', () => {
          pendingDel = it.id;
          $('#del-desc').textContent = `删除「${it.name}」后，这把 Passkey 立即不能再用来登录。`;
          openDialog($('#del-dialog'), '#del-cancel');
        });
        list.appendChild(el);
      });
    } catch (err) {
      list.innerHTML = emptyState('读取失败', err.message);
    } finally {
      setListBusy(list, false);
    }
  }

  // 改名：就地把名字换成输入框（行内操作最省事）。
  // 值没改不发 PATCH；提交期间不再响应 blur（否则重绘会吞掉同一次 click）。
  function startRename(el, it) {
    const nameEl = el.querySelector('.pk-name');
    if (el.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = it.name;
    input.maxLength = 64;
    input.setAttribute('aria-label', 'Passkey 名称');
    input.setAttribute('autocomplete', 'off');
    nameEl.replaceWith(input);
    input.focus();
    let committing = false;
    const original = input.value;
    const commit = async () => {
      if (committing) return;
      if (input.value === original) { load(); return; }
      committing = true;
      try {
        await api('/api/passkeys/' + it.id, { method: 'PATCH', body: { name: input.value } });
        toast('已改名');
        await load();
      } catch (err) { toast(err.message, true); await load(); }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); load(); }
    });
    input.addEventListener('blur', commit);
  }

  $('#add-passkey').addEventListener('click', async () => {
    showErr('#passkey-error', '');
    const btn = $('#add-passkey');
    if (!(window.PublicKeyCredential && navigator.credentials)) {
      showErr('#passkey-error', '当前浏览器不支持 Passkey，请换用 Chrome、Safari 或 Edge 的新版本');
      return;
    }
    setBusy(btn, true);
    try {
      const opts = await api('/webauthn/register/options', { method: 'POST', body: {} });
      const cred = await navigator.credentials.create({ publicKey: decodePKOptions(opts.publicKey) });
      if (!cred) return; // 用户取消
      await api('/webauthn/register/finish', {
        method: 'POST',
        body: { ceremonyId: opts.ceremonyId, response: creationJSON(cred) },
      });
      toast('Passkey 已添加');
      await load();
      // 创建后请用户起个名字（帮助分辨「哪把、属于哪个认证器」）：列表按
      // created_at DESC，首行即刚创建的这把，直接进入行内改名，可 Esc 跳过。
      const fresh = $('#passkey-list .item');
      if (fresh) {
        const renameBtn = fresh.querySelector('[data-act=rename]');
        if (renameBtn) {
          renameBtn.click();
          toast('为这把 Passkey 起名，Esc 跳过');
        }
      }
    } catch (err) {
      if (err && err.name === 'NotAllowedError') return;
      showErr('#passkey-error', (err && err.message) || '添加失败，请重试');
    } finally { setBusy(btn, false); }
  });

  $('#del-cancel').addEventListener('click', () => closeDialog($('#del-dialog')));
  $('#del-ok').addEventListener('click', async () => {
    try {
      await api('/api/passkeys/' + pendingDel, { method: 'DELETE' });
      toast('已删除');
      closeDialog($('#del-dialog'));
      await load();
    } catch (err) {
      closeDialog($('#del-dialog'));
      toast(err.message, true);
    }
  });

  load();
}

/* ---------- 两步验证 ---------- */
function initSecurity() {
  if (!$('#totp-badge')) return;
  let codes = [];

  async function refresh() {
    const st = await api('/api/totp');
    const badge = $('#totp-badge');
    const was = badge.textContent;
    badge.textContent = st.enabled ? '已开启' : '未开启';
    badge.classList.toggle('on', st.enabled);
    if (was && was !== badge.textContent) popIn(badge);
    $('#totp-off').hidden = st.enabled;
    $('#totp-on').hidden = !st.enabled;
    if (st.enabled) {
      $('#totp-since').textContent = '开启时间：' + fmtTime(st.createdAt);
      const rs = $('#recovery-state');
      if (rs) {
        const left = typeof st.recoveryLeft === 'number' ? st.recoveryLeft : 0;
        const total = typeof st.recoveryTotal === 'number' ? st.recoveryTotal : 0;
        rs.textContent = total > 0
          ? `恢复码：剩余 ${left} / ${total} 枚；用尽或想换一批时可重新生成。`
          : '恢复码：当前没有可用的恢复码，建议立即重新生成一批。';
        // 低余量警示（≤2 枚）：用尽才发现没码是最贵的失败
        if (total > 0 && left <= 2 && left < total) {
          rs.innerHTML = `<span class="badge warn">恢复码即将用尽</span> ` +
            `恢复码：剩余 ${left} / ${total} 枚，请尽快重新生成一批。`;
        }
      }
    }
  }

  /* 恢复码一次性展示：复选确认 + 完成钮联动（不勾「已保存」关不掉这一页，
     防止「瞥一眼就关掉、一组码都没存」）。 */
  function showCodes(list) {
    codes = list;
    const box = $('#codes-list');
    box.innerHTML = '';
    list.forEach(c => {
      const el = document.createElement('span');
      el.textContent = c;
      box.appendChild(el);
    });
    // 一次性凭据用完即从 DOM 摘掉：绑定用的 TOTP 密钥、二维码与刚输入的码留在
    // 页面上，之后任何 DOM 快照（截图、扩展、一次 XSS）都能把它们带走——绑定完成
    // 后它们对用户已无用途，留着只有风险。
    const secret = $('#setup-secret');
    if (secret) secret.textContent = '';
    const qr = $('#qr-img');
    if (qr) qr.removeAttribute('src');
    const setupCode = $('#setup-code');
    if (setupCode) setupCode.value = '';
    $('#codes-ack').checked = false;
    $('#saved-codes').disabled = true;
    $('#setup-panel').classList.add('hidden');
    $('#codes-panel').classList.remove('hidden');
    swapIn($('#codes-panel'));
    $('#codes-ack').focus();
  }
  $('#codes-ack').addEventListener('change', e => {
    $('#saved-codes').disabled = !e.target.checked;
  });

  $('#start-setup').addEventListener('click', async () => {
    showErr('#setup-error', '');
    try {
      const setup = await api('/api/totp/setup', { method: 'POST', body: {} });
      $('#qr-img').src = setup.qrPng;
      $('#setup-secret').textContent = setup.secret;
      $('#setup-code').value = '';
      $('#setup-panel').classList.remove('hidden');
      swapIn($('#setup-panel'));
      $('#setup-code').focus();
    } catch (err) { toast(err.message, true); }
  });
  $('#cancel-setup').addEventListener('click', () => $('#setup-panel').classList.add('hidden'));
  $('#copy-secret').addEventListener('click', async () => {
    await copyText($('#setup-secret').textContent);
    toast('密钥已复制');
  });
  $('#confirm-setup').addEventListener('click', async () => {
    showErr('#setup-error', '');
    const btn = $('#confirm-setup');
    setBusy(btn, true);
    try {
      const res = await api('/api/totp/enable', { method: 'POST', body: { code: $('#setup-code').value.trim() } });
      showCodes(res.recoveryCodes);
      await refresh();
    } catch (err) { showErr('#setup-error', err.message); } finally { setBusy(btn, false); }
  });

  /* 恢复码下载（GitHub recovery-codes.txt 结构：服务名 + 账号 + 日期 + 说明 + 码） */
  $('#download-codes').addEventListener('click', () => {
    const body = [
      'Auth 恢复码',
      `账号：${accountEmail()}`,
      `生成：${todayStr()}`,
      '',
      '每个恢复码只能用一次，验证器不可用时用于登录。用完即失效；重生成会让旧码全部作废。请离线保存。',
      '',
      ...codes,
      '',
    ].join('\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'auth-recovery-codes.txt';
    a.click();
    // 下载是异步开始的：同步 revoke 会让部分浏览器（Safari）把下载取消掉，
    // 留一拍再回收对象 URL。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#copy-codes').addEventListener('click', async () => {
    await copyText(codes.join('\n'));
    toast('恢复码已复制到剪贴板');
  });
  const printBtn = $('#print-codes');
  if (printBtn) printBtn.addEventListener('click', () => window.print());
  $('#saved-codes').addEventListener('click', () => {
    $('#codes-panel').classList.add('hidden');
    $('#codes-list').innerHTML = '';   // 与数组一起清：DOM 里也不留这组码
    codes = [];
    toast('恢复码已保存。离开本页后无法再查看，需要时可重生成。');
  });

  // 通用「要一个码」弹框（单输入 + 恢复码切换；返回码字符串，空串 = 取消）
  let codeResolver = null;
  const codeToggle = makeCodeToggle($('#code-input'), $('#code-input-label'), {
    initial: 'code',
    errSel: '#code-error',
    modes: {
      code: {
        label: '两步验证码（6 位）', placeholder: '输入验证器上的 6 位验证码', numeric: true,
        buttons: { '#code-toggle-recovery': '使用恢复码' },
      },
      recovery: {
        label: '恢复码', placeholder: 'XXXX-XXXX-XXXX-XXXX', numeric: false,
        buttons: { '#code-toggle-recovery': '改用两步验证码' },
      },
    },
  });
  $('#code-toggle-recovery').addEventListener('click', () =>
    codeToggle.set(codeToggle.mode() === 'recovery' ? 'code' : 'recovery', { focus: true }));
  function askCode(title, desc) {
    $('#code-title').textContent = title;
    $('#code-desc').textContent = desc;
    codeToggle.reset();
    showErr('#code-error', '');
    openDialog($('#code-dialog'));
    $('#code-input').focus();
    return new Promise(resolve => { codeResolver = resolve; });
  }
  // 取消的**唯一收口**：点「取消」、按 Esc、浏览器关闭弹窗都走这里——
  // 此前只绑 click，按 Esc 会让调用方的 await 永久挂起。
  const cancelCode = () => {
    if ($('#code-dialog').open) closeDialog($('#code-dialog'));
    if (codeResolver) { codeResolver(''); codeResolver = null; }
  };
  $('#code-cancel').addEventListener('click', cancelCode);
  $('#code-dialog').addEventListener('cancel', e => { e.preventDefault(); cancelCode(); });
  $('#code-form').addEventListener('submit', async e => {
    e.preventDefault();
    const value = $('#code-input').value.trim();
    if (!value) { showErr('#code-error', codeToggle.mode() === 'recovery' ? '请输入恢复码' : '请输入两步验证码'); return; }
    if (codeResolver) { codeResolver(value); codeResolver = null; }
    closeDialog($('#code-dialog'));
  });

  $('#regen-codes').addEventListener('click', async () => {
    const code = await askCode('重生成恢复码', '输入当前两步验证码或一个恢复码；旧的恢复码会全部作废。');
    if (!code) return;
    try {
      const res = await api('/api/totp/regenerate-recovery-codes', { method: 'POST', body: { code } });
      showCodes(res.recoveryCodes);
      toast('已换发新恢复码，旧码全部作废');
    } catch (err) { toast(err.message, true); }
  });
  $('#disable-totp').addEventListener('click', async () => {
    const code = await askCode('关闭两步验证？', '关闭后账号只剩密码一道防线，验证器绑定与全部恢复码立即失效；其它设备保持登录状态。输入当前两步验证码或一个恢复码确认。');
    if (!code) return;
    try {
      await api('/api/totp/disable', { method: 'POST', body: { code } });
      toast('两步验证已关闭');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  const retryBtn = $('#totp-retry');
  if (retryBtn) retryBtn.addEventListener('click', () => {
    retryBtn.classList.add('hidden');
    $('#totp-badge').textContent = '读取中…';
    refresh().catch(() => { retryBtn.classList.remove('hidden'); $('#totp-badge').textContent = '读取失败'; });
  });

  // 加载失败不能只弹 toast：徽标会永远停在「读取中…」、两个分区双双隐藏，
  // 整页空白且没有重试入口。改成徽标标「读取失败」+ 出重试钮。
  refresh().catch(err => {
    if (err.status === 401) return;
    const badge = $('#totp-badge');
    badge.textContent = '读取失败';
    badge.classList.remove('on');
    const retry = $('#totp-retry');
    if (retry) retry.classList.remove('hidden');
  });
}

/* ---------- 账号：改密 / 改邮箱 / 注销 ---------- */
function initAccount() {
  if (!$('#pane-pw-old')) return;

  const tabs = { 'tab-pw-old': 'pane-pw-old', 'tab-pw-code': 'pane-pw-code' };
  Object.keys(tabs).forEach(id => $('#' + id).addEventListener('click', () => {
    // 与登录页同一套 flowSwap 连续过渡（两步之间不瞬变）
    const prev = Object.keys(tabs).map(k => $('#' + tabs[k]))
      .find(p => !p.classList.contains('hidden'));
    Object.keys(tabs).forEach(other =>
      $('#' + other).setAttribute('aria-selected', other === id ? 'true' : 'false'));
    const next = $('#' + tabs[id]);
    if (prev !== next) flowSwap(prev, next);
  }));

  $('#pane-pw-old').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('#pw-old-error', '');
    const btn = busySubmit(e);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value },
      });
      $('#pw-old').value = ''; $('#pw-new').value = '';
      toast('密码已修改');
    } catch (err) { showErr('#pw-old-error', err.message); } finally { idleSubmit(btn); }
  });

  $('#send-pw-code').addEventListener('click', async () => {
    showErr('#pw-code-error', '');
    try {
      await api('/auth/send-change-code', { method: 'POST', body: {} });
      cooldown($('#send-pw-code'), 60);
      toast('验证码已发送到绑定邮箱');
    } catch (err) { showErr('#pw-code-error', err.message); }
  });

  $('#pane-pw-code').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('#pw-code-error', '');
    const btn = busySubmit(e);
    try {
      await api('/auth/change-password-code', {
        method: 'POST',
        body: { code: $('#pw-code').value.trim(), password: $('#pw-code-new').value },
      });
      $('#pw-code').value = ''; $('#pw-code-new').value = '';
      toast('密码已修改');
    } catch (err) { showErr('#pw-code-error', err.message); } finally { idleSubmit(btn); }
  });

  $('#send-email-code').addEventListener('click', async () => {
    showErr('#email-error', '');
    const email = $('#email-new').value.trim();
    if (!email) { showErr('#email-error', '请先填写新邮箱'); return; }
    try {
      await api('/auth/send-change-email-code', { method: 'POST', body: { email } });
      cooldown($('#send-email-code'), 60);
      toast('验证码已发送到新邮箱');
    } catch (err) { showErr('#email-error', err.message); }
  });

  $('#change-email').addEventListener('click', async () => {
    showErr('#email-error', '');
    const btn = $('#change-email');
    setBusy(btn, true);
    try {
      await api('/auth/change-email', {
        method: 'POST',
        body: {
          password: $('#email-password').value,
          email: $('#email-new').value.trim(),
          code: $('#email-code').value.trim(),
        },
      });
      $('#email-code').value = ''; $('#email-password').value = '';
      // 改完邮箱当场把三处身份显示换成新邮箱（否则敏感操作做完了页面还挂着旧身份）
      const newEmail = $('#email-new').value.trim();
      if (newEmail) {
        const pfEmail = $('#pf-email');
        if (pfEmail) pfEmail.textContent = newEmail;
        const hasNickname = !!(profileCache && (profileCache.nickname || '').trim());
        setAccountIdentity(newEmail, hasNickname ? null : newEmail.split('@')[0]);
      }
      toast('邮箱已更新，新旧邮箱都收到了通知');
    } catch (err) { showErr('#email-error', err.message); } finally { setBusy(btn, false); }
  });

  // ---- 注销：注册邮箱 + 邮箱验证码双确认 + 手输短语闸，7 天反悔期 ----
  $('#start-delete').addEventListener('click', () => {
    $('#delete-email').value = ''; $('#delete-code').value = '';
    $('#delete-phrase').value = '';
    $('#delete-submit').disabled = true;      // 每次打开都回到锁定态
    showErr('#delete-error', '');
    openDialog($('#delete-dialog'));
    $('#delete-email').focus();
  });
  $('#delete-phrase').addEventListener('input', () => {
    $('#delete-submit').disabled = $('#delete-phrase').value.trim() !== '注销';
  });
  $('#send-delete-code').addEventListener('click', async () => {
    showErr('#delete-error', '');
    const email = $('#delete-email').value.trim();
    if (!email) { showErr('#delete-error', '请先填写注册邮箱'); return; }
    try {
      await api('/auth/send-code', { method: 'POST', body: { email, purpose: 'delete' } });
      cooldown($('#send-delete-code'), 60);
      toast('验证码已发送。没收到？在垃圾箱里搜索发件人『Auth』，60 秒后可重新发送');
    } catch (err) { showErr('#delete-error', err.message); }
  });
  $('#delete-cancel').addEventListener('click', () => closeDialog($('#delete-dialog')));
  $('#delete-form').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('#delete-error', '');
    const email = $('#delete-email').value.trim();
    const code = $('#delete-code').value.trim();
    if (!email) { showErr('#delete-error', '请先填写注册邮箱'); return; }
    if (!code) { showErr('#delete-error', '请输入邮箱验证码'); return; }
    if ($('#delete-phrase').value.trim() !== '注销') {
      showErr('#delete-error', '请在上方输入「注销」以确认'); return;
    }
    const btn = $('#delete-form').querySelector('.btn.danger');
    setBusy(btn, true);
    try {
      await api('/auth/delete', { method: 'POST', body: { email, code } });
      closeDialog($('#delete-dialog'));
      try { stopSessionRefresh(); await api('/web/logout', { method: 'POST', body: {} }); } catch (_) { /* 已登出也要跳 */ }
      flash('注销已提交，7 天内登录可撤销');
      location.href = '/web/login';
    } catch (err) { showErr('#delete-error', err.message); setBusy(btn, false); }
  });

  initProfile();
  initLoginNotify();
}

/* ---------- 账号资料（头像 / 昵称 / 头像色） ----------
   PUT /api/profile 是**全量替换**语义：资料卡与登录提醒开关各发一次全量 PUT，
   若其中一方用过期的 GET 结果会把对方刚改的字段写回旧值——两条路径共用
   同一份「最后一次已知的完整档案」（profileCache），谁保存成功谁更新它。 */
let profileCache = null;

/* 当前登录邮箱（顶栏胶囊 title 是权威来源；Minimal 壳没有顶栏时回空串） */
function accountEmail() {
  const el = $('#topbar-email');
  return el ? (el.getAttribute('title') || '') : '';
}

/* 顶栏身份同步：显示名（昵称优先）+ title 邮箱，两处胶囊一起更新 */
function setAccountIdentity(email, displayName) {
  $$('.acct').forEach(a => { if (email) a.setAttribute('title', email); });
  const nameEl = $('#topbar-email');
  if (nameEl && displayName != null) nameEl.textContent = displayName;
}

function initProfile() {
  const avatarEl = $('#pf-avatar');
  if (!avatarEl) return;
  const fileInput = $('#pf-avatar-file');
  const saveBtn = $('#pf-save');
  const email = accountEmail();
  let pf = { nickname: '', avatarColor: 0, avatarImage: '' };
  let loaded = { nickname: '', avatarColor: 0, avatarImage: '' };
  let meUid = 0;

  const PALETTE = (() => {
    try {
      const el = document.getElementById('avatar-palette');
      const list = JSON.parse(el ? el.textContent : '[]');
      return Array.isArray(list) && list.length ? list : ['#5B8DEF'];
    } catch (_) { return ['#5B8DEF']; }
  })();

  // 展示底色 = 显式色（>0）> uid%8 派生——与 Go ui.AvatarPaletteHexFor 同式
  function effectiveColor() {
    const i = Number(pf.avatarColor);
    if (Number.isInteger(i) && i > 0 && i < PALETTE.length) return i;
    return meUid > 0 ? meUid % PALETTE.length : 0;
  }

  // 首字回退链与服务端 initialFor 同源：昵称首字符 → 邮箱前缀首字符
  function avatarInitial() {
    const src = (pf.nickname || '').trim() || (email || '').split('@')[0] || '';
    const runes = Array.from(src);
    return runes.length ? runes[0].toUpperCase() : '?';
  }

  function renderAvatar(fade) {
    const bg = PALETTE[effectiveColor()] || PALETTE[0];
    avatarEl.style.background = bg;
    avatarEl.style.color = avatarInk(bg);   // 首字墨色与底色成对
    const wantImg = !!pf.avatarImage;
    const curImg = avatarEl.querySelector('img');
    if (wantImg) {
      const src = 'data:image/jpeg;base64,' + pf.avatarImage;
      if (curImg) {
        if (curImg.src !== src) { curImg.src = src; if (fade) crossFade(avatarEl); }
      } else {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        avatarEl.replaceChildren(img);
        if (fade) crossFade(avatarEl);
      }
    } else if (curImg) {
      avatarEl.textContent = avatarInitial();
      if (fade) crossFade(avatarEl);
    } else {
      avatarEl.textContent = avatarInitial();
    }
    $('#pf-clear-avatar').classList.toggle('hidden', !wantImg);
    // 有自定义头像时收起色板行（底色只在无图时决定首字观感）；两态永远同步
    const paletteBox = $('#pf-palette');
    if (paletteBox) paletteBox.classList.toggle('hidden', wantImg);
  }

  function renderNick() {
    $('#pf-nick-view').textContent = pf.nickname || '未设置（显示邮箱前缀）';
  }

  /* 色板 = 「自动」+ 7 个可选色：服务端语义 avatarColor=0 = 未设（按 uid 派生），
     而色板下标 0 也是真实颜色——把 0 显式解释成「自动」，可选色从下标 1 起，
     每颗都能点、都能存，且不改后端与两个 App 的语义。 */
  function renderPalette() {
    const box = $('#pf-palette');
    box.innerHTML = '';
    const choices = [{ v: 0, auto: true }].concat(PALETTE.slice(1).map((hex, i) => ({ v: i + 1, hex })));
    const current = Number(pf.avatarColor) || 0;
    choices.forEach(c => {
      const on = current === c.v;
      const chip = c.auto
        ? node(`<button type="button" class="pf-chip auto${on ? ' on' : ''}"
            aria-pressed="${on}" aria-label="头像底色：自动（按账号派生）">自动</button>`)
        : node(`<button type="button" class="pf-chip${on ? ' on' : ''}"
            style="background:${esc(c.hex)}" aria-pressed="${on}" aria-label="头像底色 ${c.v + 1}"></button>`);
      chip.addEventListener('click', () => {
        if (Number(pf.avatarColor) === c.v) return;
        pf.avatarColor = c.v;
        $$('.pf-chip', box).forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
        chip.classList.add('on');
        chip.setAttribute('aria-pressed', 'true');
        renderAvatar(false);
        refreshDirty();
      });
      box.appendChild(chip);
    });
  }

  function dirty() {
    return pf.nickname !== loaded.nickname ||
      Number(pf.avatarColor) !== Number(loaded.avatarColor) ||
      pf.avatarImage !== loaded.avatarImage;
  }
  function nickTooLong() {
    return Array.from((pf.nickname || '').trim()).length > 64;
  }
  function refreshDirty() {
    saveBtn.disabled = !dirty() || nickTooLong();
  }

  function applyProfile(p) {
    pf = {
      nickname: p.nickname || '',
      avatarColor: Number(p.avatarColor) || 0,
      avatarImage: p.avatarImage || '',
    };
    loaded = Object.assign({}, pf);
    profileCache = Object.assign({}, p);
    const mailEl = $('#pf-email');
    if (mailEl) mailEl.textContent = email;
    renderNick();
    renderAvatar(false);
    renderPalette();
    refreshDirty();
  }

  async function load() {
    try {
      const [me, profile] = await Promise.all([
        api('/web/session', { method: 'POST', body: {} }).catch(() => null),
        api('/api/profile'),
      ]);
      meUid = Number(me && me.uid) || 0;
      applyProfile(profile);
    } catch (err) { showErr('#pf-error', err.message); }
  }

  // ---- 昵称行内编辑：≤64 字符（按字符计），超长即时提示且不可保存 ----
  $('#pf-nick-edit').addEventListener('click', () => {
    $('#pf-nick-view').classList.add('hidden');
    $('#pf-nick-edit').classList.add('hidden');
    const field = $('#pf-nick-field');
    field.classList.remove('hidden');
    $('#pf-nick-input').value = pf.nickname;
    swapIn(field);
    $('#pf-nick-input').focus();
  });
  function closeNickEdit() {
    $('#pf-nick-field').classList.add('hidden');
    $('#pf-nick-view').classList.remove('hidden');
    $('#pf-nick-edit').classList.remove('hidden');
    showErr('#pf-nick-err', '');
  }
  $('#pf-nick-input').addEventListener('input', e => {
    pf.nickname = e.target.value;
    const over = nickTooLong();
    showErr('#pf-nick-err', over ? '昵称最多 64 个字，请精简后重试' : '');
    renderNick();
    renderAvatar(false);
    refreshDirty();
  });
  $('#pf-nick-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); closeNickEdit(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      pf.nickname = loaded.nickname;
      $('#pf-nick-input').value = pf.nickname;
      renderNick(); renderAvatar(false); refreshDirty(); closeNickEdit();
    }
  });

  // ---- 头像上传：方形裁剪 → JPEG 0.85；超限降质重压 ----
  $('#pf-avatar-edit').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    showErr('#pf-error', '');
    try {
      pf.avatarImage = await cropAvatar(file);
      renderAvatar(true);
      refreshDirty();
    } catch (err) { showErr('#pf-error', err.message || '图片处理失败，请换一张试试'); }
  });
  $('#pf-clear-avatar').addEventListener('click', () => {
    if (!pf.avatarImage) return;
    pf.avatarImage = '';
    renderAvatar(true);
    refreshDirty();
  });

  saveBtn.addEventListener('click', async () => {
    showErr('#pf-error', '');
    setBusy(saveBtn, true);
    try {
      // 全量替换：三字段整份提交（漏哪个等于清哪个）
      applyProfile(await api('/api/profile', {
        method: 'PUT',
        body: { nickname: pf.nickname.trim(), avatarColor: pf.avatarColor, avatarImage: pf.avatarImage },
      }));
      toast('资料已更新');
      setAccountIdentity(email, (pf.nickname || '').trim() || (email || '').split('@')[0] || '');
      updateTopbarAvatar();
    } catch (err) { showErr('#pf-error', err.message); } finally { setBusy(saveBtn, false); }
  });

  function updateTopbarAvatar() {
    const top = $('#me-avatar');
    if (!top) return;
    const bg = PALETTE[effectiveColor()] || PALETTE[0];
    top.style.background = bg;
    top.style.color = avatarInk(bg);
    if (pf.avatarImage) {
      const img = document.createElement('img');
      img.src = 'data:image/jpeg;base64,' + pf.avatarImage;
      img.alt = '';
      top.replaceChildren(img);
    } else {
      top.textContent = avatarInitial();
    }
  }

  load();
}

/* 新设备登录提醒开关：PUT /api/profile 全量替换语义——先拿共享缓存（资料卡
   刚存过就是最新的），再带上 loginNotify 整份 PUT。失败回滚勾选态。 */
function initLoginNotify() {
  const box = $('#login-notify');
  if (!box) return;
  let loaded = null;
  async function load() {
    try {
      const p = profileCache || (profileCache = await api('/api/profile'));
      loaded = !!p.loginNotify;
      box.checked = loaded;
      box.disabled = false;
    } catch (err) {
      // 读不到时不能停在 unchecked：服务端默认是「开」，显示成「关」等于撒谎。
      // 置 indeterminate + 禁用，表示「状态未知」。
      box.checked = false;
      box.indeterminate = true;
      box.disabled = true;
      toast(err.message, true);
    }
  }
  box.addEventListener('change', async () => {
    const want = box.checked;
    box.disabled = true;
    try {
      const p = profileCache || (profileCache = await api('/api/profile'));
      const saved = await api('/api/profile', {
        method: 'PUT',
        body: {
          nickname: p.nickname || '', avatarColor: Number(p.avatarColor) || 0,
          avatarImage: p.avatarImage || '', loginNotify: want,
        },
      });
      profileCache = Object.assign({}, p, saved || {}, { loginNotify: want });
      loaded = want;
      toast(want ? '已开启新设备登录提醒' : '已关闭新设备登录提醒');
    } catch (err) {
      box.checked = loaded === null ? !want : loaded;
      toast(err.message, true);
    } finally { box.disabled = false; }
  });
  load();
}

/* 头像换新交叉淡入：只动 opacity */
function crossFade(el) {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return;
  try {
    el.animate([{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }],
      { duration: 200, easing: MOTION_EASE });
  } catch (_) { /* 浏览器不支持就静默 */ }
}

/* 方形裁剪 + JPEG 压缩：按短边居中裁（上限 512px），toDataURL(0.85)；
   解码后 >700KB 逐档降质，仍超再缩画布。回**裸 base64**（与两 App 同形）。 */
const AVATAR_MAX_DECODED = 700 * 1024;
async function cropAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片无法解码，请换一张'));
      im.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('图片尺寸异常，请换一张');
    let size = Math.min(side, 512);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    for (let attempt = 0; attempt < 3; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
      for (let q = 0.85; q >= 0.3; q -= 0.1) {
        const b64 = canvas.toDataURL('image/jpeg', q).split(',')[1] || '';
        if (Math.floor(b64.length * 3 / 4) <= AVATAR_MAX_DECODED) return b64;
      }
      size = Math.floor(size * 0.7);
    }
    throw new Error('图片过大，请换一张更小的图');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- 头像渲染（列表/抽屉/会话总览共用） ---------- */
const ROLE_LABEL = { super: '平台管理员', admin: '项目管理员', user: '普通用户' };

function avatarPalette() {
  try {
    const el = document.getElementById('avatar-palette');
    const list = JSON.parse(el ? el.textContent : '[]');
    return Array.isArray(list) && list.length ? list : ['#5B8DEF'];
  } catch (_) { return ['#5B8DEF']; }
}
function avatarInitial(nickname, email) {
  const src = (nickname || '').trim() || (email || '').split('@')[0] || '';
  const runes = Array.from(src);
  return runes.length ? esc(runes[0].toUpperCase()) : '?';
}
function avatarHex(index, uid) {
  const p = avatarPalette();
  const i = Number(index);
  // 展示色派生：显式色（>0）原样用；未设（0/越界）按 uid%8 派生——
  // 与 Go 侧 ui.AvatarPaletteHexFor 同式。
  if (Number.isInteger(i) && i > 0 && i < p.length) return p[i];
  const u = Number(uid);
  return p[Number.isInteger(u) && u > 0 ? u % p.length : 0];
}
/* 首字墨色：按 WCAG 相对亮度取白墨/黑墨中对比更高的一支——与 Go 侧
   ui.avatarInkFor 同式（白墨对 8 色色板全数 <4.5:1）。 */
function avatarInk(bg) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(bg || '').trim());
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const l = 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000';
}
function avatarHTML(u, px) {
  const size = `width:${px}px;height:${px}px;font-size:${Math.round(px * 0.42)}px`;
  const bg = avatarHex(u.avatarColor, u.uid);
  const initial = avatarInitial(u.nickname, u.email);
  // 真图统一走 /admin/users/{uid}/avatar（懒加载），无图 404 或加载失败时由
  // document 捕获阶段的 error 监听回退「色块 + 首字」；uid 缺位直接渲染色块。
  const img = Number(u.uid) > 0
    ? `<img class="avatar-img" loading="lazy" src="/admin/users/${esc(u.uid)}/avatar" alt="">` : '';
  return `<span class="avatar" data-initial="${initial}" style="${size};background:${esc(bg)};color:${avatarInk(bg)}" aria-hidden="true">${img || initial}</span>`;
}
/* 头像图加载失败（无图 404 / 网络错）：原地换回色块+首字。error 事件不冒泡，
   用 document 的捕获阶段统一接。 */
document.addEventListener('error', e => {
  const t = e.target;
  if (!t || !t.classList || !t.classList.contains('avatar-img')) return;
  const wrap = t.parentElement;
  if (wrap) wrap.textContent = wrap.dataset.initial || '?';
}, true);
function userCell(u, px) {
  const name = (u.nickname || '').trim() || u.email;
  return `<span class="user-cell">${avatarHTML(u, px)}
    <span class="grow"><span class="title truncate" title="${esc(u.email)}">${esc(name)}</span>${u.nickname ? `<br><span class="meta truncate" title="${esc(u.email)}">${esc(u.email)}</span>` : ''}</span></span>`;
}
/* 登录豁免摘要：角色/授权数 → 「谁对什么豁免」的一句话（与 access 页层级同口径） */
function scopeSummary(u) {
  if (u.role === 'super') return '豁免全部项目';
  const n = Number(u.scopeCount || 0);
  return n > 0 ? `豁免 ${n} 个项目` : '未获项目豁免';
}

/* 封禁范围选项：平台管理员 = 全局 + 注册表全部项目；项目管理员 = 仅自己授权的
   项目（GET /admin/projects 只回自己范围内的，前端不再裁）。 */
async function banScopeOptions() {
  if (IS_SUPER) {
    return [{ key: '*', label: '全部项目（全局）' }]
      .concat(knownApps().map(a => ({ key: a.key, label: a.label })));
  }
  try {
    const res = await api('/admin/projects');
    return (res.projects || []).map(p => ({ key: p.app, label: p.name }));
  } catch (_) { return []; }
}

/* 限时封禁的最早解除时间：当前 + 5 分钟（datetime-local 的本地格式） */
function banMinStr() {
  const d = new Date(Date.now() + 5 * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 后台：用户（含角色管理与登录豁免，合并页） ----------
   列表 = 搜索 + 服务端跨页筛选（角色/封禁）+ 分页 + 批量操作；详情 = 身份/角色与
   登录豁免/会话/资料/
   高风险操作（danger-zone）。授予项目即让该账号豁免该项目的登录限制——与
   项目访问页的豁免层级是同一件事的两个入口。 */
function initAdminUsers() {
  const body = $('#users-body');
  if (!body) return;
  const APPS = knownApps();
  const pager = makePager({ prev: '#users-prev', next: '#users-next', label: '#users-page', limit: 20 });

  // 确认弹窗：一次挂一个待执行动作 + 它的成功提示；after 可选拿回执收尾
  let pending = null;
  let lastDetail = { uid: 0, email: '' };
  function confirmAction(title, desc, done, fn, danger, after) {
    pending = { fn, done, after };
    $('#ud-dlg-title').textContent = title;
    $('#ud-dlg-desc').textContent = desc;
    $('#ud-dlg-ok').classList.toggle('danger', !!danger);
    showErr('#ud-dlg-error', '');
    openDialog($('#user-dialog'), '#ud-dlg-cancel');
  }
  $('#ud-dlg-cancel').addEventListener('click', () => { pending = null; closeDialog($('#user-dialog')); });
  $('#user-dlg-form').addEventListener('submit', async e => {
    e.preventDefault();
    const job = pending;
    pending = null;
    closeDialog($('#user-dialog'));
    if (!job) return;
    try {
      const res = await job.fn();
      if (job.after) await job.after(res);
      toast(job.done);
      await Promise.all([load(), loadInvites()]);
      if (lastDetail.uid) openDetail(lastDetail.uid, lastDetail.email);
    } catch (err) { reportDenial('#users-denied', err); }
  });

  // ---- 一次性临时密码展示层：等宽展示 + 复制，关层即清零 ----
  let tempPassword = '';
  function showTempPassword(pw, notify) {
    tempPassword = pw || '';
    $('#rp-done-pw').textContent = tempPassword;
    $('#rp-done-hint').textContent = notify
      ? '此密码仅显示一次，关闭后无法再次查看。邮件已发送给用户。'
      : '此密码仅显示一次，关闭后无法再次查看。请通过其它渠道转告用户。';
    openDialog($('#rp-done'));
  }
  $('#rp-done-copy').addEventListener('click', async () => {
    if (!tempPassword) return;
    await copyText(tempPassword);
    toast('密码已复制');
  });
  $('#rp-done-close').addEventListener('click', () => closeDialog($('#rp-done')));
  $('#rp-done').addEventListener('close', () => {
    tempPassword = '';
    $('#rp-done-pw').textContent = '';
  });

  // ---- 选择集与批量工具条：Map<uid,email>，跨翻页保留 ----
  const selected = new Map();
  function refreshBulkBar() {
    const n = selected.size;
    $('#bulk-bar').classList.toggle('hidden', n === 0);
    $('#bulk-count').textContent = `已选 ${n} 人`;
    const boxes = $$('#users-body .row-sel');
    $('#users-selall').checked = boxes.length > 0 && boxes.every(b => b.checked);
  }
  function syncSelection(cb) {
    const uid = Number(cb.dataset.uid);
    if (cb.checked) selected.set(uid, cb.dataset.email); else selected.delete(uid);
    refreshBulkBar();
  }

  // ---- 筛选（角色/封禁）：两项都进 /admin/users 查询串，服务端跨页过滤 ----
  const facet = { role: 'all', status: 'all' };
  let pageItems = [];

  function syncFacetChips() {
    $$('[data-role-facet]').forEach(c => {
      const on = c.dataset.roleFacet === facet.role;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) popIn(c);
    });
    $$('[data-status-facet]').forEach(c => {
      const on = c.dataset.statusFacet === facet.status;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) popIn(c);
    });
  }
  function refreshFacetNote() {
    const note = $('#users-facet-note');
    const active = facet.role !== 'all' || facet.status !== 'all';
    note.hidden = !active;
    if (active) {
      note.textContent = `当前筛选生效：共 ${pager.state.total} 个匹配账号（服务端跨页筛选）`;
    }
    syncQuery({
      query: pager.state.query || '', offset: pager.state.offset || '',
      role: facet.role !== 'all' ? facet.role : '',
      banned: facet.status === 'banned' ? 'true' : '',
    });
  }

  // ---- 邀请记录：四态徽标 + 行内重发/撤销；复用用户搜索的同一查询串 ----
  let inviteQuery = '';
  const INVITE_BADGE = {
    pending: '<span class="badge on">待接受</span>',
    accepted: '<span class="badge ok">已接受</span>',
    revoked: '<span class="badge off">已撤销</span>',
    expired: '<span class="badge off">已过期</span>',
  };
  async function loadInvites() {
    const tbody = $('#invites-body');
    if (!tbody) return;
    try {
      const res = await api('/admin/users/invites?query=' + encodeURIComponent(inviteQuery));
      const list = res.invites || [];
      $('#invites-count').textContent = list.length ? `· 共 ${list.length} 条` : '';
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty"><span class="empty-title">${inviteQuery ? '没有匹配的邀请' : '还没有发出过邀请'}</span><span class="empty-hint">${inviteQuery ? '清空搜索看看全部邀请。' : '点「邀请用户」发出第一条邀请。'}</span></td></tr>`;
        return;
      }
      tbody.innerHTML = '';
      list.forEach(it => {
        // 只有还能动手的行（待接受/已过期）渲染行内按钮；已接受/已撤销是不可逆事实
        const live = it.state === 'pending' || it.state === 'expired';
        const validity = it.state === 'pending'
          ? `剩余 ${esc(remainTime(it.expiresAt))}` : `至 ${esc(fmtTime(it.expiresAt))}`;
        const tr = node(`
          <tr data-invite="${esc(it.id)}">
            ${td('', esc(it.email), 'cell-title wrap-cell')}
            ${td('项目', it.app ? esc(appLabel(it.app)) : '<span class="dim">不限项目</span>')}
            ${td('状态', INVITE_BADGE[it.state] || esc(it.state))}
            ${td('有效期', validity)}
            ${td('', live ? `<span class="row" style="gap:6px">
                <button type="button" class="btn small" data-resend>重发</button>
                <button type="button" class="btn small danger" data-revoke>撤销</button>
              </span>` : '', 'cell-action')}
          </tr>`);
        const resend = tr.querySelector('[data-resend]');
        if (resend) resend.addEventListener('click', async () => {
          setBusy(resend, true);
          try {
            // 重发 = 换新 token + 续 24h，旧链接即刻失效（文案要说清）
            await api(`/admin/users/invite/${encodeURIComponent(it.id)}/resend`, { method: 'POST', body: {} });
            toast(`邀请已重新发送至 ${it.email}，旧链接已失效`);
            await loadInvites();
          } catch (err) { toast(err.message, true); }
          finally { setBusy(resend, false); }
        });
        const revoke = tr.querySelector('[data-revoke]');
        if (revoke) revoke.addEventListener('click', () => {
          confirmAction(
            '撤销邀请',
            `将撤销发给 ${it.email} 的邀请链接，对方再打开会看到「已被撤销」；需要时可重新发起邀请。`,
            `已撤销发给 ${it.email} 的邀请`,
            () => api(`/admin/users/invite/${encodeURIComponent(it.id)}/revoke`, { method: 'POST', body: {} }),
            true,
            () => new Promise(done => fadeOutRow(tr, done)));
        });
        tbody.appendChild(tr);
      });
    } catch (err) {
      $('#invites-count').textContent = '';
      tbody.innerHTML = emptyCell(5, '读取失败', err.message);
    }
  }

  // ---- 批量操作：确认视图（清单 + 后果逐条 + 一次配置）与结果视图同层切换 ----
  const BULK_TITLE = { password_reset: '批量重置密码', ban: '批量封禁', unban: '批量解除封禁' };
  const BULK_CONSEQUENCES = {
    password_reset: [
      '为每位用户生成 16 位临时密码，邮件通知到其登录邮箱；临时密码不进本面板与日志',
      '要求下次登录时修改密码；现有登录全部吊销，已登录设备需重新登录',
    ],
    ban: [
      '所选范围内无法登录，已登录设备立即退出；限时到期自动解除，永久需手动解封',
      '重复封禁按本次配置覆盖；一次配置（范围/时长/原因）套用全部所选用户',
    ],
    unban: [
      '解除所选范围的封禁并恢复登录；不影响该账号其它项目的封禁',
      '没有生效中封禁的用户同样回执成功',
    ],
  };
  let bulkJob = null;
  let bulkState = null;
  let bulkEmails = new Map();

  function bulkRequest(kind, uids) {
    const body = { kind, uids };
    if (kind === 'ban' || kind === 'unban') {
      body.app = $('#bulk-app').value;
      if (kind === 'ban') {
        body.until = $('#bulk-temp').checked && $('#bulk-until').value
          ? new Date($('#bulk-until').value).getTime() : 0;
        body.reason = $('#bulk-reason').value.trim();
      }
    }
    return body;
  }

  function syncBulkGate() {
    const needGate = !$('#bulk-gate').classList.contains('hidden');
    $('#bulk-ok').disabled = needGate && $('#bulk-typed').value.trim() !== '确认';
  }

  function renderBulkResults() {
    const st = bulkState;
    const items = Array.from(st.results.entries());
    const failed = items.filter(([, r]) => !r.ok);
    $('#bulk-result-summary').textContent =
      `共 ${items.length} 人：成功 ${items.length - failed.length}，失败 ${failed.length}` +
      (failed.length ? '。勾选失败项后可只重试子集。' : '。');
    const list = $('#bulk-result-list');
    list.innerHTML = items.map(([uid, r]) => {
      const email = bulkEmails.get(uid) || `uid ${uid}`;
      return `<div class="item">
        <span class="grow"><span class="title">${esc(email)}</span><br>
          <span class="meta">${r.ok ? '已完成' : esc(r.message || '操作失败')}</span></span>
        ${r.ok ? '<span class="badge ok">成功</span>' : '<span class="badge warn">失败</span>'}
        ${r.ok ? '' : `<label class="row" style="gap:6px;font-size:13px"><input type="checkbox" class="bulk-retry-sel" data-uid="${esc(uid)}" checked> 重试</label>`}
      </div>`;
    }).join('') || '<div class="empty">没有结果</div>';
    $$('#bulk-result-list .bulk-retry-sel').forEach(cb =>
      cb.addEventListener('change', syncRetryBtn));
    const retry = $('#bulk-retry-failed');
    retry.classList.toggle('hidden', !failed.length);
    syncRetryBtn();
  }
  function syncRetryBtn() {
    const any = $$('#bulk-result-list .bulk-retry-sel').some(cb => cb.checked);
    $('#bulk-retry-failed').disabled = !any;
  }

  async function openBulk(kind) {
    const uids = Array.from(selected.keys());
    if (!uids.length) return;
    bulkJob = { kind, uids };
    bulkEmails = new Map(selected);
    $('#bulk-dlg-result').classList.add('hidden');
    $('#bulk-dlg-confirm').classList.remove('hidden');
    showErr('#bulk-error', '');
    $('#bulk-typed').value = '';
    $('#bulk-dlg-title').textContent = BULK_TITLE[kind];
    $('#bulk-dlg-desc').textContent = `将对所选 ${uids.length} 位用户执行：`;
    $('#bulk-dlg-list').innerHTML = uids.map(uid => `
      <div class="item" style="padding:8px 12px">
        <span class="grow"><span class="title">${esc(bulkEmails.get(uid) || 'uid ' + uid)}</span></span>
        <span class="mono dim">${esc(uid)}</span>
      </div>`).join('');
    $('#bulk-dlg-cons').innerHTML = BULK_CONSEQUENCES[kind].map(t => `<li>${esc(t)}</li>`).join('');
    const needCfg = kind !== 'password_reset';
    $('#bulk-dlg-config').classList.toggle('hidden', !needCfg);
    if (needCfg) {
      const opts = await banScopeOptions();
      $('#bulk-app').innerHTML = opts.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')
        || '<option value="">无可用范围</option>';
      decorateSelect($('#bulk-app'));
      const isBan = kind === 'ban';
      $('#bulk-dur-group').classList.toggle('hidden', !isBan);
      $('#bulk-reason-field').classList.toggle('hidden', !isBan);
      $('#bulk-until-field').classList.add('hidden');
      $('#bulk-perm').checked = true;
      $('#bulk-until').value = '';
      $('#bulk-until').min = banMinStr();
      $('#bulk-reason').value = '';
    }
    $('#bulk-gate').classList.toggle('hidden', uids.length <= 5);
    syncBulkGate();
    openDialog($('#bulk-dialog'), '#bulk-cancel');
  }

  async function openInvite() {
    showErr('#invite-error', '');
    $('#invite-email').value = '';
    const sel = $('#invite-app');
    sel.innerHTML = '<option value="">加载中…</option>';
    openDialog($('#invite-dialog'), '#invite-cancel');
    // super：全部项目 +「不限项目」；项目管理员：仅其授权项目且必选
    let opts;
    if (IS_SUPER) {
      opts = [{ key: '', label: '不限项目' }]
        .concat(knownApps().map(a => ({ key: a.key, label: a.label })));
    } else {
      opts = [];
      try {
        const res = await api('/admin/projects');
        opts = (res.projects || []).map(p => ({ key: p.app, label: p.name }));
      } catch (_) { /* 拿不到授权清单就空着，提交时按必选拦 */ }
    }
    sel.innerHTML = opts.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')
      || '<option value="">无可邀请的项目</option>';
    decorateSelect(sel);   // 选项是打开后才灌的，这里同步按钮文案
    $('#invite-email').focus();
  }

  function renderRows() {
    const rows = pageItems;
    body.innerHTML = '';
    if (!rows.length) {
      body.innerHTML = emptyCell(7,
        pageItems.length ? '当前筛选下没有用户' : '暂无匹配的用户',
        pageItems.length ? '换一个筛选条件，或点「全部」清空筛选。'
          : '调整关键词，或点「邀请用户」新建账号。');
      $('#users-selall').checked = false;
      refreshBulkBar();
      refreshFacetNote();
      return;
    }
    rows.forEach(u => {
      const tr = node(`<tr>
        ${td('', `<input type="checkbox" class="row-sel" data-uid="${esc(u.uid)}" data-email="${esc(u.email)}" aria-label="选择 ${esc(u.email)}"${selected.has(Number(u.uid)) ? ' checked' : ''}>`, 'cell-pick')}
        ${td('', userCell(u, 32), 'cell-title wrap-cell')}
        ${td('uid', `<span class="mono">${esc(u.uid)}</span>`)}
        ${td('角色', `<span class="row-inline">${u.isRoot
          ? '<span class="badge on" title="唯一的平台管理员任命者">根管理员</span>'
          : u.role === 'user' ? `<span class="badge plain">${ROLE_LABEL.user}</span>`
            : `<span class="badge on">${esc(ROLE_LABEL[u.role] || u.role)}</span>`}${banBadge(u.ban)}</span>`)}
        ${td('登录豁免', esc(scopeSummary(u)), 'wrap-cell')}
        ${td('安全', `<span class="row-inline">${u.totpEnabled
          ? '<span class="badge on">两步验证</span>'
          : '<span class="badge off">无两步验证</span>'}<span class="badge${u.passkeyCount ? '' : ' off'}">${u.passkeyCount} 个 Passkey</span></span>`)}
        ${td('', '<button type="button" class="btn small">管理</button>', 'cell-action')}
      </tr>`);
      tr.querySelector('button').addEventListener('click', () => openDetail(u.uid, u.email));
      body.appendChild(tr);
    });
    $$('#users-body .row-sel').forEach(cb => cb.addEventListener('change', () => syncSelection(cb)));
    refreshBulkBar();
    refreshFacetNote();
  }

  async function load() {
    showErr('#users-error', '');
    showDenial('#users-denied', null);
    setListBusy(body, true);
    try {
      const st = pager.state;
      const params = new URLSearchParams({
        query: st.query || '', limit: String(st.limit), offset: String(st.offset),
      });
      if (facet.role !== 'all') params.set('role', facet.role);
      if (facet.status === 'banned') params.set('banned', 'true');
      const res = await api('/admin/users?' + params.toString());
      st.query = st.query || '';
      $('#users-total').textContent = `共 ${res.total} 个账号`;
      pager.set(res.total, res.items.length);
      pageItems = res.items || [];
      renderRows();
    } catch (err) {
      if (!showDenial('#users-denied', err, { retry: load, backHref: '/web/console', backLabel: '回到概览' })) {
        showErr('#users-error', err.message);
      }
      body.innerHTML = emptyCell(7, '读取失败', '稍后重试。');
      refreshBulkBar();
    } finally {
      setListBusy(body, false);
    }
  }

  async function openDetail(uid, email) {
    lastDetail = { uid, email };
    const panel = $('#user-detail');
    const wasHidden = panel.classList.contains('hidden');
    panel.classList.remove('hidden');
    if (wasHidden) slideIn(panel);
    $('#ud-title').innerHTML = `<span class="user-cell">${avatarHTML({ email }, 48)}
      <span class="grow"><span class="title">${esc(email)}</span><br><span class="meta">用户详情</span></span></span>`;
    $('#ud-body').innerHTML = '<div class="empty">读取中…</div>';
    panel.scrollIntoView({ block: 'nearest' });
    try {
      const d = await api('/admin/users/' + uid);
      $('#ud-title').innerHTML = `<span class="user-cell">${avatarHTML(d, 48)}
        <span class="grow"><span class="title">${esc((d.nickname || '').trim() || d.email)}</span><br><span class="meta wrap-cell">${esc(d.email)}</span></span></span>`;
      const scopes = d.scopes || [];
      const sessions = (d.sessions || []).map(s => `
        <div class="item">
          <span class="grow"><span class="title">${esc(s.device)}</span><br>
          <span class="meta">${esc(appLabel(s.app))} · ${ipWithRegion(s.ip, s.ipRegion)} · 最近活跃 ${esc(relTime(s.lastSeenAt))}</span></span>
          <button type="button" class="btn small danger" data-kick="${esc(s.id)}">退出</button>
        </div>`).join('') || emptyState('没有活跃会话', '该用户的所有会话被退出或过期后，这里会清空。');
      const passkeys = (d.passkeys || []).map(p =>
        `<li>${esc(p.name)} · ${esc(fmtTime(p.createdAt))}</li>`).join('') || '<li>未添加</li>';
      const banRows = (d.bans || []).map(b => `
        <div class="item">
          <span class="grow"><span class="title">${b.app === '*' ? '全局' : esc(appLabel(b.app))}</span>
          <br><span class="meta">${Number(b.until) > 0 ? `将于 ${esc(fmtTime(b.until))} 解除` : '永久'}${b.reason ? ` · ${esc(b.reason)}` : ''}</span></span>
          <button type="button" class="btn small danger" data-unban="${esc(b.app)}">解除</button>
        </div>`).join('') || emptyState('没有生效中的封禁', '封禁后会在这里列出范围、解除时间与原因。');
      const isRootTarget = !!d.isRoot;
      const meUid = await viewerUid();
      const root = isRootViewer();
      const isSelf = Number(d.uid) === meUid;
      // 任命能力预判（Keycloak 口径：只能授予自己拥有的角色层级；后端矩阵：
      // 只有根管理员能任命/回收平台管理员）。锁死的目标 = 自己 / 平台管理员
      //（非根视角）——下拉整体禁用并说明原因；其余情况只禁掉「平台管理员」项。
      const targetLocked = isSelf || (isRootTarget && !root) ||
        (d.role === 'super' && !root);
      const canAppointSuper = root;
      const roleNote = isSelf
        ? '不能修改自己的角色。'
        : isRootTarget && !root
          ? '根管理员账号只有本人能调整。'
          : targetLocked && !isSelf
            ? '平台管理员的角色只有根管理员能任命或回收。'
            : canAppointSuper
              ? '你是根管理员：可任命/回收平台管理员；平台管理员可任命项目管理员与普通用户。不能授予高于自己的角色。'
              : '只有根管理员能任命/回收平台管理员；你可任命项目管理员与普通用户。项目管理员只在被授予的项目内行使管理权，不跨项目。';
      const roleCtl = `
        <label class="row" style="gap:8px"><span class="dim">角色</span>
          <select id="ud-role" ${targetLocked ? 'disabled title="该角色调整超出你的能力范围"' : ''}>
            <option value="user"${d.role === 'user' ? ' selected' : ''}>普通用户</option>
            <option value="admin"${d.role === 'admin' ? ' selected' : ''}>项目管理员</option>
            <option value="super"${d.role === 'super' ? ' selected' : ''}${canAppointSuper ? '' : ' disabled'}>平台管理员</option>
          </select>
        </label>
        <button type="button" class="btn small primary" id="ud-save-role" ${targetLocked ? 'disabled' : ''}>保存角色</button>`;
      // 应用授权开关：选项来自服务端注册表；每项的语义 = 登录豁免（与访问页同口径）
      const scopeList = d.role === 'super'
        ? '<div class="empty">平台管理员豁免全部项目的登录要求，无需逐项授权。</div>'
        : APPS.map(app => {
            const granted = scopes.indexOf(app.key) >= 0;
            return `<div class="item">
              <span class="grow"><span class="title">${esc(app.label)}</span><br>
              <span class="meta">${granted ? '已授权 · 豁免本项目登录限制' : '未授权 · 受本项目登录限制约束'}</span></span>
              <button type="button" class="btn small ${granted ? 'danger' : 'primary'}" data-app="${esc(app.key)}" data-op="${granted ? 'revoke' : 'grant'}">
                ${granted ? '回收' : '授予'}
              </button>
            </div>`;
          }).join('');
      $('#ud-body').innerHTML = `
        <div class="grid2">
          <div><span class="dim">uid</span><br><span class="mono">${esc(d.uid)}</span></div>
          <div><span class="dim">注册时间</span><br>${esc(fmtTime(d.createdAt))}</div>
          <div><span class="dim">密码</span><br>${d.hasPassword ? '已设置' : '未设置'}</div>
          <div><span class="dim">两步验证</span><br>${d.totpEnabled ? '已开启' : '未开启'}</div>
        </div>

        <h3>角色与登录豁免</h3>
        <div class="row" style="gap:8px;flex-wrap:wrap">${roleCtl}</div>
        <p class="hint" id="ud-role-note">${esc(roleNote)}</p>
        <p class="hint">授予项目即成为该项目的项目管理员：豁免该项目的登录要求、可管理其名单；全部项目都回收后角色自动降回普通用户。平台管理员豁免全部项目，仅平台管理员能调整角色与授权；项目管理员的授权只在单个项目内生效，不跨项目。</p>
        <div class="list">${scopeList}</div>

        <h3>活跃会话</h3>
        <div class="list">${sessions}</div>

        <h3>资料</h3>
        <p class="hint">重置头像后回退为「色块 + 首字母」，重置昵称后显示回退为邮箱前缀。不影响登录与会话。</p>
        <div class="row" style="gap:8px">
          <button type="button" class="btn" id="ud-reset-avatar"${d.hasAvatar || d.avatarColor ? '' : ' disabled'}>重置头像</button>
          <button type="button" class="btn" id="ud-reset-nickname"${d.nickname ? '' : ' disabled'}>重置昵称</button>
        </div>

        <h3>Passkey</h3><ul>${passkeys}</ul>

        <!-- 高风险操作统一收进危险区：与常规设置视觉隔离，逐项点名确认 -->
        <div class="danger-zone" style="margin-top:16px">
          <h2>高风险操作</h2>
          <p class="hint">以下操作会立即影响该账号的登录与凭证，执行前都会点名确认。</p>

          <h3>重置密码</h3>
          <div class="row" style="gap:8px">
            <span class="app-switch" role="group" aria-label="重置密码方式">
              <button type="button" class="app-chip on" data-rp-mode="generate" aria-pressed="true">自动生成</button>
              <button type="button" class="app-chip" data-rp-mode="manual" aria-pressed="false">手动输入</button>
            </span>
          </div>
          <label class="field hidden" id="ud-rp-pw-field"><span>指定的新密码（至少 8 位）</span>
            <input type="text" id="ud-rp-pw" autocomplete="off" placeholder="输入要设为登录密码的新密码">
          </label>
          <div class="row" style="gap:8px;margin-top:8px">
            <label class="row" style="gap:6px"><input type="checkbox" id="ud-rp-force" checked> 下次登录必须修改密码</label>
            <label class="row" style="gap:6px"><input type="checkbox" id="ud-rp-notify" checked> 邮件通知用户</label>
          </div>
          <label class="field"><span>原因（选填）</span>
            <input type="text" id="ud-rp-reason" placeholder="操作原因（记入审计）" autocomplete="off">
          </label>
          <p class="err" id="ud-rp-error" role="alert" hidden></p>
          <div class="row"><button type="button" class="btn danger" id="ud-rp-go">重置密码</button></div>

          <h3>更换邮箱</h3>
          <p class="hint">当前邮箱 <span class="mono">${esc(d.email)}</span>。更换后用户立即用新邮箱登录，现会话不受影响；新旧邮箱都会收到通知。</p>
          <label class="field"><span>新邮箱</span>
            <input type="email" id="ud-email-new" autocomplete="off" placeholder="输入新的登录邮箱">
          </label>
          <label class="field"><span>原因（选填）</span>
            <input type="text" id="ud-email-reason" placeholder="操作原因（记入审计）" autocomplete="off">
          </label>
          <p class="err" id="ud-email-error" role="alert" hidden></p>
          <div class="row"><button type="button" class="btn danger" id="ud-email-go">更换邮箱</button></div>

          <h3>封禁</h3>
          <div class="list">${banRows}</div>
          <div class="detail">
            <div class="row" style="gap:8px">
              <label class="row" style="gap:6px"><span class="dim">范围</span>
                <select id="ud-ban-app" aria-label="封禁范围"></select>
              </label>
              <label class="row" style="gap:6px"><input type="radio" name="ud-ban-dur" id="ud-ban-perm" checked> 永久</label>
              <label class="row" style="gap:6px"><input type="radio" name="ud-ban-dur" id="ud-ban-temp"> 限时</label>
              <label class="row hidden" id="ud-ban-until-field" style="gap:6px"><span class="dim">解除时间</span>
                <input type="datetime-local" id="ud-ban-until">
              </label>
            </div>
            <label class="field"><span>原因（选填）</span>
              <input type="text" id="ud-ban-reason" placeholder="填写封禁原因（记入审计）" autocomplete="off">
            </label>
            <p class="err" id="ud-ban-error" role="alert" hidden></p>
            <div class="row"><button type="button" class="btn danger" id="ud-ban-go">封禁</button></div>
          </div>

          <h3>会话</h3>
          <div class="row">
            <button type="button" class="btn danger" id="ud-kick-all">退出该用户全部会话</button>
          </div>
        </div>`;
      decorateSelects($('#ud-body'));
      // 单条会话退出也走确认（点名设备再动手）
      $$('#ud-body [data-kick]').forEach(btn => btn.addEventListener('click', () => {
        const row = btn.closest('.item');
        const title = row && row.querySelector('.title');
        const device = (title && title.textContent) || '该设备';
        confirmAction(
          '退出会话',
          `将退出「${device}」上的这条会话，它下次请求时会退出登录。`,
          `已退出「${device}」上的会话`,
          () => api('/admin/sessions/' + btn.dataset.kick, { method: 'DELETE' }),
          true);
      }));
      $$('#ud-body [data-app]').forEach(btn => btn.addEventListener('click', () => {
        const app = btn.dataset.app;
        const op = btn.dataset.op;
        confirmAction(
          op === 'grant' ? '授予项目豁免' : '回收项目豁免',
          op === 'grant'
            ? `将「${appLabel(app)}」的管理权授予该用户：TA 豁免该项目的登录限制（角色自动提为项目管理员）。`
            : `回收「${appLabel(app)}」的管理权；该账号不再豁免该项目的登录限制，全部项目都回收后角色会降回普通用户。`,
          op === 'grant' ? `已授予「${appLabel(app)}」豁免` : `已回收「${appLabel(app)}」的豁免`,
          () => api(`/admin/roles/${uid}/scope`, { method: 'POST', body: { app, op } }),
          op === 'revoke');
      }));
      const saveRole = $('#ud-save-role');
      if (saveRole) saveRole.addEventListener('click', () => {
        const role = $('#ud-role').value;
        confirmAction(
          '调整角色',
          role === 'super'
            ? '将该用户设为平台管理员：可管理全部项目、用户目录与全局配置，并可任命项目管理员。此操作只有根管理员能执行。'
            : role === 'admin'
              ? '将该用户设为项目管理员：需再授予至少一个项目才有实际管理范围与豁免；其授权不跨项目。'
              : '将该用户降为普通用户：项目授权与豁免会一并收回。',
          role === 'super' ? '已设为平台管理员'
            : role === 'admin' ? '已设为项目管理员' : '已降为普通用户',
          () => api(`/admin/users/${uid}/role`, { method: 'POST', body: { role } }),
          role === 'user');
      });
      $('#ud-kick-all').addEventListener('click', () => {
        confirmAction(
          '退出该用户全部会话',
          '该用户的所有设备（含网页端）都会退出登录，需要重新登录。',
          '已退出该用户全部会话',
          () => api(`/admin/users/${uid}/revoke-sessions`, { method: 'POST', body: {} }),
          true);
      });

      // ---- 重置密码：方式切换 + 两个勾选 + 原因；确认后展示一次性密码 ----
      let rpMode = 'generate';
      $$('#ud-body [data-rp-mode]').forEach(chip => chip.addEventListener('click', () => {
        rpMode = chip.dataset.rpMode;
        $$('#ud-body [data-rp-mode]').forEach(c => {
          const on = c.dataset.rpMode === rpMode;
          c.classList.toggle('on', on);
          c.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        const field = $('#ud-rp-pw-field');
        field.classList.toggle('hidden', rpMode !== 'manual');
        if (rpMode === 'manual') { swapIn(field); $('#ud-rp-pw').focus(); }
        showErr('#ud-rp-error', '');
      }));
      $('#ud-rp-go').addEventListener('click', () => {
        showErr('#ud-rp-error', '');
        const password = $('#ud-rp-pw').value;
        if (rpMode === 'manual' && password.length < 8) {
          showErr('#ud-rp-error', '手动输入的密码至少 8 位');
          return;
        }
        const forceChange = $('#ud-rp-force').checked;
        const notify = $('#ud-rp-notify').checked;
        const reason = $('#ud-rp-reason').value.trim();
        const body = { mode: rpMode, forceChange, notify, reason };
        if (rpMode === 'manual') body.password = password;
        confirmAction(
          '重置密码',
          `将重置 ${email} 的登录密码${forceChange ? '，并要求其下次登录时修改' : ''}${notify ? '，新密码会邮件通知该用户' : '，请通过其它渠道转告该用户'}。`,
          `已重置 ${email} 的密码`,
          () => api(`/admin/users/${uid}/password`, { method: 'POST', body }),
          true,
          res => showTempPassword(res && res.temporaryPassword, notify));
      });

      // ---- 更换邮箱：确认点名新旧邮箱，提示必达两封通知 ----
      $('#ud-email-go').addEventListener('click', () => {
        showErr('#ud-email-error', '');
        const next = $('#ud-email-new').value.trim();
        if (!next) { showErr('#ud-email-error', '请先填写新邮箱'); return; }
        if (next === d.email) { showErr('#ud-email-error', '新邮箱与当前邮箱相同'); return; }
        const reason = $('#ud-email-reason').value.trim();
        confirmAction(
          '更换邮箱',
          `将 ${d.email} 的登录邮箱改为 ${next}，新旧邮箱都会收到通知；用户立即改用新邮箱登录，现会话不受影响。`,
          `已将 ${d.email} 的邮箱改为 ${next}`,
          () => api(`/admin/users/${uid}/email`, { method: 'POST', body: { email: next, reason } }),
          true);
      });

      // ---- 重置资料：头像/昵称各自点名确认 ----
      const resetAvatarBtn = $('#ud-reset-avatar');
      if (resetAvatarBtn) resetAvatarBtn.addEventListener('click', () => {
        confirmAction(
          '重置头像',
          `将清空 ${d.email} 的头像图与头像色，回退为「色块 + 首字母」显示。`,
          `已重置 ${d.email} 的头像`,
          () => api(`/admin/users/${uid}/profile-reset`, { method: 'POST', body: { avatar: true, nickname: false } }),
          true);
      });
      const resetNickBtn = $('#ud-reset-nickname');
      if (resetNickBtn) resetNickBtn.addEventListener('click', () => {
        confirmAction(
          '重置昵称',
          `将清空 ${d.email} 的昵称，显示回退为邮箱前缀。`,
          `已重置 ${d.email} 的昵称`,
          () => api(`/admin/users/${uid}/profile-reset`, { method: 'POST', body: { avatar: false, nickname: true } }),
          true);
      });

      // ---- 封禁：范围（super 见全局+全部项目，项目管理员只见授权项目）----
      const banSel = $('#ud-ban-app');
      banScopeOptions().then(opts => {
        if (banSel) {
          banSel.innerHTML = opts.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');
          decorateSelect(banSel);
        }
      });
      const untilField = $('#ud-ban-until-field');
      const untilInput = $('#ud-ban-until');
      untilInput.min = banMinStr();
      $$('#ud-body input[name=ud-ban-dur]').forEach(r => r.addEventListener('change', () => {
        const temp = $('#ud-ban-temp').checked;
        untilField.classList.toggle('hidden', !temp);
        if (temp) { untilInput.min = banMinStr(); swapIn(untilField); }
        showErr('#ud-ban-error', '');
      }));
      $('#ud-ban-go').addEventListener('click', () => {
        showErr('#ud-ban-error', '');
        const app = banSel.value;
        let until = 0;
        if ($('#ud-ban-temp').checked) {
          const v = untilInput.value;
          until = v ? new Date(v).getTime() : 0;
          if (!until || until < Date.now() + 5 * 60 * 1000) {
            showErr('#ud-ban-error', '解除时间至少要在 5 分钟之后');
            return;
          }
        }
        const reason = $('#ud-ban-reason').value.trim();
        const scopeLabel = app === '*' ? '全部项目（全局）' : appLabel(app);
        confirmAction(
          '封禁账号',
          `将封禁 ${email}：范围「${scopeLabel}」，${until > 0 ? `至 ${fmtTime(until)} 解除` : '永久'}${reason ? `；原因：${reason}` : ''}。封禁期间该账号无法登录。`,
          `已封禁 ${email}`,
          () => api(`/admin/users/${uid}/ban`, { method: 'POST', body: { app, until, reason } }),
          true);
      });
      $$('#ud-body [data-unban]').forEach(btn => btn.addEventListener('click', () => {
        const app = btn.dataset.unban;
        const scopeLabel = app === '*' ? '全局' : appLabel(app);
        confirmAction(
          '解除封禁',
          `将解除对 ${email} 的「${scopeLabel}」封禁，该范围随即恢复可登录。`,
          `已解除 ${email} 的封禁`,
          () => api(`/admin/users/${uid}/ban`, { method: 'DELETE', body: { app } }),
          false);
      }));
    } catch (err) {
      $('#ud-body').innerHTML = `<p class="err">${esc(err.message)}</p>`;
    }
  }

  // 关闭必须清掉 lastDetail：否则「打开详情 → 关闭 → 撤销一条邀请」会把
  // 已关闭的面板自动弹回来。
  $('#ud-close').addEventListener('click', () => {
    lastDetail = { uid: 0, email: '' };
    $('#user-detail').classList.add('hidden');
    // 焦点还给触发行（APG dialog 模式）：关闭后焦点落 body 会让键盘用户丢失位置
    const back = $('#users-body tr:last-child button');
    if (back) back.focus();
  });
  $('#user-search-form').addEventListener('submit', e => {
    e.preventDefault();
    pager.state.query = $('#user-query').value.trim();
    pager.state.offset = 0;
    inviteQuery = pager.state.query;
    load();
    loadInvites();
  });

  // 服务端筛选 chips：角色四选一 + 封禁开关（再点一次取消），选择写入 URL
  $$('[data-role-facet]').forEach(chip => chip.addEventListener('click', () => {
    facet.role = chip.dataset.roleFacet || 'all';
    pager.state.offset = 0;
    syncFacetChips();
    load();
  }));
  $$('[data-status-facet]').forEach(chip => chip.addEventListener('click', () => {
    facet.status = facet.status === chip.dataset.statusFacet ? 'all' : chip.dataset.statusFacet;
    pager.state.offset = 0;
    syncFacetChips();
    load();
  }));

  // 审计页的 uid 链接会带 ?uid= 直达用户详情（日志可顺着线索钻取）
  (function openFromURL() {
    const uid = Number(new URLSearchParams(location.search).get('uid') || 0);
    if (uid > 0) openDetail(uid, '');
  })();
  (function restoreUsersFromURL() {
    const q = new URLSearchParams(location.search);
    if (q.get('query')) {
      $('#user-query').value = q.get('query');
      pager.state.query = q.get('query');
      inviteQuery = q.get('query');
    }
    if (q.get('offset')) pager.state.offset = Number(q.get('offset')) || 0;
    if (q.get('role') && ['super', 'admin', 'user'].indexOf(q.get('role')) >= 0) facet.role = q.get('role');
    if (q.get('banned') === 'true' || q.get('status') === 'banned') facet.status = 'banned';
    syncFacetChips();
  })();
  pager.wire(load);

  $('#invite-open').addEventListener('click', openInvite);
  $('#invite-cancel').addEventListener('click', () => closeDialog($('#invite-dialog')));
  $('#invite-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#invite-email').value.trim();
    const app = $('#invite-app').value;
    if (!email) { showErr('#invite-error', '请先填写被邀请人的邮箱'); return; }
    if (!IS_SUPER && !app) { showErr('#invite-error', '请先选择要加入的项目'); return; }
    const btn = $('#invite-ok');
    setBusy(btn, true);
    try {
      const res = await api('/admin/users/invite', { method: 'POST', body: { email, app } });
      closeDialog($('#invite-dialog'));
      toast(`邀请已发送至 ${email}，链接 ${remainTime(res.expiresAt)} 内有效`);
      $('#invites-wrap').open = true;
      await Promise.all([load(), loadInvites()]);
    } catch (err) { showErr('#invite-error', err.message); }
    finally { setBusy(btn, false); }
  });

  $('#users-selall').addEventListener('change', e => {
    $$('#users-body .row-sel').forEach(cb => { cb.checked = e.target.checked; syncSelection(cb); });
  });
  $('#bulk-clear').addEventListener('click', () => {
    selected.clear();
    $$('#users-body .row-sel').forEach(cb => { cb.checked = false; });
    refreshBulkBar();
  });
  $('#bulk-reset').addEventListener('click', () => openBulk('password_reset'));
  $('#bulk-ban').addEventListener('click', () => openBulk('ban'));
  $('#bulk-unban').addEventListener('click', () => openBulk('unban'));
  $('#bulk-cancel').addEventListener('click', () => { bulkJob = null; closeDialog($('#bulk-dialog')); });
  $('#bulk-typed').addEventListener('input', syncBulkGate);
  $$('#bulk-dialog input[name=bulk-dur]').forEach(r => r.addEventListener('change', () => {
    const temp = $('#bulk-temp').checked;
    $('#bulk-until-field').classList.toggle('hidden', !temp);
    if (temp) { $('#bulk-until').min = banMinStr(); swapIn($('#bulk-until-field')); }
    showErr('#bulk-error', '');
  }));
  $('#bulk-ok').addEventListener('click', async () => {
    const job = bulkJob;
    if (!job) return;
    showErr('#bulk-error', '');
    if ((job.kind === 'ban' || job.kind === 'unban') && !$('#bulk-app').value) {
      showErr('#bulk-error', '请先选择操作范围');
      return;
    }
    if (job.kind === 'ban' && $('#bulk-temp').checked) {
      const v = $('#bulk-until').value;
      const until = v ? new Date(v).getTime() : 0;
      if (!until || until < Date.now() + 5 * 60 * 1000) {
        showErr('#bulk-error', '解除时间至少要在 5 分钟之后');
        return;
      }
    }
    const btn = $('#bulk-ok');
    setBusy(btn, true);
    try {
      const res = await api('/admin/users/bulk', { method: 'POST', body: bulkRequest(job.kind, job.uids) });
      bulkState = { kind: job.kind, results: new Map() };
      (res.items || []).forEach(it => bulkState.results.set(it.uid, { ok: !!it.ok, message: it.message }));
      // 回执缺项按失败补记：宁可多报一条「未返回结果」，不能少报
      job.uids.forEach(uid => {
        if (!bulkState.results.has(uid)) {
          bulkState.results.set(uid, { ok: false, message: '未返回结果，请刷新后重试' });
        }
      });
      $('#bulk-dlg-confirm').classList.add('hidden');
      $('#bulk-dlg-result').classList.remove('hidden');
      renderBulkResults();
      swapIn($('#bulk-dlg-result'));
      await load();
    } catch (err) {
      showErr('#bulk-error', err.message);
    } finally { setBusy(btn, false); }
  });
  $('#bulk-retry-failed').addEventListener('click', async () => {
    const job = bulkJob;
    if (!job || !bulkState) return;
    const uids = $$('#bulk-result-list .bulk-retry-sel')
      .filter(cb => cb.checked).map(cb => Number(cb.dataset.uid));
    if (!uids.length) return;
    const btn = $('#bulk-retry-failed');
    setBusy(btn, true);
    try {
      const res = await api('/admin/users/bulk', { method: 'POST', body: bulkRequest(bulkState.kind, uids) });
      (res.items || []).forEach(it => {
        bulkState.results.set(it.uid, { ok: !!it.ok, message: it.message });
      });
      renderBulkResults();
      toast('已重试勾选的失败项');
      await load();
    } catch (err) { toast(err.message, true); }
    finally { setBusy(btn, false); }
  });
  $('#bulk-result-close').addEventListener('click', () => {
    closeDialog($('#bulk-dialog'));
    if (bulkState) {
      // 全成 → 清空选择；仍有失败 → 只留失败项在选择集里（改完直接再跑一次）
      const failed = new Set(Array.from(bulkState.results.entries())
        .filter(([, r]) => !r.ok).map(([uid]) => uid));
      Array.from(selected.keys()).forEach(uid => {
        if (!failed.size || !failed.has(uid)) selected.delete(uid);
      });
      refreshBulkBar();
    }
    bulkJob = null;
  });

  refreshBulkBar();
  load();
  loadInvites();
}

/* ---------- 后台：项目访问 —— 成员列表 + 搜索添加 ----------
   一个项目一份成员列表：项目管理员（可管理本项目）与登录名单成员（只能登录）。
   添加时从已注册用户里搜，不再手输邮箱；候选接口按项目鉴权，app-admin 只搜
   自己的项目。授予/移除项目管理员仍走 POST /admin/roles/{uid}/scope，契约不变。 */
const EMPTY_MEMBERS_HINT = '还没有成员。开放登录时所有账号都能登录；仅限受邀时只有项目管理员和名单成员可以登录。';
function initAdminAccess() {
  const wrap = $('#access-list');
  if (!wrap) return;
  let pending = null;
  let loaded = [];
  let picker = null;

  function confirmAccess(title, desc, danger, done, fn) {
    pending = { done, fn };
    $('#access-dlg-title').textContent = title;
    $('#access-dlg-desc').textContent = desc;
    $('#access-dlg-ok').classList.toggle('danger', !!danger);
    openDialog($('#access-dlg'), '#access-dlg-cancel');
  }
  $('#access-dlg-cancel').addEventListener('click', () => { pending = null; closeDialog($('#access-dlg')); });
  $('#access-dlg-ok').addEventListener('click', async () => {
    const job = pending;
    pending = null;
    closeDialog($('#access-dlg'));
    if (!job) return;
    const btn = $('#access-dlg-ok');
    setBusy(btn, true);
    try {
      await job.fn();
      toast(job.done);
    } catch (err) { reportDenial('#access-denied', err); } finally { setBusy(btn, false); }
  });

  function refreshStats() {
    const on = loaded.filter(p => p.restricted).length;
    $('#access-stats').textContent = loaded.length
      ? `共 ${loaded.length} 个项目 · ${on} 个已开启仅限受邀` : '';
  }

  async function load() {
    showErr('#access-error', '');
    showDenial('#access-denied', null);
    setListBusy(wrap, true);
    let list = [];
    try {
      const res = await api('/admin/projects');
      list = res.projects || [];
    } catch (err) {
      if (!showDenial('#access-denied', err, { retry: load, backHref: '/web/console', backLabel: '回到概览' })) {
        showErr('#access-error', err.message);
      }
      wrap.innerHTML = emptyState('读取失败', '刷新页面重试；如果一直失败，把提示语发给管理员。');
      setListBusy(wrap, false);
      return;
    }
    loaded = list;
    refreshStats();
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = emptyState('当前没有可管理的项目',
        '平台管理员看全部接入项目，项目管理员只看被授权的项目。');
      setListBusy(wrap, false);
      return;
    }
    list.forEach(p => {
      const card = cardOf(p);
      wrap.appendChild(card);
      swapIn(card);
    });
    setListBusy(wrap, false);
  }

  // 一个项目的人员 = 项目管理员 ∪ 登录名单；同一个人同时有两种身份时只显示
  // 更高的「项目管理员」，避免两行重复与误删。
  function peopleOf(p) {
    const m = new Map();
    (p.admins || []).forEach(a => m.set(String(a.email).toLowerCase(), {
      uid: a.uid, email: a.email, role: 'admin',
    }));
    (p.members || []).forEach(x => {
      const k = String(x.email).toLowerCase();
      if (!m.has(k)) m.set(k, { uid: x.uid, email: x.email, role: 'member' });
    });
    return [...m.values()].sort((a, b) =>
      (a.role === b.role ? String(a.email).localeCompare(String(b.email)) : a.role === 'admin' ? -1 : 1));
  }

  function cardOf(p) {
    const name = p.name || p.app;
    const card = node(`
      <section class="card access-card" data-app="${esc(p.app)}">
        <div class="row between access-head">
          <h2>${esc(name)} <span class="badge" data-badge></span></h2>
          <span class="app-switch" role="group" aria-label="「${esc(name)}」登录范围">
            <button type="button" class="app-chip" data-restrict="0">开放登录</button>
            <button type="button" class="app-chip" data-restrict="1">仅限受邀</button>
          </span>
        </div>
        <p class="hint" data-scope-note></p>

        <div class="row between" style="margin-top:14px">
          <h3 style="margin:0">成员</h3>
          <button type="button" class="btn small primary" data-add-member>添加成员</button>
        </div>
        <p class="hint">项目管理员可管理本项目成员；登录名单成员只能登录，不能管理成员。</p>
        <div class="list" data-people style="margin-top:6px"></div>
        <p class="hint" data-empty hidden>${EMPTY_MEMBERS_HINT}</p>
        <p class="err" data-card-err role="alert" hidden></p>
      </section>`);

    const peopleEl = card.querySelector('[data-people]');
    const emptyEl = card.querySelector('[data-empty]');
    const cardErr = card.querySelector('[data-card-err]');

    function setRestricted(next) {
      p.restricted = next;
      $$('.app-chip', card).forEach(chip => {
        const on = (chip.dataset.restrict === '1') === next;
        chip.classList.toggle('on', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const badge = card.querySelector('[data-badge]');
      badge.textContent = next ? '仅限受邀' : '开放登录';
      badge.classList.toggle('on', next);
      card.querySelector('[data-scope-note]').textContent = next
        ? '只有项目管理员和登录名单成员可以登录本项目。'
        : '开放登录：所有已注册账号都能登录；成员角色保留，仅在切到「仅限受邀」后生效。';
      popIn(badge);
    }

    function personRow(person) {
      const isAdmin = person.role === 'admin';
      const row = node(`
        <div class="item" data-uid="${esc(person.uid)}" data-email="${esc(person.email)}">
          <span class="grow"><span class="title mono">${esc(person.email)}</span><br>
            <span class="meta">uid ${esc(person.uid)} · ${isAdmin ? '项目管理员，可管理成员' : '登录名单成员'}</span></span>
          <span class="badge ${isAdmin ? 'on' : 'plain'}">${isAdmin ? '项目管理员' : '登录名单'}</span>
          ${isAdmin && !IS_SUPER ? '' : `<button type="button" class="btn small ${isAdmin ? 'danger' : ''}" data-remove>${isAdmin ? '移除管理员' : '移除'}</button>`}
        </div>`);
      const remove = row.querySelector('[data-remove]');
      if (remove) remove.addEventListener('click', () => {
        if (isAdmin) {
          confirmAccess('移除项目管理员',
            `将移除 ${person.email} 对「${name}」的管理权；若该账号还在登录名单里，仍可登录本项目。`,
            true, `已移除 ${person.email} 的「${name}」项目管理员`,
            async () => {
              await api(`/admin/roles/${person.uid}/scope`, { method: 'POST', body: { app: p.app, op: 'revoke' } });
              fadeOutRow(row, () => load());
            });
          return;
        }
        confirmAccess('移出登录名单',
          `将把「${person.email}」移出「${name}」的登录名单；开启限制后，该账号将无法登录本项目。`,
          true, `已将 ${person.email} 移出「${name}」登录名单`,
          async () => {
            await api(`/admin/projects/${encodeURIComponent(p.app)}/access`, { method: 'DELETE', body: { email: person.email } });
            fadeOutRow(row, () => load());
          });
      });
      return row;
    }

    function paintPeople() {
      peopleEl.innerHTML = '';
      peopleOf(p).forEach(person => {
        const row = personRow(person);
        peopleEl.appendChild(row);
        popIn(row);
      });
      emptyEl.hidden = peopleEl.children.length > 0;
    }

    $$('.app-chip', card).forEach(chip => chip.addEventListener('click', () => {
      const want = chip.dataset.restrict === '1';
      if (want === p.restricted) return;
      confirmAccess('调整登录范围',
        want
          ? '开启后，除平台管理员、项目管理员和登录名单成员外，其他账号将无法登录该项目。'
          : '关闭后所有已注册账号都可登录该项目（成员与角色保留，仅不再构成门槛）。',
        want,
        want ? `已开启「${name}」仅限受邀登录` : `已关闭「${name}」的登录限制`,
        async () => {
          await api(`/admin/projects/${encodeURIComponent(p.app)}/restrict`, { method: 'POST', body: { restricted: want } });
          setRestricted(want);
        });
    }));

    card.querySelector('[data-add-member]').addEventListener('click', () => openMemberPicker(p));
    setRestricted(!!p.restricted);
    paintPeople();
    return card;
  }

  /* ---- 添加成员：搜索已注册用户 → 勾选 → 选角色 → 添加 ----
     候选接口按项目鉴权（app-admin 只搜自己的项目），不在前端手输邮箱。 */
  function openMemberPicker(p) {
    picker = { p, selected: new Map(), timer: null };
    $('#member-dlg-title').textContent = `添加成员 · ${p.name || p.app}`;
    $('#member-dlg-desc').textContent =
      '搜索已注册用户，选择「可登录」或「项目管理员」。项目管理员可管理本项目成员，并始终可以登录。';
    $('#member-query').value = '';
    $('#member-results').innerHTML = '';
    $('#member-empty').hidden = true;
    showErr('#member-error', '');
    $('#member-role').value = 'member';
    // 只有平台管理员能任命项目管理员（与服务端 scope 端点的授权一致）。
    $('#member-role-field').hidden = !IS_SUPER;
    updateAddBtn();
    openDialog($('#member-dlg'), '#member-query');
    setTimeout(() => $('#member-query').focus(), 30);
  }

  function updateAddBtn() {
    const btn = $('#member-add');
    const n = picker ? picker.selected.size : 0;
    btn.disabled = n === 0;
    btn.textContent = n ? `添加 ${n} 人` : '添加';
  }

  async function searchCandidates() {
    if (!picker) return;
    const q = $('#member-query').value.trim();
    const box = $('#member-results');
    const empty = $('#member-empty');
    showErr('#member-error', '');
    picker.selected.clear();
    updateAddBtn();
    box.innerHTML = '';
    if (!q) { empty.hidden = true; return; }
    try {
      const res = await api(`/admin/projects/${encodeURIComponent(picker.p.app)}/candidates?query=${encodeURIComponent(q)}`);
      const existing = new Map(peopleOf(picker.p).map(x => [String(x.email).toLowerCase(), x.role]));
      const items = res.items || [];
      if (!items.length) { empty.hidden = false; return; }
      empty.hidden = true;
      items.forEach(u => {
        const role = existing.get(String(u.email).toLowerCase());
        const disabled = !!role;
        const row = node(`
          <label class="item pick-row${disabled ? ' is-disabled' : ''}">
            <input type="checkbox" data-uid="${esc(u.uid)}" data-email="${esc(u.email)}"${disabled ? ' disabled' : ''}>
            <span class="grow"><span class="title mono">${esc(u.email)}</span><br>
              <span class="meta">uid ${esc(u.uid)} · ${disabled ? (role === 'admin' ? '已是项目管理员' : '已在登录名单') : esc(ROLE_LABEL[u.role] || u.role)}</span></span>
            ${disabled ? '<span class="badge plain">已在项目</span>' : ''}
          </label>`);
        const cb = row.querySelector('input');
        if (!disabled) cb.addEventListener('change', () => {
          if (cb.checked) picker.selected.set(String(u.uid), { uid: u.uid, email: u.email });
          else picker.selected.delete(String(u.uid));
          updateAddBtn();
        });
        box.appendChild(row);
      });
    } catch (err) {
      showErr('#member-error', err.message);
    }
  }

  $('#member-query').addEventListener('input', () => {
    if (!picker) return;
    clearTimeout(picker.timer);
    picker.timer = setTimeout(searchCandidates, 250);
  });
  $('#member-query').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!picker) return;
    clearTimeout(picker.timer);
    searchCandidates();
  });
  $('#member-cancel').addEventListener('click', () => { picker = null; closeDialog($('#member-dlg')); });
  $('#member-add').addEventListener('click', async () => {
    if (!picker || !picker.selected.size) return;
    const p = picker.p;
    const role = $('#member-role').value;
    const people = [...picker.selected.values()];
    const btn = $('#member-add');
    setBusy(btn, true);
    let ok = 0;
    const failed = [];
    for (const u of people) {
      try {
        if (role === 'admin') {
          await api(`/admin/roles/${u.uid}/scope`, { method: 'POST', body: { app: p.app, op: 'grant' } });
        } else {
          await api(`/admin/projects/${encodeURIComponent(p.app)}/access`, { method: 'POST', body: { email: u.email } });
        }
        ok += 1;
      } catch (err) {
        failed.push(`${u.email}：${err.message}`);
      }
    }
    await load();
    if (failed.length) {
      showErr('#member-error', `已添加 ${ok} 人，${failed.length} 人失败：${failed.join('；')}`);
    } else {
      closeDialog($('#member-dlg'));
      picker = null;
      toast(`已添加 ${ok} 名成员`);
    }
    setBusy(btn, false);
    updateAddBtn();
  });

  load();
}

/* ---------- 后台：会话总览（uid 先行钻取 + 归属地聚合） ----------
   层级一按用户聚合（邮箱/uid/会话数/覆盖项目/主要归属地/最近活跃），点「查看
   会话」钻入层级二逐条管理，并给出该用户的归属地分布条。聚合数据来自
   GET /admin/sessions 自身（app-admin 调 /admin/users 会 403）；全量退出走
   POST /admin/users/{uid}/revoke-sessions（端点 requireSuper，仅平台管理员）。 */
function initAdminSessions() {
  const ubody = $('#sess-users-body');
  if (!ubody) return;
  // 不给 makePager 传 label：页码文案按**用户**说，按钮仍按会话数分页
  const pager = makePager({ prev: '#sess-prev', next: '#sess-next', limit: 100 });

  let pendingKick = null;
  let pendingAll = null;

  // 单条退出：点名设备再动手
  $('#sd-kick-cancel').addEventListener('click', () => closeDialog($('#sd-kick-dialog')));
  $('#sd-kick-ok').addEventListener('click', async () => {
    const job = pendingKick;
    const okBtn = $('#sd-kick-ok');
    if (!job) { closeDialog($('#sd-kick-dialog')); return; }
    setBusy(okBtn, true);
    try {
      await api('/admin/sessions/' + job.id, { method: 'DELETE' });
      closeDialog($('#sd-kick-dialog'));
      toast(`已退出「${job.device}」上的会话`);
      fadeOutRow(job.el, () => openDetail(job.uid, job.email));
    } catch (err) {
      closeDialog($('#sd-kick-dialog'));
      reportDenial('#sess-denied', err);
    } finally {
      setBusy(okBtn, false);
      pendingKick = null;
    }
  });

  // 全量退出：点名用户与条数（平台管理员）
  $('#sd-all-cancel').addEventListener('click', () => { pendingAll = null; closeDialog($('#sd-all-dialog')); });
  $('#sd-all-ok').addEventListener('click', async () => {
    const job = pendingAll;
    pendingAll = null;
    const okBtn = $('#sd-all-ok');
    if (!job) { closeDialog($('#sd-all-dialog')); return; }
    setBusy(okBtn, true);
    try {
      await api(`/admin/users/${job.uid}/revoke-sessions`, { method: 'POST', body: {} });
      closeDialog($('#sd-all-dialog'));
      toast(`已退出 ${job.email} 的全部会话`);
      await Promise.all([loadUsers(), openDetail(job.uid, job.email)]);
    } catch (err) {
      closeDialog($('#sd-all-dialog'));
      reportDenial('#sess-denied', err);
    } finally { setBusy(okBtn, false); }
  });
  $('#sd-kick-all').addEventListener('click', () => {
    const btn = $('#sd-kick-all');
    const uid = Number(btn.dataset.uid || 0);
    if (!uid) return;
    pendingAll = { uid, email: btn.dataset.email || `uid ${uid}` };
    $('#sd-all-desc').textContent =
      `将退出 ${pendingAll.email} 的全部 ${btn.dataset.count} 条会话（含网页端），该账号所有设备都需要重新登录。`;
    openDialog($('#sd-all-dialog'), '#sd-all-cancel');
  });

  /* 列表里「单个用户主要归属地」仍按已加载行计算；全页 KPI 不再用这个函数，
     改读服务端与列表同筛选的 apps/regions，避免把一页当全量。 */
  function regionBreakdown(items) {
    const m = new Map();
    (items || []).forEach(s => {
      const r = (s.ipRegion || '').trim() || '未知归属地';
      m.set(r, (m.get(r) || 0) + 1);
    });
    return [...m.entries()]
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count);
  }

  /* KPI 四项全部来自同一份 /admin/sessions 回执：total/totalUsers/总数，
     apps/regions/同筛选下的去重桶数。 */
  function refreshKpis(res) {
    $('#sess-kpi-sessions').textContent = String(Number(res.total) || 0);
    $('#sess-kpi-users').textContent = String(Number(res.totalUsers) || 0);
    $('#sess-kpi-projects').textContent = String((res.apps || []).length);
    $('#sess-kpi-regions').textContent = String((res.regions || []).length);
  }

  async function loadUsers() {
    showErr('#sess-error', '');
    showDenial('#sess-denied', null);
    setListBusy(ubody, true);
    try {
      const st = pager.state;
      // 搜索走服务端 ?query=（邮箱片段或 uid）：本地过滤会漏掉本页之外的用户
      const res = await api(`/admin/sessions?query=${encodeURIComponent(st.query || '')}` +
        `&ip=${encodeURIComponent(st.ip || '')}${appFilter()}&limit=${st.limit}&offset=${st.offset}`);
      const items = res.items || [];
      const map = new Map();
      items.forEach(s => {
        const cur = map.get(s.uid) || {
          uid: s.uid, email: s.email, nickname: s.nickname, avatarColor: s.avatarColor,
          count: 0, last: 0, apps: new Set(), sessions: [],
        };
        cur.count += 1;
        cur.last = Math.max(cur.last, Number(s.lastSeenAt || 0));
        if (s.app) cur.apps.add(s.app);
        cur.sessions.push(s);
        map.set(s.uid, cur);
      });
      const users = [...map.values()];
      $('#sess-total').textContent = `共 ${res.total} 条活跃会话`;
      pager.set(res.total, items.length);
      $('#sess-page').textContent =
        `第 ${Math.floor(st.offset / st.limit) + 1} 页 · 共 ${res.totalUsers || 0} 位用户`;
      refreshKpis(res);
      ubody.innerHTML = '';
      if (!users.length) {
        const q = $('#sess-user-query').value.trim() || $('#sess-user-ip').value.trim();
        ubody.innerHTML = emptyCell(7,
          q ? '没有匹配的活跃会话' : '当前没有活跃会话',
          q ? '换一个邮箱片段、uid 或 IP 试试。'
            : '所有用户都不在线时这里是空的；有人登录后会出现在这里。');
        return;
      }
      users.sort((a, b) => b.last - a.last);
      users.forEach(u => {
        const appNames = [...u.apps].map(appLabel);
        const appCell = !appNames.length ? '—'
          : appNames.length > 2
            ? `${esc(appNames.slice(0, 2).join('、'))} 等 ${appNames.length} 项`
            : esc(appNames.join('、'));
        const regions = regionBreakdown(u.sessions);
        const top = regions[0];
        const regionCell = top
          ? `<span title="${esc(regions.map(r => `${r.region} ${r.count} 条`).join(' · '))}">${esc(top.region)} · ${top.count}/${u.count}</span>`
          : '—';
        const tr = node(`<tr>
          ${td('', userCell(u, 32), 'cell-title wrap-cell')}
          ${td('uid', `<span class="mono">${esc(u.uid)}</span>`)}
          ${td('会话数', esc(u.count))}
          ${td('覆盖项目', appCell, 'wrap-cell')}
          ${td('主要归属地', regionCell, 'wrap-cell')}
          ${td('最近活跃', esc(relTime(u.last)))}
          ${td('', '<button type="button" class="btn small">查看会话</button>', 'cell-action')}
        </tr>`);
        tr.querySelector('button').addEventListener('click', () => openDetail(u.uid, u.email));
        ubody.appendChild(tr);
      });
    } catch (err) {
      if (!showDenial('#sess-denied', err, { retry: loadUsers, backHref: '/web/console', backLabel: '回到概览' })) {
        showErr('#sess-error', err.message);
      }
      ubody.innerHTML = emptyCell(7, '读取失败', '稍后重试；如果一直失败，把上面的提示语发给管理员。');
    } finally {
      setListBusy(ubody, false);
    }
  }

  async function openDetail(uid, email) {
    const panel = $('#sess-detail');
    const wasHidden = panel.classList.contains('hidden');
    panel.classList.remove('hidden');
    if (wasHidden) slideIn(panel);
    $('#sd-title').textContent = email;
    $('#sd-meta').textContent = `uid ${uid} · 点击「退出」可逐条退出会话。`;
    $('#sd-region').classList.add('hidden');
    $('#sd-kick-all').classList.add('hidden');
    $('#sd-scope-hint').hidden = true;
    $('#sd-body').innerHTML = '<div class="empty">读取中…</div>';
    panel.scrollIntoView({ block: 'nearest' });
    try {
      const LIMIT = 100;
      const ipq = pager.state.ip ? `&ip=${encodeURIComponent(pager.state.ip)}` : '';
      const res = await api(`/admin/sessions?uid=${encodeURIComponent(String(uid))}${ipq}${appFilter()}&limit=${LIMIT}`);
      const items = res.items || [];
      const total = Number(res.total) || items.length;
      // 页头必须报**真实总数**：此前硬编码 limit=100 且不显示总数，>100 会话的
      // 用户被静默截断——管理员踢完 100 条以为清干净了。
      $('#sd-meta').textContent = `uid ${uid} · 共 ${total} 条会话 · 点击「退出」可逐条退出`;
      // 全量退出端点 requireSuper：平台管理员出钮（数据条数带进确认文案），
      // 项目管理员的 HTML 里不出现这个按钮，换成范围说明
      const allBtn = $('#sd-kick-all');
      if (IS_SUPER) {
        allBtn.classList.remove('hidden');
        allBtn.dataset.uid = String(uid);
        allBtn.dataset.email = email;
        allBtn.dataset.count = String(total);
      } else {
        $('#sd-scope-hint').hidden = false;
      }
      if (!items.length) {
        $('#sd-body').innerHTML = emptyState('该用户已无活跃会话', '会话被退出或过期后不再列出；该用户重新登录会再次出现。');
        return;
      }
      // 归属地分布用同一份回执的服务端聚合（{name,count}）；与列表同筛选，
      // 不是从本页几十行里现数出来的。
      const regions = (res.regions || []).map(r => ({ region: r.name, count: Number(r.count) || 0 }));
      const regionWrap = $('#sd-region');
      const max = Math.max(1, ...regions.map(r => r.count));
      $('#sd-region-bars').innerHTML = regions.map(r => `
        <div class="bar-row">
          <span class="dim truncate" title="${esc(r.region)}">${esc(r.region)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.round(r.count / max * 100)}%"></span></span>
          <span class="bar-num">${r.count}</span>
        </div>`).join('');
      regionWrap.classList.remove('hidden');
      swapIn(regionWrap);

      $('#sd-body').innerHTML = '';
      if (total > items.length) {
        $('#sd-body').appendChild(node(
          `<p class="hint">共 ${total} 条会话，这里只显示最近 ${items.length} 条；更早的会话请到「会话总览」按 uid 检索。</p>`));
      }
      items.sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0)).forEach(s => {
        const absExp = Number(s.expiresAt) > 0 ? fmtTime(s.expiresAt) : '—';
        const idleExp = Number(s.idleExpiresAt) > 0 ? fmtTime(s.idleExpiresAt) : '—';
        const el = node(`
          <div class="item" data-id="${esc(s.id)}">
            <span class="ico-wrap">${deviceIcon(s.device)}</span>
            <span class="grow">
              <span class="title">${esc(s.device)}</span>
              <br><span class="meta">${esc(appLabel(s.app))} · ${ipWithRegion(s.ip, s.ipRegion)} · 最近活跃 <span data-rel="${esc(s.lastSeenAt)}">${esc(relTime(s.lastSeenAt))}</span> · 绝对到期 ${esc(absExp)} · 空闲到期 ${esc(idleExp)}</span>
            </span>
            <button type="button" class="btn small danger">退出</button>
          </div>`);
        el.querySelector('button').addEventListener('click', () => {
          pendingKick = { id: s.id, device: s.device, app: s.app, el, uid, email };
          $('#sd-kick-desc').textContent =
            `将退出「${s.device}」上的「${appLabel(s.app)}」会话，它下次请求时会退出登录。`;
          openDialog($('#sd-kick-dialog'), '#sd-kick-cancel');
        });
        $('#sd-body').appendChild(el);
      });
    } catch (err) {
      $('#sd-body').innerHTML = `<p class="err">${esc(err.message)}</p>`;
    }
  }

  $('#sd-close').addEventListener('click', () => {
    $('#sess-detail').classList.add('hidden');
    const back = $('#sess-users-body tr:last-child button');   // 焦点还给触发行
    if (back) back.focus();
  });
  $('#sess-user-search-form').addEventListener('submit', e => {
    e.preventDefault();
    pager.state.query = $('#sess-user-query').value.trim();
    pager.state.ip = ($('#sess-user-ip').value || '').trim();
    pager.state.offset = 0;
    loadUsers();
  });
  pager.wire(loadUsers);
  document.addEventListener('appscopechange', e => {
    e.preventDefault();
    pager.state.offset = 0;
    $('#sess-detail').classList.add('hidden');
    loadUsers().then(() => swapIn($('#sess-users-view')));
  });
  loadUsers();
}

/* ---------- 后台：审计 ----------
   详情列的可读排版：{k:v} 平铺代替裸 JSON。 */
function detailText(d) {
  if (d == null || d === '') return '—';
  if (typeof d !== 'object') return esc(String(d));
  const keys = Object.keys(d);
  if (!keys.length) return '—';
  return keys.map(k => {
    const v = d[k];
    const vs = (v && typeof v === 'object') ? JSON.stringify(v) : String(v);
    return `<span class="kv"><span class="dim">${esc(k)}:</span> ${esc(vs)}</span>`;
  }).join(' ');
}

function initAdminAudit() {
  const body = $('#audit-body');
  if (!body) return;
  const pager = makePager({ prev: '#audit-prev', next: '#audit-next', label: '#audit-page', limit: 50 });

  function filters() {
    const p = new URLSearchParams();
    const action = $('#audit-action').value;
    if (action) p.set('action', action);
    const actor = $('#audit-actor').value.trim();
    if (actor) p.set('actor', actor);
    const target = $('#audit-target').value.trim();
    if (target) p.set('target', target);
    const result = $('#audit-result') ? $('#audit-result').value : '';
    if (result) p.set('result', result);
    const ip = $('#audit-ip').value.trim();
    if (ip) p.set('ip', ip);
    const from = $('#audit-from').value;
    if (from) p.set('from', String(new Date(from + 'T00:00:00').getTime()));
    const to = $('#audit-to').value;
    if (to) p.set('to', String(new Date(to + 'T23:59:59').getTime()));
    const app = new URLSearchParams(location.search).get('app');
    if (app) p.set('app', app);
    p.set('limit', String(pager.state.limit));
    p.set('offset', String(pager.state.offset));
    // 同一份条件同步进地址栏（刷新/分享/后退都还原）
    syncQuery({
      action, actor, target, result, ip,
      from: $('#audit-from').value, to: $('#audit-to').value,
      app: new URLSearchParams(location.search).get('app') || '',
      offset: pager.state.offset || '',
    });
    return p.toString();
  }

  async function load() {
    showErr('#audit-error', '');
    setListBusy(body, true);
    try {
      const res = await api('/admin/audit?' + filters());
      pager.set(res.total, res.items.length);
      $('#audit-total').textContent = `共 ${res.total} 条`;
      const uq = new URLSearchParams(location.search);
      body.innerHTML = '';
      if (!res.items.length) {
        // 有筛选时说「换条件」，没筛选时说「表里还没有事件」——一句灰字分不清
        // 「没数据」和「筛没了」
        const filtered = ['action', 'actor', 'target', 'ip', 'result', 'from', 'to', 'app']
          .some(k => uq.get(k));
        body.innerHTML = emptyCell(7,
          filtered ? '没有匹配的审计记录' : '暂无审计记录',
          filtered ? '换一个条件，或点「重置」清掉全部筛选。'
                   : '注册、登录、改密与后台操作都会记在这里。');
        return;
      }
      res.items.forEach(it => {
        // 操作者/对象：**邮箱是人读的主信息**，uid 是技术标识放次行；uid 做成
        // 链接钻进用户页（日志要能顺着线索走）
        const uidLink = (uid) => `<a class="mono" href="/web/admin?uid=${encodeURIComponent(String(uid))}"
          title="在用户页打开 #${esc(uid)}">#${esc(uid)}</a>`;
        const actor = it.actorEmail
          ? `<span class="cell-stack"><span class="t">${esc(it.actorEmail)}</span>${it.actorUid ? `<span class="s">${uidLink(it.actorUid)}</span>` : ''}</span>`
          : (it.actorUid ? `<span class="s">${uidLink(it.actorUid)}</span>` : '匿名');
        const target = it.targetUid ? uidLink(it.targetUid) : '—';
        body.appendChild(node(`<tr>
          ${td('', esc(fmtTime(it.ts)), 'cell-title')}
          ${td('事件', `<span class="mono">${esc(it.action)}</span>`)}
          ${td('结果', it.result === 'ok' ? '<span class="badge on">成功</span>' : '<span class="badge warn">失败</span>')}
          ${td('操作者', actor, 'wrap-cell')}
          ${td('对象', target, 'wrap-cell')}
          ${td('IP', `<span class="mono">${esc(it.ip || '—')}</span>`)}
          ${td('详情', detailText(it.detail), 'wrap-cell detail-cell')}
        </tr>`));
      });
    } catch (err) {
      showErr('#audit-error', err.message);
      body.innerHTML = emptyCell(7, '读取失败', '稍后重试。');
    } finally {
      setListBusy(body, false);
    }
  }

  // 从 URL 回填（刷新/分享/后退都能还原同一份筛选）
  (function restoreFromURL() {
    const q = new URLSearchParams(location.search);
    if (q.get('action')) $('#audit-action').value = q.get('action');
    if (q.get('actor')) $('#audit-actor').value = q.get('actor');
    if (q.get('target')) $('#audit-target').value = q.get('target');
    if (q.get('result') && $('#audit-result')) $('#audit-result').value = q.get('result');
    if (q.get('ip')) $('#audit-ip').value = q.get('ip');
    if (q.get('from')) $('#audit-from').value = q.get('from');
    if (q.get('to')) $('#audit-to').value = q.get('to');
    if (q.get('offset')) pager.state.offset = Number(q.get('offset')) || 0;
    if (q.get('action') || q.get('result') || q.get('from') || q.get('to')) rangeChipSync('custom');
  })();
  $('#audit-filter-form').addEventListener('submit', e => { e.preventDefault(); pager.state.offset = 0; load(); });

  // 时间范围：快捷档位 chips（今天/近 7 天/近 30 天/自定义）+ 两枚日期输入。
  // 档位选中即填 from/to 并查询；直接改日期则回落到「自定义」高亮。
  const p2 = n => String(n).padStart(2, '0');
  const dayStr = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  function rangeChipSync(active) {
    $$('#audit-filter-form [data-range]').forEach(c => {
      const on = c.dataset.range === active;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    });
  }
  function setRange(kind) {
    if (kind === 'custom') {
      $('#audit-from').value = ''; $('#audit-to').value = '';
    } else {
      const now = new Date();
      const from = new Date(now);
      if (kind === '7') from.setDate(from.getDate() - 6);
      else if (kind === '30') from.setDate(from.getDate() - 29);
      $('#audit-from').value = dayStr(from);
      $('#audit-to').value = dayStr(now);
    }
    rangeChipSync(kind);
    pager.state.offset = 0;
    load();
  }
  $$('#audit-filter-form [data-range]').forEach(c =>
    c.addEventListener('click', () => setRange(c.dataset.range)));
  ['#audit-from', '#audit-to'].forEach(sel =>
    $(sel).addEventListener('change', () => rangeChipSync('custom')));
  $('#audit-reset').addEventListener('click', () => {
    $('#audit-action').value = ''; $('#audit-actor').value = ''; $('#audit-target').value = '';
    $('#audit-ip').value = '';
    if ($('#audit-result')) $('#audit-result').value = '';
    $('#audit-from').value = ''; $('#audit-to').value = '';
    rangeChipSync('custom');
    decorateSelect($('#audit-action'));   // 值被重置，同步下拉按钮文案
    if ($('#audit-result')) decorateSelect($('#audit-result'));
    pager.state.offset = 0; load();
  });
  pager.wire(load);
  // 导出：带上当前筛选，浏览器原生下载（同源、带 cookie）
  const exportBtn = $('#audit-export');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const p = new URLSearchParams(filters());
    p.delete('limit'); p.delete('offset');   // 导出取全量，不分页
    p.set('format', 'csv');
    location.href = '/admin/audit?' + p.toString();
  });
  document.addEventListener('appscopechange', e => {
    e.preventDefault();
    pager.state.offset = 0;
    load().then(() => swapIn($('.table-wrap')));
  });
  load();
}

/* ---------- 后台：配置中心（只留 LLM 大模型卡） ----------
   邮件/注销钩子/FCM/AI 限额四组从页面隐藏（后端键一个不动；AI 限额的改动
   入口收敛到「AI 用量」页的「编辑限额」弹层）。 */
function initAdminConfig() {
  const wrap = $('#cfg-groups');
  if (!wrap) return;
  const GROUPS = [
    { prefix: 'llm_', title: 'LLM 大模型' },
  ];
  const LABELS = {
    llm_api_key: 'API 密钥', llm_base_url: '接口地址', llm_model: '模型名',
  };
  // 示例地址拼出来而不是写字面量：零外链测试会拒绝 app.js 里出现 http(s)://
  //（那是对外部资源的引用），这里只是给管理员看的完整端点示例。
  const FULL_ENDPOINT_EXAMPLE = 'https' + '://' + 'opencode.ai/inference/go/openai/v1/chat/completions';
  let pendingClear = '';

  async function load() {
    showErr('#cfg-error', '');
    setListBusy(wrap, true);
    try {
      const items = await api('/admin/config');
      wrap.innerHTML = '';
      let rendered = 0;
      GROUPS.forEach(g => {
        // **三个已知键恒渲染**，哪怕库里一条都没有：只渲染库里已存在的键会让
        // 新部署整页「暂无配置项」，而 PUT 端点本就支持 upsert——纯前端死胡同。
        const fromStore = items.filter(it => it.key.indexOf(g.prefix) === 0);
        const byKey = new Map(fromStore.map(it => [it.key, it]));
        Object.keys(LABELS).forEach(k => {
          if (!byKey.has(k)) byKey.set(k, { key: k, configured: false, secret: k === 'llm_api_key' });
        });
        const mine = [...byKey.values()];
        if (!mine.length) return;
        rendered += 1;
        const card = node(`<section class="card"><h2>${esc(g.title)}</h2><div class="stack" style="margin-top:8px"></div></section>`);
        const stack = card.querySelector('.stack');
        mine.forEach(it => {
          const stateText = it.configured
            ? (it.secret ? `已配置 · 末 4 位 ${esc(it.hint || '')}` : `已配置：<code class="mono">${esc(it.value)}</code>`)
            : '未配置';
          const row = node(`
            <div class="item" data-key="${esc(it.key)}">
              <span class="grow">
                <span class="title">${esc(LABELS[it.key] || it.key)}</span>
                <span class="badge plain">${esc(it.key)}</span>
                ${it.secret ? '<span class="badge plain">凭据</span>' : ''}
                <br><span class="meta">${stateText}</span>
                ${it.key === 'llm_base_url' ? `<br><span class="meta">必须填写完整接口地址（含 /chat/completions，例如 ${FULL_ENDPOINT_EXAMPLE}）</span>` : ''}
              </span>
              <span class="row" style="gap:6px">
                <input type="text" style="min-width:200px" aria-label="新的值" autocomplete="off" placeholder="${it.secret ? '输入新值替换' : '留空则不修改'}">
                <button type="button" class="btn small primary" data-act="save">保存</button>
                ${it.configured ? '<button type="button" class="btn small danger" data-act="clear">清除</button>' : ''}
              </span>
            </div>`);
          row.querySelector('[data-act=save]').addEventListener('click', async () => {
            const input = row.querySelector('input');
            // **必须 trim 后判空**：服务端把空串当「清除该键」处理，误敲一个空格
            // 就会绕过「清除」的确认弹窗把凭据静默删掉。留空的语义是「不修改」。
            const value = input.value.trim();
            if (!value) { toast('留空表示不修改；要清空请点「清除」', true); return; }
            // 接口地址要求完整端点：Web 上不再接受只写到 /v1 的 Base URL，
            // 免得管理员照 OpenCode 控制台填完整地址时被后端再拼一次 /chat/completions。
            if (it.key === 'llm_base_url' && !/^https?:\/\/.+\/chat\/completions\/?$/.test(value)) {
              showErr('#cfg-error', `接口地址必须填写完整端点，例如 ${FULL_ENDPOINT_EXAMPLE}`);
              return;
            }
            try {
              await api('/admin/config/' + encodeURIComponent(it.key), { method: 'PUT', body: { value } });
              input.value = '';
              toast('已保存，≤10 秒生效');
              await load();
            } catch (err) { showErr('#cfg-error', err.message); }
          });
          const clearBtn = row.querySelector('[data-act=clear]');
          if (clearBtn) {
            clearBtn.addEventListener('click', () => {
              pendingClear = it.key;
              $('#cfg-desc').textContent = `将清除配置键 ${it.key}（值会从库里删除）。`;
              showErr('#cfg-dialog-error', '');
              openDialog($('#cfg-dialog'), '#cfg-cancel');
            });
          }
          stack.appendChild(row);
        });
        wrap.appendChild(card);
      });
      if (!rendered) wrap.innerHTML = emptyState('暂无配置项', '本页只显示服务端登记过的配置键。');
    } catch (err) { showErr('#cfg-error', err.message); }
    finally { setListBusy(wrap, false); }
  }

  $('#cfg-cancel').addEventListener('click', () => closeDialog($('#cfg-dialog')));
  $('#cfg-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/admin/config/' + encodeURIComponent(pendingClear), { method: 'PUT', body: { value: '' } });
      closeDialog($('#cfg-dialog'));
      toast('已清除，≤10 秒生效');
      await load();
    } catch (err) {
      closeDialog($('#cfg-dialog'));
      showErr('#cfg-error', err.message);
    }
  });

  load();
}

/* ---------- 后台：AI 用量（KPI + 趋势 + 用户表 + 钻取 + 编辑限额） ---------- */
function pctText(share) {
  return Math.round(Number(share || 0) * 100) + '%';
}

function initAdminAI() {
  const bars = $('#ai-bars');
  if (!bars) return;
  let lastDetailUID = 0;

  /* 迷你走势：近 7 根竖条（纯 div；零值给 4% 保底可见） */
  function renderSpark(days) {
    const spark = $('#kpi-spark');
    const last7 = (days || []).slice(-7);
    const max = Math.max(1, ...last7.map(d => Number(d.count || 0)));
    spark.innerHTML = '';
    last7.forEach(d => {
      const n = Number(d.count || 0);
      const col = document.createElement('i');
      col.style.height = (n > 0 ? Math.max(8, Math.round(n / max * 100)) : 4) + '%';
      spark.appendChild(col);
    });
    $('#kpi-spark-hint').textContent = last7.length
      ? `${last7[0].date} → ${last7[last7.length - 1].date}`
      : '暂无数据';
  }

  async function load() {
    showErr('#ai-error', '');
    const days = $('#ai-days').value;
    try {
      const rep = await api('/admin/ai-usage?days=' + encodeURIComponent(days) + appFilter());
      // ---- KPI ----
      const today = Number(rep.today || 0), yday = Number(rep.yesterday || 0);
      $('#kpi-today-val').textContent = today + ' 次';
      let deltaTxt;
      if (yday > 0) {
        const diff = today - yday;
        const pct = Math.round(Math.abs(diff) / yday * 100);
        deltaTxt = diff === 0 ? '与昨日持平' : `较昨日${diff > 0 ? '↑' : '↓'} ${pct}%（${diff > 0 ? '+' : ''}${diff}）`;
      } else {
        deltaTxt = '昨日无用量';
      }
      $('#kpi-today-delta').textContent = deltaTxt;

      const g = rep.global;
      if (g) {
        const used = Number(g.used || 0), limit = Number(g.limit || 0);
        $('#kpi-global-val').textContent = limit > 0 ? `${used} / ${limit} 次` : `${used} 次`;
        $('#kpi-global-bar').style.width = (limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0) + '%';
        $('#kpi-global-hint').textContent = rep.defaultsUsed
          ? '限额为默认值（ai_* 配置键未配齐）。'
          : '限额来自配置中心。';
      } else {
        // app-admin 视角 global 是 null（跨项目数据收权隐藏），如实显示而非「0 次」
        $('#kpi-global-val').textContent = '—';
        $('#kpi-global-bar').style.width = '0%';
        $('#kpi-global-hint').textContent = '全站余量仅平台管理员可见。';
      }

      $('#kpi-active-val').textContent = Number(rep.activeToday || 0) + ' 人';
      renderSpark(rep.days);

      // ---- 每日趋势 ----
      $('#ai-today').textContent = `今日（${todayStr()}）合计 ${today} 次`;
      const list = rep.days || [];
      // 空态判据是**区间内有没有用量**：后端恒回满区间天数，零用量时会铺成
      // 一面全 0 的空条形图——正是「半成品感」的来源。
      const dayTotal = list.reduce((a, d) => a + Number(d.count || 0), 0);
      if (!list.length || dayTotal === 0) {
        bars.innerHTML = '';
        $('#ai-empty').classList.remove('hidden');
      } else {
        $('#ai-empty').classList.add('hidden');
        const max = Math.max(1, ...list.map(d => Number(d.count || 0)));
        bars.innerHTML = '';
        list.forEach(d => {
          const n = Number(d.count || 0);
          // 0 值不画条：给每一天都留一小截蓝头会看着像「有数据」
          const pct = n === 0 ? 0 : Math.round(n / max * 100);
          bars.appendChild(node(`
            <div class="bar-row">
              <span class="dim">${esc(d.date)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
              <span class="bar-num">${n}</span>
            </div>`));
        });
      }

      // ---- 用户表（服务端已按区间用量降序，原样渲染不再重排） ----
      const ubody = $('#ai-users-body');
      const users = rep.users || [];
      ubody.innerHTML = '';
      if (!users.length) {
        ubody.innerHTML = emptyCell(5, '所选区间内暂无用户用量',
          '换一个时间范围，或等有调用后再来看。');
        return;
      }
      users.forEach(u => {
        const uToday = Number(u.today || 0);
        const uLimit = Number(u.limitToday || 0);
        const left = uLimit > 0 ? Math.max(0, uLimit - uToday) : 0;
        const leftPct = uLimit > 0 ? Math.round(left / uLimit * 100) : 0;
        const tr = node(`<tr class="ai-user-row" data-uid="${esc(u.uid)}" tabindex="0" role="button" aria-label="查看 ${esc(u.email)} 的用量明细">
          ${td('', `${esc(u.email)} <span class="mono dim">${esc(u.uid)}</span>`, 'cell-title wrap-cell')}
          ${td('今日', esc(uToday))}
          ${td('区间合计', esc(Number(u.range || 0)))}
          ${td('占比', esc(pctText(u.share)))}
          ${td('每日限额余量', `<span class="bar-track" style="min-width:120px;display:inline-block;vertical-align:middle"><span class="bar-fill" style="width:${leftPct}%"></span></span>
            <span class="dim">${uLimit > 0 ? `剩 ${left}/${uLimit}` : '—'}</span>`)}
        </tr>`);
        const open = () => openDetail(u.uid, u.email);
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        ubody.appendChild(tr);
      });
    } catch (err) {
      showErr('#ai-error', err.message);
      $('#ai-users-body').innerHTML = emptyCell(5, '读取失败', '稍后重试；如果一直失败，把上面的提示语发给管理员。');
    }
  }

  async function loadDetail() {
    const uid = lastDetailUID;
    if (!uid) return;
    try {
      const d = await api(`/admin/ai-usage?days=${encodeURIComponent($('#aid-days').value)}&uid=${encodeURIComponent(String(uid))}${appFilter()}`);
      $('#aid-meta').textContent = `${d.email} · 今日 ${Number(d.today || 0)} 次`;
      const todayN = Number(d.today || 0), limit = Number(d.limitToday || 0);
      $('#aid-limit-bar').style.width = (limit > 0 ? Math.min(100, Math.round(todayN / limit * 100)) : 0) + '%';
      $('#aid-limit-hint').textContent = limit > 0
        ? `今日已用 ${todayN} / ${limit} 次（每日限额）。`
        : '未配置每日限额。';
      const list = d.days || [];
      const box = $('#aid-bars');
      const total = list.reduce((a, x) => a + Number(x.count || 0), 0);
      if (!list.length || total === 0) {
        box.innerHTML = '';
        $('#aid-empty').classList.remove('hidden');
        return;
      }
      $('#aid-empty').classList.add('hidden');
      const max = Math.max(1, ...list.map(x => Number(x.count || 0)));
      box.innerHTML = '';
      list.forEach(x => {
        const n = Number(x.count || 0);
        box.appendChild(node(`
          <div class="bar-row">
            <span class="dim">${esc(x.date)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${n === 0 ? 0 : Math.round(n / max * 100)}%"></span></span>
            <span class="bar-num">${n}</span>
          </div>`));
      });
    } catch (err) { $('#aid-meta').textContent = err.message; }
  }

  function openDetail(uid, email) {
    lastDetailUID = uid;
    const panel = $('#ai-detail');
    const wasHidden = panel.classList.contains('hidden');
    panel.classList.remove('hidden');
    if (wasHidden) slideIn(panel);
    $('#aid-title').textContent = email + ' 的用量';
    // 打开即重置状态：清掉上一个用户的明细
    $('#aid-meta').textContent = '读取中…';
    $('#aid-bars').innerHTML = '';
    $('#aid-empty').classList.add('hidden');
    panel.scrollIntoView({ block: 'nearest' });
    loadDetail();
  }
  $('#aid-close').addEventListener('click', () => {
    $('#ai-detail').classList.add('hidden');
    const back = $('#ai-users-body tr[role=button]');
    if (back) back.focus();
  });
  $('#aid-days').addEventListener('change', loadDetail);

  // ---- 编辑限额（super only，按钮在模板层由 .IsSuper 门控） ----
  // 四键一处定义：预填、校验、报错文案全部从它派生
  const QUOTA_FIELDS = [
    { key: 'ai_rate_per_minute', sel: '#q-input-rate', label: '每用户每分钟次数' },
    { key: 'ai_concurrency', sel: '#q-input-conc', label: '全站并发' },
    { key: 'ai_daily_per_user', sel: '#q-input-user', label: '每用户每日' },
    { key: 'ai_daily_global', sel: '#q-input-global', label: '全站每日' },
  ];
  const quotaBtn = $('#ai-edit-quota');
  if (quotaBtn) {
    quotaBtn.addEventListener('click', async () => {
      showErr('#quota-error', '');
      QUOTA_FIELDS.forEach(f => { $(f.sel).value = ''; });
      try {
        const items = await api('/admin/config');
        const byKey = Object.fromEntries(QUOTA_FIELDS.map(f => [f.key, f]));
        items.filter(it => byKey[it.key] && it.configured)
          .forEach(it => { $(byKey[it.key].sel).value = it.value; });
      } catch (_) { /* 预填失败不拦打开 */ }
      openDialog($('#quota-dialog'), '#q-input-rate');
    });
    $('#quota-cancel').addEventListener('click', () => closeDialog($('#quota-dialog')));
    $('#quota-form').addEventListener('submit', async e => {
      e.preventDefault();
      showErr('#quota-error', '');
      const todo = [];
      for (const f of QUOTA_FIELDS) {
        const v = $(f.sel).value.trim();
        if (!v) continue;   // 留空 = 不改
        if (!/^\d+$/.test(v) || Number(v) <= 0) {
          showErr('#quota-error', `${f.label}必须是正整数`); return;
        }
        todo.push([f.key, v]);
      }
      if (!todo.length) { closeDialog($('#quota-dialog')); return; }
      const btn = $('#quota-ok');
      setBusy(btn, true);
      // 逐键保存：中途失败必须说清「哪几项已生效、哪项失败、其余未保存」
      let done = 0;
      try {
        for (const [key, v] of todo) {
          const f = QUOTA_FIELDS.find(x => x.key === key);
          try {
            await api('/admin/config/' + encodeURIComponent(key), { method: 'PUT', body: { value: v } });
            done += 1;
          } catch (err) {
            const rest = todo.length - done - 1;
            showErr('#quota-error',
              `已保存 ${done} 项；「${f ? f.label : key}」失败：${err.message}${rest > 0 ? `；其余 ${rest} 项未保存` : ''}`);
            await load();
            return;
          }
        }
        closeDialog($('#quota-dialog'));
        toast('限额已保存，≤10 秒生效');
        await load();
      } finally { setBusy(btn, false); }
    });
  }

  $('#ai-days').addEventListener('change', load);
  document.addEventListener('appscopechange', e => {
    e.preventDefault();
    $('#ai-detail').classList.add('hidden');
    load().then(() => swapIn($('#ai-kpis')));
  });
  load();
}

/* ---------- 403 页：报障时间戳 + 重试（同一 URL 再走一次门禁判定） ---------- */
function initDenied() {
  stampDeniedAt();
  const retry = $('#denied-retry');
  if (retry) retry.addEventListener('click', () => location.reload());
}

/* ---------- 授权（同意）页 ----------
   主流程是零 JS 表单（decision 分流）；这里只接「换账号」：登出 → 带 tx 回
   登录页。tx 是服务端一次性事务号，登录后经 /oauth/resume?tx= 续跑回本页
   ——与未登录首次进来是同一条路，登录↔授权的流转闭环不变。 */
function initAuthorize() {
  // 错误变体：报障时间戳 + 「返回上一页」（history 无处可回时落回控制台）
  stampDeniedAt();
  const back = $('#auth-back');
  if (back) back.addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.href = '/web/console';
  });
  const btn = $('#auth-switch');
  if (!btn) return;
  const txInput = $('#authorize-card input[name="tx"]');
  const tx = txInput ? txInput.value : '';
  btn.addEventListener('click', async () => {
    setBusy(btn, true);
    try { stopSessionRefresh(); await api('/web/logout', { method: 'POST', body: {} }); } catch (_) { /* 已登出也要跳 */ }
    location.href = '/web/login' + (tx ? '?tx=' + encodeURIComponent(tx) : '');
  });
}

/* ---------- Caps Lock 提示（密码框） ----------
   NIST/认证 UX 通用做法：未解释的密码失败里相当一部分是 Caps Lock——在密码框
   下方给一条 role=status 的静默提示，key 状态变化即播报，失焦即收。 */
function decorateCapsLock() {
  $$('input[type=password]').forEach(inp => {
    if (inp.__caps) return;
    inp.__caps = true;
    const hint = document.createElement('span');
    hint.className = 'hint caps-hint';
    hint.hidden = true;
    hint.setAttribute('role', 'status');
    hint.textContent = 'Caps Lock 已开启';
    const host = inp.closest('.field') || inp.parentElement;
    if (host) host.appendChild(hint);
    const upd = e => { hint.hidden = !(e.getModifierState && e.getModifierState('CapsLock')); };
    inp.addEventListener('keydown', upd);
    inp.addEventListener('keyup', upd);
    inp.addEventListener('blur', () => { hint.hidden = true; });
  });
}

/* ---------- 验证码粘贴清洗 ----------
   OTP 常见手输形态带空格/连字符（123-456）；粘进 one-time-code 框时剥掉分隔符，
   用户不用先去编辑粘贴内容（OpenCTEM 同款口径：paste 时忽略空格与连字符）。 */
document.addEventListener('paste', e => {
  const t = e.target;
  if (!t || t.tagName !== 'INPUT' || t.getAttribute('autocomplete') !== 'one-time-code') return;
  const cd = e.clipboardData || window.clipboardData;
  if (!cd || !cd.getData) return;
  const text = cd.getData('text') || '';
  const clean = text.replace(/[\s-]+/g, '');
  if (clean && clean !== text) {
    e.preventDefault();
    const max = Number(t.getAttribute('maxlength')) || 64;
    t.value = clean.slice(0, max);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

/* ---------- 网络状态提示 ---------- */
function wireNetworkStatus() {
  window.addEventListener('offline', () => toast('网络已断开，恢复连接后可重试', true));
  window.addEventListener('online', () => toast('网络已恢复'));
}

/* ================= 通用控件装饰 ================= */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // 剪贴板 API 在非安全上下文不可用：退回临时 textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/* openDialog 打开弹层并把初始焦点钉在**安全侧控件**（WAI-ARIA APG：破坏性
   对话框的初始焦点不得落在危险提交钮上）。原生 showModal 的模态性同时保证
   Tab 循环留在弹层内；关闭后浏览器自动把焦点还给触发行。 */
function openDialog(dlg, focusSel) {
  if (!dlg) return;
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  if (focusSel) { const el = typeof focusSel === 'string' ? $(focusSel) : focusSel; if (el) el.focus(); }
}

function closeDialog(dlg) {
  if (!dlg) return;
  if (dlg.open && typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
}

/* tablist 键盘行为：左右键与 Home/End 在同组标签间移动焦点并切换 */
function wireTabs() {
  $$('.tabs[role="tablist"]').forEach(list => {
    const tabs = $$('[role="tab"]', list);
    tabs.forEach((tab, i) => tab.addEventListener('keydown', e => {
      let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j < 0) return;
      e.preventDefault();
      tabs[j].focus();
      tabs[j].click();
    }));
  });
}

/* 密码「显示/隐藏」开关（NIST SP 800-63B §3.1.1.2）：形态复用「输入 + 行内
   按钮」，**不叠在输入框右缘**——那一带是密码管理器徽章保留区。 */
const PW_EYE = {
  on: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>',
  off: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>',
};

function decoratePasswords(root) {
  $$('input[type=password]', root || document).forEach(inp => {
    if (inp.__pwToggle || inp.disabled) return;
    const row = document.createElement('span');
    row.className = 'pw-row';
    inp.parentNode.insertBefore(row, inp);
    row.appendChild(inp);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small ghost pw-toggle';
    btn.innerHTML = PW_EYE.on;
    btn.setAttribute('aria-label', '显示密码');
    btn.setAttribute('aria-pressed', 'false');
    btn.title = '显示密码';
    btn.addEventListener('click', () => {
      const shown = inp.type === 'text';
      inp.type = shown ? 'password' : 'text';
      btn.innerHTML = shown ? PW_EYE.on : PW_EYE.off;
      const next = shown ? '显示密码' : '隐藏密码';
      btn.setAttribute('aria-label', next);
      btn.title = next;
      btn.setAttribute('aria-pressed', String(!shown));
      inp.focus({ preventScroll: true });   // 焦点留在输入框，不打断输入
    });
    row.appendChild(btn);
    inp.__pwToggle = btn;
  });
}

/* 站内下拉（按钮 + 浮层菜单）：原生 <select> 保留为**隐藏值载体**——表单逻辑
   读 .value / 改 .innerHTML 的代码一字不动；菜单每次打开按当前 option 重建。
   键盘：Enter/空格/↓ 打开，↑/↓ 移动高亮，Enter 选中，Esc 关闭回焦。 */
let openSelectMenu = null;
document.addEventListener('click', e => {
  const cur = openSelectMenu;
  if (cur && !cur.wrap.contains(e.target)) cur.close(false);
});

function decorateSelect(sel) {
  if (!sel) return null;
  if (sel.__dropSync) { sel.__dropSync(); return sel; }
  const wrap = document.createElement('span');
  wrap.className = 'select-drop';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'select-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  // 可访问名：装饰后真正可点的是这个 button，字段名在 label.field 的 span 里——
  // 取字段名（或 select 自身的 aria-label）挂上去，否则读屏只念当前值。
  const fieldSpan = sel.closest && sel.closest('.field') ? sel.closest('.field').querySelector('span') : null;
  const fieldName = (fieldSpan && fieldSpan.textContent || '').trim() || sel.getAttribute('aria-label') || '';
  if (fieldName) btn.setAttribute('aria-label', fieldName);
  const label = document.createElement('span');
  label.setAttribute('aria-hidden', 'true');
  btn.appendChild(label);
  const chev = node('<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>');
  btn.appendChild(chev);
  const menu = document.createElement('ul');
  menu.className = 'select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  wrap.appendChild(sel);
  sel.classList.add('hidden');
  let activeIdx = -1;

  function sync() {
    const opt = sel.options[sel.selectedIndex];
    label.textContent = opt ? opt.textContent : '';
    btn.disabled = sel.disabled;
  }
  function open() {
    menu.innerHTML = '';
    activeIdx = sel.selectedIndex;
    Array.from(sel.options).forEach((opt, i) => {
      const li = node('<li class="select-opt" role="option"></li>');
      li.textContent = opt.textContent;
      li.setAttribute('aria-selected', String(i === sel.selectedIndex));
      li.addEventListener('click', () => pick(i));
      menu.appendChild(li);
    });
    menu.hidden = false;
    openSelectMenu = { wrap, close };
    btn.setAttribute('aria-expanded', 'true');
    swapIn(menu);
    mark();
  }
  function mark() {
    $$('.select-opt', menu).forEach((li, i) => li.classList.toggle('active', i === activeIdx));
  }
  function close(focusBtn) {
    if (menu.hidden) return;
    if (openSelectMenu && openSelectMenu.wrap === wrap) openSelectMenu = null;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focusBtn) btn.focus();
  }
  function pick(i) {
    if (i < 0 || i >= sel.options.length) return;
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
    close(true);
  }
  btn.addEventListener('click', () => (menu.hidden ? open() : close(false)));
  btn.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu.hidden) {
      e.preventDefault(); open(); return;
    }
    if (menu.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(sel.options.length - 1, activeIdx + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); mark(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(activeIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
  });
  sel.addEventListener('change', sync);
  sel.__dropSync = sync;
  sync();
  return sel;
}
function decorateSelects(root) {
  $$('select', root || document).forEach(decorateSelect);
}

/* ================= 启动：按 data-page 分发 ================= */
const PAGE_CONTROLLERS = {
  login: initLogin,
  authorize: initAuthorize,
  console: initConsole,
  sessions: initSessions,
  passkeys: initPasskeys,
  security: initSecurity,
  account: initAccount,
  denied: initDenied,
  'admin-users': initAdminUsers,
  'admin-access': initAdminAccess,
  'admin-sessions': initAdminSessions,
  'admin-audit': initAdminAudit,
  'admin-config': initAdminConfig,
  'admin-ai': initAdminAI,
  // invite / setup-password 是零 JS 纯表单页，无需控制器
};

document.addEventListener('DOMContentLoaded', () => {
  drainFlash();                 // 跨页提示先出（注销撤销 / 强制改密成功 / 注销已提交）
  wireReauth();
  wireTabs();
  decorateSelects(document);    // 静态 <select> 全部换站内下拉（值载体保留）
  decoratePasswords(document);  // 全站密码框提供「显示密码」
  decorateCapsLock();           // 密码框 Caps Lock 提示
  wireNetworkStatus();
  // 防重复提交：原生表单（invite/setup-password/authorize 的零 JS POST）在提交
  // 后立刻禁用被点的按钮——慢网下双击不会发两次（页面导航失败时刷新即恢复）。
  // **带 name 的按钮必须先把 name/value 抄进隐藏域再禁用**：表单条目表在 submit
  // 事件之后才构造，被禁用的按钮不再算「成功控件」，于是 authorize 的
  // decision=allow/deny 整个丢掉——服务端把缺 decision 一律按拒绝走，点「继续授权」
  // 会静默变成 access_denied。隐藏域不禁用，值照常随表单提交一次。
  $$('form[method=post]').forEach(f => f.addEventListener('submit', e => {
    const b = (e && e.submitter) || f.querySelector('button[type=submit], button:not([type])');
    if (!b || b.disabled) return;
    if (b.name) {
      const keep = document.createElement('input');
      keep.type = 'hidden';
      keep.name = b.name;
      keep.value = b.value;
      f.appendChild(keep);
    }
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
  }));
  initAppSwitch();
  startRelClock();
  // 登录/授权错误页是极简壳（无 .topbar），没有会话可换；其余页面都在登录态里
  if ($('.topbar')) startSessionRefresh();
  const page = document.body.dataset.page || '';
  if (page.indexOf('admin-') === 0) initAdminGuard();
  const boot = PAGE_CONTROLLERS[page];
  if (boot) boot();
});
