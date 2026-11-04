// ==UserScript==
// @name         SJTU 体育场馆捡漏助手
// @namespace    sjtu-sport-monitor
// @version      1.4.0
// @description  检测校体育场馆的空位（有人取消预约时），自动下单并提醒付款；支持 12:00 抢放号、登录失效自动重登、后台标签页运行
// @author       -
// @match        https://sports.sjtu.edu.cn/pc/*
// @match        https://sports.sjtu.edu.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ 常量 ============================ */

  function showFatal(msg) {
    try {
      if (document.getElementById('ssm-fatal')) return;
      const d = document.createElement('div');
      d.id = 'ssm-fatal';
      d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#c8102e;color:#fff;' +
        'padding:10px 14px;border-radius:10px;max-width:380px;box-shadow:0 6px 24px rgba(0,0,0,.35);' +
        'font:12px/1.6 -apple-system,"PingFang SC",sans-serif;white-space:pre-wrap';
      d.textContent = '⚠️ 捡漏助手启动失败：' + msg;
      (document.body || document.documentElement).appendChild(d);
    } catch (e) { }
  }

  const SLOTS = [
    '07:00-08:00', '08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00',
    '12:00-13:00', '13:00-14:00', '14:00-15:00', '15:00-16:00', '16:00-17:00',
    '17:00-18:00', '18:00-19:00', '19:00-20:00', '20:00-21:00', '21:00-22:00'
  ];
  const WEEK = '0123456';
  const NERV = { 0: '正常', 1: '紧张', 2: '很紧张', 3: '非常紧张', 4: '很紧张(签退)' };
  const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
  const DATE_TTL = 5 * 60 * 1000;

  const DEFAULT_CFG = {
    pollSec: 90,
    mode: 'confirm',       // 'confirm' = 先提醒，等待 N 秒后自动下单； 'direct' = 检测到立即下单
    confirmWaitSec: 300,
    stopWhenDone: true,
    autoOpenPay: true,
    desktopNotify: true,
    soundNotify: true,
    webhook: '',
    autoRelogin: true,     // 登录失效时自动跳转统一身份认证重登
    keepAliveSec: 600,     // 空闲时多久探一次登录态（秒），0=关闭
    renewSec: 14400,       // 主动静默续期间隔（秒），0=关闭；4 小时
    snipe: { enabled: false, leadMs: 1500, windowSec: 25, intervalMs: 400 },
    targets: []
  };

  /* ============================ 存储 ============================ */

  const hasGM = typeof GM_getValue === 'function';
  const store = {
    get(k, d) {
      try {
        const raw = hasGM ? GM_getValue(k, null) : localStorage.getItem(k);
        if (raw === null || raw === undefined || raw === '') return d;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) { return d; }
    },
    set(k, v) {
      const s = JSON.stringify(v);
      try { hasGM ? GM_setValue(k, s) : localStorage.setItem(k, s); } catch (e) { }
    }
  };

  const cfg = Object.assign({}, DEFAULT_CFG, store.get('ssm_cfg', {}));
  if (!Array.isArray(cfg.targets)) cfg.targets = [];
  if (!cfg.snipe || typeof cfg.snipe !== 'object') cfg.snipe = {};
  if (cfg.snipe.enabled === undefined) cfg.snipe.enabled = false;
  if (cfg.snipe.leadMs === undefined) cfg.snipe.leadMs = 1500;
  if (cfg.snipe.windowSec === undefined) cfg.snipe.windowSec = 25;
  if (cfg.snipe.intervalMs === undefined) cfg.snipe.intervalMs = 400;
  const saveCfg = () => store.set('ssm_cfg', cfg);

  /* ============================ 工具 ============================ */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const todayStr = () => ymd(new Date());
  const slotStart = (date, slot) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d, 7 + slot, 0, 0, 0);
  };
  const keyOf = (venueId, typeId, date, slot) => [venueId, typeId, date, slot].join('|');
  const fieldKey = (venueId, typeId) => venueId + '|' + typeId;

  class SessionLost extends Error { constructor() { super('登录已失效'); this.name = 'SessionLost'; } }

  /* ============================ 登录态 ============================ */

  let reloginPending = false;
  let sessEl = null;
  let lastWhoAt = 0;
  let sessState = { ok: null, name: '', at: 0 };

  const AUTH_URL_BASE = 'https://jaccount.sjtu.edu.cn/oauth2/authorize' +
    '?response_type=code&client_id=mB5nKHqC00MusWAgnqSF&state=8&redirect_uri=';

  function authUrl() {
    return AUTH_URL_BASE + encodeURIComponent(location.origin + '/oauth2Login');
  }

  // 当前登录者；未登录返回 null
  async function whoami() {
    try {
      const res = await fetch(location.origin + '/system/user/currentUser',
        { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return null;
      if (res.redirected && /\/login/.test(new URL(res.url).pathname)) return null;
      const j = await res.json();
      const d = j && j.data;
      return (d && (d.userName || d.loginName)) || null;
    } catch (e) { return null; }
  }

  function renderSess() {
    if (!sessEl || !sessEl.isConnected) return;
    if (sessState.ok === null) { sessEl.textContent = '未检查'; sessEl.style.color = ''; return; }
    if (sessState.ok) { sessEl.textContent = '✅ ' + sessState.name; sessEl.style.color = '#2e7d32'; }
    else { sessEl.textContent = '⚠️ 未登录'; sessEl.style.color = '#c62828'; }
  }

  async function checkNow() {
    const name = await whoami();
    sessState = { ok: !!name, name: name || '', at: Date.now() };
    lastWhoAt = Date.now();
    renderSess();
    return name;
  }

  function haltForLogin() {
    S.running = false;
    if (S.timer) { try { WT.clear(S.timer); } catch (e) { } S.timer = null; }
    try { if (snipeTimer) { WT.clear(snipeTimer); snipeTimer = null; } } catch (e) { }
    S.snipeAt = 0;
    try { keepAliveAudio(false); } catch (e) { }
    renderStatus();
  }

  // 登录失效 → 跳统一身份认证。会话还在就秒回，需要的话人工过一次登录，回来自动续监控。
  function relogin(reason) {
    if (reloginPending) return;
    reloginPending = true;
    haltForLogin();
    sessState = { ok: false, name: '', at: Date.now() };
    renderSess();
    // 注意：不写 ssm_running=0 —— 登录回来后靠这个标记自动恢复监控

    if (cfg.autoRelogin === false) {
      log('登录已失效（' + reason + '），自动重登已关闭', 'err');
      notify('登录已失效', '监控已暂停。请在页面上重新登录，然后点「开始监控」。', { kind: 'warn' });
      reloginPending = false;
      return;
    }

    const now = Date.now();
    let n = Number(store.get('ssm_rl_n', '0')) || 0;
    const at = Number(store.get('ssm_rl_at', '0')) || 0;
    if (!at || now - at > 10 * 60 * 1000) n = 0;
    if (n >= 3) {
      store.set('ssm_rl_n', '0');
      log('自动重登连续失败，已停止尝试', 'err');
      notify('登录已失效，自动重登失败', '连续 3 次都没恢复登录。请手动登录一次，回来自动继续监控。', { kind: 'warn' });
      reloginPending = false;
      return;
    }
    store.set('ssm_rl_n', String(n + 1));
    store.set('ssm_rl_at', String(now));

    log('登录已失效（' + reason + '），正在跳转统一身份认证重登（第 ' + (n + 1) + ' 次）', 'warn');
    notify('登录已过期，正在自动重新登录…',
      '若统一身份认证仍在线，几秒后会自动回来继续监控；否则请在跳转后的登录页完成登录。', { kind: 'warn' });
    setTimeout(() => { location.replace(authUrl()); }, 1500);
  }

  // 空闲保活：不开监控时也定期碰一下，让服务端会话不因闲置被回收
  // 主动续期：整页跳一次统一身份认证再被弹回来，等于给两层会话都续了一次命。
  // 放号前后、有 pending 订单时不打扰。
  function maybeRenew() {
    if (!cfg.renewSec || reloginPending || !S.running) return;
    if (S.ordering || Object.keys(S.pending).length) return;
    if (!srvOffset) return;
    const ra = nextReleaseAt();
    if (ra && Math.abs(ra - Date.now()) < 10 * 60 * 1000) return;
    if (Date.now() - (Number(store.get('ssm_renew_at', '0')) || 0) < cfg.renewSec * 1000) return;
    store.set('ssm_renew_at', String(Date.now()));
    log('主动续期：跳一次统一身份认证以延长登录有效期', 'muted');
    location.replace(authUrl());
  }

  function keepAlivePing() {
    if (!cfg.keepAliveSec) return;
    if (S.running || S.ordering || reloginPending) return;
    if (Date.now() - lastWhoAt < Math.max(60, cfg.keepAliveSec) * 1000) return;
    lastWhoAt = Date.now();
    whoami().then(function (name) {
      sessState = { ok: !!name, name: name || '', at: Date.now() };
      renderSess();
    });
  }

  /* ============================ 网络 ============================ */

  async function req(path, opts) {
    opts = opts || {};
    const method = opts.method || 'POST';
    const headers = Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, opts.headers || {});
    const init = { method, credentials: 'include', headers, cache: 'no-store' };

    if (opts.body !== undefined && opts.body !== null) {
      if (opts.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(opts.body).toString();
      } else {
        headers['Content-Type'] = 'application/json;charset=utf-8';
        init.body = JSON.stringify(opts.body);
      }
    }

    const res = await fetch(location.origin + path, init);
    if (res.redirected && /\/login(\?|$|\/)/.test(new URL(res.url).pathname)) throw new SessionLost();
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('json') >= 0) {
      const j = await res.json();
      return j;
    }
    const txt = await res.text();
    if (/^\s*</.test(txt)) throw new SessionLost();
    throw new Error(txt.slice(0, 120) || ('HTTP ' + res.status));
  }

  function mustOK(j, what) {
    if (!j || String(j.code) !== '0') {
      const msg = (j && (j.msg || j.message)) || '未知错误';
      if (String(j && j.code) === '401') throw new SessionLost();
      throw new Error(what + '失败：' + msg);
    }
    return j;
  }

  const api = {
    async venues() {
      const j = mustOK(await req('/manage/venue/list', {
        body: { typeIds: [], campusIds: [], venueName: '', pageNum: 1, pageSize: 200, flag: 1 }
      }), '获取场馆');
      const rows = j.rows || (j.data && j.data.rows) || [];
      return rows.map(r => ({ venueId: r.venueId, venueName: r.venueName, campusName: r.campusName, openTime: r.openTime }));
    },
    async motionTypes(venueId) {
      const j = mustOK(await req('/manage/venue/queryVenueById', { form: true, body: { id: venueId } }), '获取项目');
      const d = j.data || {};
      return {
        venueName: d.venueName, openTime: d.openTime,
        types: (d.motionTypes || []).map(m => ({ id: m.id, name: m.name, tension: String(m.tension), writeOffType: String(m.writeOffType) }))
      };
    },
    async dates(venueId, typeId) {
      const j = mustOK(await req('/manage/fieldDetail/queryFieldReserveSituationIsFull', {
        body: { id: venueId, feildType: typeId, date: todayStr() }
      }), '获取日期');
      return (j.data || []).map(x => ({ date: x.date, dateId: x.dateId }));
    },
    async fields(venueId, typeId, date, dateId) {
      const j = mustOK(await req('/manage/fieldDetail/queryFieldSituation', {
        body: { fieldType: typeId, date, venueId, dateId }
      }), '获取场地');
      return j.data || [];
    },
    async checkRule(venueId, typeId, date, tension) {
      const j = await req('/venue/personal/checkRule', {
        form: true, body: { venueId, venTypeId: typeId, scheduleDate: date, tension }
      });
      const d = j.data || {};
      return { ok: (d.msg || j.msg) === '正常', msg: d.msg || j.msg || '', data: d.data };
    },
    async payUrl(orderId) {
      const j = await req('/venue/personal/orderImmediatelyPC', { form: true, body: { orderId } });
      if (String(j.code) !== '0') return { url: null, msg: j.msg || '' };
      const p = j.data;
      if (p && String(p) !== '3' && p.data) {
        return {
          url: 'https://cwc2.jdcw.sjtu.edu.cn/payment/pay/pay.action?data=' + p.data +
            '&sign=' + p.sign + '&subsysid=' + p.subsysid + '&sysid=' + p.sysid, msg: ''
        };
      }
      return { url: null, msg: '无需支付' };
    },
    async cancelOrder(orderId) {
      const j = await req('/tRefundReceipt/tRefundReceipt/createUserReceipt', { form: true, body: { orderId, type: 2 } });
      return j;
    }
  };

  /* ============================ 加密（复用页面自己的实现） ============================ */

  function getApp() {
    const el = document.getElementById('app');
    return (el && el.__vue__) || null;
  }
  function cryptoMod() {
    const vm = getApp();
    if (!vm || !vm.Aes || !vm.Rsa || typeof vm.Aes.encrypt !== 'function') {
      throw new Error('未找到页面加密模块：请让本标签页停留在 sports.sjtu.edu.cn/pc 下');
    }
    return vm;
  }
  const KEYCHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function randKey() {
    let s = '';
    for (let i = 0; i < 16; i++) s += KEYCHARS[Math.floor(Math.random() * KEYCHARS.length)];
    return s;
  }

  /* ============================ 下单 ============================ */

  async function placeOrder(target, date, slot, cell, field, dateId) {
    const vm = cryptoMod();
    const key = randKey();

    const spaces = [Object.assign({}, JSON.parse(JSON.stringify(cell)), {
      scheduleTime: SLOTS[slot],
      subSitename: field.fieldName,
      subSiteId: field.fieldId,
      tensity: field.fieldDetailStatus,
      venueNum: 1,
      status: 1
    })].map(s => {
      if ('price' in s) { s.venuePrice = s.price; delete s.price; }
      return s;
    });

    const payload = {
      venTypeId: target.typeId,
      venueId: target.venueId,
      fieldType: target.typeName,
      returnUrl: location.protocol + '//' + location.host + '/#/paymentResult/1',
      scheduleDate: date,
      week: WEEK[new Date(date + 'T00:00:00').getDay()],
      spaces: spaces,
      tenSity: NERV[Number(target.tension)] || '正常',
      dateId: dateId
    };

    const body = vm.Aes.encrypt(JSON.stringify(payload), key);
    const res = await fetch(location.origin + '/venue/personal/ConfirmOrder', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
        sid: vm.Rsa.encrypt(key),
        tid: '',
        tim: vm.Rsa.encrypt(String(Date.now()))
      },
      body: body
    });

    if (res.redirected && /\/login/.test(new URL(res.url).pathname)) throw new SessionLost();
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('下单返回异常：' + txt.slice(0, 100)); }

    if (String(j.code) === '0') return j.data;
    if (String(j.code) === '1002') return { __captcha: true };
    if (String(j.code) === '10001') throw new Error('需要先在「我的信息」补全资料');
    throw new Error(j.msg || ('下单失败 code=' + j.code));
  }

  /* ============================ 通知 ============================ */

  let audioCtx = null;
  function beep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      [0, 0.35, 0.7].forEach((t, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = i === 2 ? 1180 : 880;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.28);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(audioCtx.currentTime + t);
        o.stop(audioCtx.currentTime + t + 0.3);
      });
    } catch (e) { }
  }

  /* ---------------- 醒目提醒：顶部横幅 + 标题闪烁 + 循环提示音 ---------------- */
  let ssmBeepTimer = null, ssmTitleTimer = null, ssmAlertUntil = 0, ssmOrigTitle = null;
  let ssmHideTimer = null;

  function ssmBanner() {
    const host = document.getElementById('ssm-host');
    const root = host && host.shadowRoot;
    if (!root) return null;
    let bn = root.querySelector('.ssm-banner');
    if (!bn) {
      bn = document.createElement('div');
      bn.className = 'ssm-banner';
      bn.innerHTML = '<div class="ssm-bt"></div><div class="ssm-bd"></div><button class="ssm-bx">知道了</button>';
      bn.querySelector('.ssm-bx').addEventListener('click', dismissAlert);
      root.appendChild(bn);
    }
    return bn;
  }

  function dismissAlert() {
    ssmAlertUntil = 0;
    if (ssmHideTimer) { clearTimeout(ssmHideTimer); ssmHideTimer = null; }
    if (ssmTitleTimer) { clearInterval(ssmTitleTimer); ssmTitleTimer = null; }
    if (ssmBeepTimer) { clearInterval(ssmBeepTimer); ssmBeepTimer = null; }
    const bn = ssmBanner();
    if (bn) bn.style.display = 'none';
    if (ssmOrigTitle != null) { document.title = ssmOrigTitle; ssmOrigTitle = null; }
  }

  function focusAlert(kind, title, text) {
    const bn = ssmBanner();
    if (bn) {
      bn.className = 'ssm-banner ' + kind;
      bn.querySelector('.ssm-bt').textContent = title;
      bn.querySelector('.ssm-bd').textContent = text;
      bn.style.display = 'flex';
    }
    const dur = kind === 'hit' ? 180000 : kind === 'ok' ? 90000 : 8000;
    ssmAlertUntil = Date.now() + dur;
    if (ssmHideTimer) { clearTimeout(ssmHideTimer); ssmHideTimer = null; }
    ssmHideTimer = setTimeout(() => { if (Date.now() >= ssmAlertUntil) dismissAlert(); }, dur + 60);

    if (kind === 'hit') {
      if (ssmOrigTitle == null) ssmOrigTitle = document.title;
      if (!ssmTitleTimer) {
        let flip = false;
        ssmTitleTimer = setInterval(() => {
          if (Date.now() > ssmAlertUntil) { dismissAlert(); return; }
          flip = !flip;
          document.title = flip ? '🔴 ' + title : (ssmOrigTitle || '');
        }, 900);
      }
      if (cfg.soundNotify && !ssmBeepTimer) {
        beep();
        ssmBeepTimer = setInterval(() => {
          if (Date.now() > ssmAlertUntil) { clearInterval(ssmBeepTimer); ssmBeepTimer = null; return; }
          beep();
        }, 2600);
      }
    }
  }

  /* ---------------- 手机推送 ---------------- */
  // 用户可能粘贴 <https://...>、带引号、或只粘 SCT 开头的 key，这里统一清洗
  function normalizeHook(raw) {
    // 去掉任何位置的空格 / 尖括号 / 引号（<> 常被一起粘进来，URL 里本来也不合法）
    let u = String(raw || '').replace(/[\s<>"'`\uFF1C\uFF1E\u201C\u201D\u2018\u2019]/g, '');
    if (!u) return '';
    if (/^SCT[A-Za-z0-9]+$/.test(u)) return 'https://sctapi.ftqq.com/' + u + '.send';
    if (/^sctapi\.ftqq\.com/i.test(u)) u = 'https://' + u;
    else if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    u = u.replace(/^http:\/\//i, 'https://');
    // Server酱 的地址必须以 .send 结尾
    if (/sctapi\.ftqq\.com/i.test(u) && !/\.send([?#]|$)/i.test(u)) {
      u = u.replace(/^(https?:\/\/sctapi\.ftqq\.com\/[^/?#]+)/i, '$1.send');
    }
    return u;
  }

  // 统一发送 + 把结果回传，这样失败不再是静默的
  function gmSend(o, cb) {
    let fired = false;
    const done = (ok, msg) => {
      if (fired) return;
      fired = true;
      log('推送' + (ok ? '成功' : '失败') + '：' + msg, ok ? 'ok' : 'err');
      try { cb && cb(ok, msg); } catch (e) { }
    };
    try {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest(Object.assign({}, o, {
          timeout: 15000,
          onload: (r) => {
            const txt = String(r.responseText || '').trim();
            let parsed = null;
            try { parsed = JSON.parse(txt); } catch (e) { }
            if (r.status >= 200 && r.status < 300) {
              if (parsed && parsed.code !== undefined && String(parsed.code) !== '0') {
                done(false, (parsed.message || parsed.error || ('code ' + parsed.code)) + '（HTTP ' + r.status + '）');
              } else done(true, 'HTTP ' + r.status + (parsed && parsed.data && parsed.data.pushid ? ' pushid ' + parsed.data.pushid : ''));
            } else done(false, 'HTTP ' + r.status + ' ' + txt.slice(0, 140));
          },
          onerror: () => done(false, '网络错误（域名解析/被墙/离线）'),
          ontimeout: () => done(false, '请求超时'),
          onabort: () => done(false, '请求被中断')
        }));
      } else {
        const nocors = o.mode === 'no-cors';
        fetch(o.url, { method: o.method || 'GET', mode: nocors ? 'no-cors' : 'cors', headers: o.headers, body: o.data })
          .then((r) => done(nocors || r.ok, 'HTTP ' + (r.status || 'opaque')))
          .catch((e) => done(false, e.message));
      }
    } catch (e) { done(false, e.message); }
  }

  function webhook(title, text, link, cb) {
    const url = normalizeHook(cfg.webhook);
    if (!url) { cb && cb(false, '未填写推送地址'); return; }
    const enc = encodeURIComponent;
    const txt = text + (link ? '\n' + link : '');
    if (/api\.day\.app|\bbark\b/i.test(url)) {
      gmSend({
        method: 'POST', url, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ title: title, body: text, group: 'sjtu-sport', level: 'timeSensitive', url: link || '' })
      }, cb);
    } else if (/sctapi\.ftqq\.com|sc\.ftqq\.com/i.test(url)) {
      gmSend({
        method: 'POST', url, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        data: 'title=' + enc(title) + '&desp=' + enc(text + (link ? '\n\n[去付款](' + link + ')' : ''))
      }, cb);
    } else if (/ntfy/i.test(url)) {
      gmSend({
        method: 'POST', url, headers: { Title: enc(title), Priority: 'urgent', Tags: 'rotating_light' },
        data: txt
      }, cb);
    } else if (/qyapi\.weixin\.qq\.com/i.test(url)) {
      gmSend({
        method: 'POST', url, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ msgtype: 'text', text: { content: title + '\n' + txt } })
      }, cb);
    } else if (/open\.feishu\.cn|feishu/i.test(url)) {
      gmSend({
        method: 'POST', url, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ msg_type: 'text', content: { text: title + '\n' + txt } })
      }, cb);
    } else {
      gmSend({
        method: 'POST', url, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ title: title, text: text, body: text, url: link || '' })
      }, cb);
    }
  }

  function pushTest() {
    const url = normalizeHook(cfg.webhook);
    if (!url) { focusAlert('info', '还没填推送地址', '先在输入框里粘贴 Bark / Server酱 / ntfy 的地址'); return; }
    log('正在向 ' + url.replace(/(SCT|day\.app\/)[A-Za-z0-9]+/, '$1***') + ' 发送测试推送…', 'info');
    focusAlert('info', '正在发送测试推送…', '几秒后这里会显示结果，面板日志里也有');
    webhook('【测试】场馆捡漏助手', '如果你在手机上看到这条，说明推送已经通了。\n时间：' + new Date().toLocaleString('zh-CN'), '', (ok, msg) => {
      if (ok) {
        focusAlert('ok', '测试推送已发出 ✅', msg + ' —— 去手机上看一眼；没收到就检查微信是否绑定/App 是否订阅');
        log('如果手机没收到：Server酱 免费额度每天有限，且必须关注并绑定公众号', 'warn');
      } else {
        focusAlert('hit', '测试推送失败 ❌', msg);
        log('常见原因：地址多了 <> 引号 / key 失效 / 当日额度用完 / 未关注公众号', 'warn');
      }
    });
  }

  function notify(title, text, opts) {
    opts = opts || {};
    const kind = opts.kind || 'info';
    log(title + ' — ' + text.replace(/\n/g, ' · '), kind === 'hit' ? 'warn' : kind === 'ok' ? 'ok' : 'info');
    if (cfg.desktopNotify) {
      if (typeof GM_notification === 'function') {
        try {
          GM_notification({
            title: title, text: text, timeout: 20000, silent: true,
            onclick: () => { try { window.focus(); } catch (e) { } }
          });
        } catch (e) { }
      } else if (window.Notification) {
        try {
          if (Notification.permission === 'granted') new Notification(title, { body: text });
          else if (Notification.permission !== 'denied') Notification.requestPermission();
        } catch (e) { }
      }
    }
    focusAlert(kind, title, text);
    if (kind !== 'hit' && cfg.soundNotify) beep();
    webhook(title, text, opts.link);
  }

  /* ============================ 运行状态 ============================ */

  const S = {
    running: false,
    timer: null,
    ticking: false,
    ordering: false,
    lastTickAt: 0,
    lastErr: '',
    pending: {},   // key -> { until, item }
    done: {},      // key -> orderId
    sat: {},       // targetId -> orderId（这个目标已经约到了，别再约）
    pay: [],       // { orderId, url, at, notified5, notified10 }
    logs: []
  };

  function log(msg, kind) {
    const t = new Date();
    S.logs.push({ t: pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()), msg, kind: kind || 'info' });
    if (S.logs.length > 300) S.logs.splice(0, S.logs.length - 300);
    if (ui && uiTab === 'log' && ui.logEl && ui.logEl.isConnected) {
      fillLog(ui.logEl);
      ui.logEl.scrollTop = ui.logEl.scrollHeight;
    }
  }

  /* ============================ 目标展开 ============================ */

  function groups() {
    const map = new Map();
    for (const t of cfg.targets) {
      if (!t || !t.venueId || !t.typeId) continue;
      const k = fieldKey(t.venueId, t.typeId);
      if (!map.has(k)) map.set(k, { venueId: t.venueId, venueName: t.venueName, typeId: t.typeId, typeName: t.typeName, tension: t.tension, targets: [] });
      map.get(k).targets.push(t);
    }
    return [...map.values()];
  }

  function dateList() {
    const out = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 8; i++) {
      const d = new Date(base.getTime() + i * 86400000);
      out.push(ymd(d));
    }
    return out;
  }

  /* ============================ 主循环 ============================ */

  async function tick() {
    if (!S.running || S.ticking) return;
    S.ticking = true;
    const seen = new Set();
    try {
      cryptoMod();  // 提前校验页面环境
      const gs = groups();
      if (!gs.length) { log('没有配置任何目标', 'warn'); }
      let calls = 0;

      for (const g of gs) {
        if (!S.running) break;
        const allDates = await api.dates(g.venueId, g.typeId).catch(err => { throw err; });
        await sleep(rnd(250, 600));
        const byDate = new Map(allDates.map(x => [x.date, x.dateId]));

        const active = g.targets.filter(function (t) { return !S.sat[t.id]; });
        if (!active.length) continue;

        const wantDates = new Set();
        for (const t of active) {
          const ds = Array.isArray(t.dates) && t.dates.length ? t.dates : [...byDate.keys()];
          ds.forEach(d => { if (byDate.has(d)) wantDates.add(d); });
        }

        for (const date of wantDates) {
          if (!S.running) break;
          const dateId = byDate.get(date);
          const fieldList = await api.fields(g.venueId, g.typeId, date, dateId);
          calls++;
          await sleep(rnd(250, 600));

          const wantSlots = new Set();
          for (const t of active) {
            const want = (Array.isArray(t.dates) && t.dates.length && !t.dates.includes(date)) ? false : true;
            if (!want) continue;
            const ss = Array.isArray(t.slots) && t.slots.length ? t.slots : SLOTS.map((_, i) => i);
            ss.forEach(n => wantSlots.add(n));
          }

          for (const field of fieldList) {
            const list = field.priceList || [];
            for (const slot of wantSlots) {
              const cell = list[slot];
              if (!cell) continue;
              if (String(cell.status) !== '0') continue;
              if (Number(cell.count) <= 0) continue;
              if (slotStart(date, slot).getTime() <= Date.now()) continue;

              const k = keyOf(g.venueId, g.typeId, date, slot);
              seen.add(k);
              if (S.done[k]) continue;

              // 哪些还没满足的目标要这个「日期+时段」
              const hits = active.filter(function (t) {
                const okD = !(Array.isArray(t.dates) && t.dates.length) || t.dates.includes(date);
                const okS = !(Array.isArray(t.slots) && t.slots.length) || t.slots.includes(slot);
                return okD && okS && !S.sat[t.id];
              });
              if (!hits.length) continue;

              await onAvailable(k, g, date, slot, cell, field, dateId, hits);
            }
          }
        }
      }

      // 清理掉已经不在的 pending（名额被别人抢了）
      for (const k of Object.keys(S.pending)) {
        if (!seen.has(k)) {
          const p = S.pending[k];
          delete S.pending[k];
          if (!S.done[k]) {
            notify('名额已消失', p.item.target.venueName + ' ' + p.item.target.typeName + ' ' +
              p.item.date + ' ' + SLOTS[p.item.slot] + ' 的空位已经被别人抢走');
          }
        }
      }
      if (!S.lastErr) log('本轮检查完成，请求 ' + calls + ' 次', 'muted');
    } catch (err) {
      S.lastErr = err.message || String(err);
      if (err instanceof SessionLost) {
        relogin('检查空位时发现登录失效');
      } else {
        log('错误：' + S.lastErr, 'err');
      }
    } finally {
      S.ticking = false;
      S.lastTickAt = Date.now();
      renderStatus();
    }
  }

  async function onAvailable(k, g, date, slot, cell, field, dateId, hits) {
    const target = { venueId: g.venueId, venueName: g.venueName, typeId: g.typeId, typeName: g.typeName, tension: g.tension };
    const item = { key: k, target, date, slot, cell, field, dateId, remaining: cell.count, hits: hits || [] };

    if (cfg.mode === 'direct') {
      await doOrder(item);
      return;
    }

    const p = S.pending[k];
    if (!p) {
      const until = Date.now() + cfg.confirmWaitSec * 1000;
      S.pending[k] = { until, item };
      notify('发现空位：' + g.venueName + ' ' + g.typeName,
        date + ' ' + SLOTS[slot] + '（剩余 ' + cell.count + '）\n' +
        Math.round(cfg.confirmWaitSec / 60) + ' 分钟内你可以自己去约；不约的话我会在到点后自动下单', { kind: 'hit' });
      return;
    }

    // 刷新凭证
    p.item = item;
    if (Date.now() >= p.until) {
      const still = (item.hits || []).some(function (t) { return !S.sat[t.id]; });
      if (!still) { delete S.pending[k]; return; }   // 目标已经约到了，别重复下单
      await doOrder(item);
    }
  }

  async function doOrder(item) {
    if (S.ordering) return;
    S.ordering = true;
    const k = item.key;
    try {
      log('准备下单：' + item.target.venueName + ' ' + item.target.typeName + ' ' + item.date + ' ' + SLOTS[item.slot], 'info');

      // checkRule 只做参考：前端拿到 {msg:"操作成功", data:2} 也不会拦截，
      // 真正的规则校验发生在 ConfirmOrder 里，所以这里不阻断下单（省一次往返，抢位更快）。
      const out = await placeOrder(item.target, item.date, item.slot, item.cell, item.field, item.dateId);

      if (out && out.__captcha) {
        delete S.pending[k];
        S.done[k] = 'captcha';
        notify('需要人工过验证码', '下单时触发了滑块验证，请手动去约：' +
          item.target.venueName + ' ' + item.target.typeName + ' ' + item.date + ' ' + SLOTS[item.slot]);
        return;
      }

      S.done[k] = out;
      delete S.pending[k];
      for (const t of (item.hits || [])) S.sat[t.id] = out;
      log('✅ 下单成功 订单号 ' + out, 'ok');

      let payLink = '';
      try {
        const pr = await api.payUrl(out);
        if (pr.url) {
          payLink = pr.url;
          S.pay.push({ orderId: out, url: pr.url, at: Date.now(), n5: false, n10: false });
          renderStatus();
          if (cfg.autoOpenPay) {
            const w = window.open(pr.url, '_blank');
            if (!w) {
              // 后台标签页没有用户激活，弹窗会被拦；把链接复制好，人回来一粘就能付
              log('浏览器拦截了自动打开付款页（后台标签页常见），链接已复制到剪贴板，去付款时粘贴即可', 'warn');
              try { if (navigator.clipboard) navigator.clipboard.writeText(pr.url).catch(function () { }); } catch (e) { }
            }
          } else {
            log('付款链接：' + pr.url, 'muted');
          }
        } else {
          log('支付链接获取失败：' + (pr.msg || '未知'), 'warn');
        }
      } catch (e) { log('支付链接获取失败：' + e.message, 'warn'); }

      notify('✅ 已下单，请尽快付款',
        item.target.venueName + ' ' + item.target.typeName + '\n' +
        item.date + ' ' + SLOTS[item.slot] + '\n订单号 ' + out + '（15 分钟内不付款会自动取消）', { kind: 'ok', link: payLink });

      if (cfg.stopWhenDone && allDone()) {
        setTimeout(() => stop('done'), 500);
        notify('监控已停止', '所有目标都已下单成功');
      }
    } catch (err) {
      if (err instanceof SessionLost) {
        relogin('自动下单时发现登录失效');
      } else {
        log('下单失败：' + err.message, 'err');
        delete S.pending[k];
        notify('自动下单失败', item.target.venueName + ' ' + item.date + ' ' + SLOTS[item.slot] + '：' + err.message + '\n可以手动去约');
      }
    } finally {
      S.ordering = false;
      renderStatus();
    }
  }

  function allDone() {
    if (!cfg.targets.length) return false;
    return cfg.targets.every(function (t) {
      if (S.sat[t.id]) return true;
      const prefix = fieldKey(t.venueId, t.typeId) + '|';
      return Object.keys(S.done).some(k => k.startsWith(prefix) && S.done[k] && String(S.done[k]).length > 5);
    });
  }

  /* ============================ 启动 / 停止 ============================ */

  function start() {
    if (S.running) return;
    if (!cfg.targets.length) { notify('无法启动', '请先添加至少一个监控目标'); return; }
    try { cryptoMod(); } catch (e) { notify('无法启动', e.message); return; }
    S.running = true;
    S.lastErr = '';
    store.set('ssm_running', '1');
    log('开始监控，轮询间隔 ' + cfg.pollSec + ' 秒', 'ok');
    log('后台防护：' + (WT.ok() ? 'Worker 定时器已启用（切到后台也不会被拖慢）' : 'Worker 不可用，退回普通定时器'), 'muted');
    renderStatus();
    loop();
    syncClock().then(function () { armSnipe(); });
  }

  function stop(reason) {
    S.running = false;
    store.set('ssm_running', '0');
    if (S.timer) { WT.clear(S.timer); S.timer = null; }
    if (snipeTimer) { WT.clear(snipeTimer); snipeTimer = null; }
    S.snipeAt = 0;
    keepAliveAudio(false);
    if (reason) log('已停止（' + reason + '）', 'warn');
    renderStatus();
  }

  async function loop() {
    if (!S.running) return;
    await tick();
    if (!S.running) return;
    const ms = Math.max(20, cfg.pollSec) * 1000 * rnd(0.85, 1.15);
    S.timer = WT.set(ms, loop);
  }

  // 从后台切回前台时补一次：被节流那段时间可能错过了好几轮
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (keepAlive && keepAlive.ctx && keepAlive.ctx.state === 'suspended') {
      try { keepAlive.ctx.resume(); } catch (e) { }
    }
    if (S.running && S.lastTickAt && Date.now() - S.lastTickAt > Math.max(20, cfg.pollSec) * 2000) {
      const gap = Math.round((Date.now() - S.lastTickAt) / 1000);
      log('标签页回到前台，上次检查已是 ' + gap + ' 秒前，立即补查一次', 'muted');
      if (S.timer) { WT.clear(S.timer); S.timer = null; }
      loop();
    }
  });

  // 抢放号倒计时：每秒刷新一次状态行
  setInterval(() => {
    if (S.running && cfg.snipe.enabled) renderStatus();
  }, 1000);

  // 付款提醒：下单后 5 / 10 分钟各提醒一次
  setInterval(() => {
    const now = Date.now();
    for (const p of S.pay) {
      const min = (now - p.at) / 60000;
      if (min >= 5 && !p.n5) { p.n5 = true; notify('还没付款哦', '订单 ' + p.orderId + ' 还有 10 分钟就会自动取消'); }
      else if (min >= 10 && !p.n10) { p.n10 = true; notify('付款倒计时 5 分钟', '订单 ' + p.orderId + ' 即将自动取消！'); }
    }
    renderStatus();
  }, 30000);

  /* ============================ 12:00 放号抢单 ============================ */

  let srvOffset = 0;      // 服务器时间 - 本地时间
  let snipeTimer = null;  // 武装用的定时器
  let sniping = false;
  let keepAlive = null;

  /* ======================= 后台标签页的定时器 =======================
     浏览器会把隐藏标签页的定时器夹到 1 秒；隐藏满 5 分钟后再"密集节流"到
     1 分钟一次。专用 Worker 里的定时器不吃这条约束，所以关键定时器搬进去。
     blob worker 可能被页面 CSP 拦掉，那就自动退回普通 setTimeout。        */
  const WT = (function () {
    let wk = null, tried = false, seq = 0;
    const pend = new Map();
    function ensure() {
      if (wk || tried) return wk;
      tried = true;
      try {
        const src = 'var T={};onmessage=function(e){var d=e.data;' +
          'if(d.t==="set"){T[d.id]=setTimeout(function(){delete T[d.id];' +
          'postMessage({t:"fire",id:d.id})},d.ms)}' +
          'else if(d.t==="clear"){clearTimeout(T[d.id]);delete T[d.id]}}';
        const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        wk = new Worker(url);
        wk.onmessage = function (e) {
          const f = pend.get(e.data.id);
          if (f) { pend.delete(e.data.id); try { f(); } catch (err) { } }
        };
      } catch (e) { wk = null; }
      return wk;
    }
    return {
      ok: function () { return !!ensure(); },
      set: function (ms, fn) {
        const w = ensure();
        const id = ++seq;
        pend.set(id, fn);
        if (w) { w.postMessage({ t: 'set', id: id, ms: ms }); return { wid: id }; }
        return { tid: setTimeout(function () { pend.delete(id); fn(); }, ms) };
      },
      clear: function (h) {
        if (!h) return;
        if (h.tid) { clearTimeout(h.tid); return; }
        if (h.wid) { pend.delete(h.wid); if (wk) wk.postMessage({ t: 'clear', id: h.wid }); }
      }
    };
  })();

  function serverNow() { return Date.now() + srvOffset; }

  // 用响应头里的 Date 校准服务器时间（北京时间和服务器同一时区）
  async function syncClock() {
    // Date 响应头只精确到秒（向下取整），所以真值落在 [srv, srv+1000)，
    // 取 +500ms 作为期望值；多次采样取 RTT 最小的那次。
    let best = null;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      try {
        const res = await fetch(location.origin + '/pc/?_=' + t0, { method: 'HEAD', cache: 'no-store' });
        const t1 = Date.now();
        const srv = Date.parse(res.headers.get('date') || '');
        if (isFinite(srv)) {
          const rtt = t1 - t0;
          const off = srv + 500 - (t0 + rtt / 2);
          if (!best || rtt < best.rtt) best = { off: off, rtt: rtt };
        }
      } catch (e) { }
      await sleep(120);
    }
    if (best) {
      srvOffset = Math.round(best.off);
      log('与服务器对时完成：本地快/慢 ' + srvOffset + ' ms（误差约 ±0.5 秒）', 'muted');
    }
    return srvOffset;
  }

  // 下一个 12:00:00，返回本地时钟的毫秒
  function nextReleaseAt() {
    const t = new Date(Date.now() + srvOffset);
    t.setHours(12, 0, 0, 0);
    let at = t.getTime() - srvOffset;
    if (at <= Date.now() + 1000) at += 86400000;
    return at;
  }

  // 后台标签页的定时器会被拖慢到 1 分钟一次。播放音频的标签页不算"隐藏"，
  // 不会被密集节流，所以放一个几乎无声的音把标签页"点亮"。
  function keepAliveAudio(on) {
    try {
      if (on) {
        if (keepAlive) return;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = 0.0008;
        osc.frequency.value = 40;
        osc.connect(g); g.connect(ctx.destination);
        osc.start();
        keepAlive = { ctx: ctx, osc: osc };
        if (ctx.state === 'suspended') {
          // 没有用户手势时浏览器不让出声，尝试救一次；救不回来也不至于崩
          const p = ctx.resume();
          if (p && p.catch) p.catch(function () { });
          setTimeout(function () {
            if (keepAlive && keepAlive.ctx === ctx && ctx.state === 'suspended') {
              log('保活音频被浏览器挂起：后台定时器可能被节流，在页面上点一下「停止」再「开始监控」可恢复', 'warn');
            }
          }, 600);
        }
        log('已开启保活音频，防止后台节流拖慢定时器', 'muted');
      } else if (keepAlive) {
        try { keepAlive.osc.stop(); keepAlive.ctx.close(); } catch (e) { }
        keepAlive = null;
      }
    } catch (e) { }
  }

  function armSnipe() {
    if (snipeTimer) { WT.clear(snipeTimer); snipeTimer = null; }
    S.snipeAt = 0;
    if (!S.running || !cfg.snipe.enabled || !cfg.targets.length) { keepAliveAudio(false); renderStatus(); return; }

    const at = nextReleaseAt();
    S.snipeAt = at;
    const wait = at - cfg.snipe.leadMs - Date.now();
    if (wait <= 0) { WT.set(60, onSnipeFire); return; }

    snipeTimer = WT.set(wait, onSnipeFire);
    if (wait < 130000) keepAliveAudio(true);
    else WT.set(wait - 120000, function () { if (S.running && cfg.snipe.enabled) keepAliveAudio(true); });

    log('已武装 12:00 抢放号：' + new Date(at).toLocaleString('zh-CN'), 'ok');
    renderStatus();
  }

  async function onSnipeFire() {
    snipeTimer = null;
    const at = S.snipeAt || 0;
    await syncClock();
    const late = at ? (Date.now() + srvOffset) - at : 0;
    if (at && late > (cfg.snipe.windowSec + 20) * 1000) {
      log('错过本日 12:00（大概睡过了：晚了 ' + Math.round(late / 1000) + ' 秒），本次跳过', 'warn');
    } else {
      await snipeBurst(late > 3000 ? '唤醒后补抢' : '定时 12:00');
    }
    keepAliveAudio(false);
    if (S.running) armSnipe();
  }

  async function snipeBurst(why) {
    if (sniping) return;
    if (!cfg.targets.length) { notify('无法抢', '还没有任何目标'); return; }
    sniping = true;
    const t0 = Date.now();
    const deadline = t0 + Math.max(5, cfg.snipe.windowSec) * 1000;
    const gs = groups();
    const dateCache = new Map();
    let tries = 0, booked = 0;

    log('⏰ 开始抢放号（' + why + '），窗口 ' + cfg.snipe.windowSec + ' 秒 / 间隔 ' + cfg.snipe.intervalMs + 'ms', 'ok');
    notify('12:00 抢放号开始', '正在高频刷新目标场馆，抢到会立刻下单', { kind: 'info' });

    try {
      while (Date.now() < deadline && S.running) {
        for (let gi = 0; gi < gs.length && booked === 0; gi++) {
          const g = gs[gi];
          if (Date.now() >= deadline) break;
          const gk = fieldKey(g.venueId, g.typeId);

          let dates = null;
          const cached = dateCache.get(gk);
          if (cached && Date.now() - cached.at < 2000) dates = cached.dates;
          if (!dates) {
            try {
              dates = await api.dates(g.venueId, g.typeId);
              dateCache.set(gk, { dates: dates, at: Date.now() });
            } catch (e) { await sleep(250); continue; }
          }
          const newest = dates && dates[dates.length - 1];
          if (!newest) continue;

          const activeT = g.targets.filter(function (t) { return !S.sat[t.id]; });
          if (!activeT.length) continue;
          const want = new Set();
          for (const t of activeT) (t.slots || []).forEach(function (x) { want.add(x); });
          const slots = want.size ? [...want].sort(function (a, b) { return a - b; })
                                  : SLOTS.map(function (_, i) { return i; });

          let fields;
          try { fields = await api.fields(g.venueId, g.typeId, newest.date, newest.dateId); }
          catch (e) { await sleep(250); continue; }
          tries++;

          for (const field of fields) {
            const list = field.priceList || [];
            for (const slot of slots) {
              const cell = list[slot];
              if (!cell) continue;
              if (String(cell.status) !== '0') continue;
              if (Number(cell.count) <= 0) continue;
              const k = keyOf(g.venueId, g.typeId, newest.date, slot);
              if (S.done[k]) continue;
              log('抢到空位：' + newest.date + ' ' + SLOTS[slot] + '，立即下单', 'ok');
              await doOrder({ key: k, target: g, date: newest.date, slot: slot, cell: cell, field: field, dateId: newest.dateId, remaining: cell.count });
              if (String(S.done[k] || '').length > 5) booked++;
              break;
            }
            if (booked) break;
          }
        }
        if (booked) break;
        await sleep(rnd(cfg.snipe.intervalMs * 0.8, cfg.snipe.intervalMs * 1.2));
      }
    } catch (e) {
      log('抢放号异常：' + e.message, 'err');
    } finally {
      sniping = false;
      const secs = Math.round((Date.now() - t0) / 1000);
      log('抢放号结束：' + secs + ' 秒内刷新 ' + tries + ' 轮，成功 ' + booked + ' 单', booked ? 'ok' : 'warn');
      if (!booked) notify('这一轮没抢到', secs + ' 秒内没出现可约名额，可能已经被抢光了');
      renderStatus();
    }
  }

  /* ============================ 界面 ============================ */

  let ui = null;

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'style') el.style.cssText = v;
        else if (k in el && k !== 'list') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
        else el.setAttribute(k, v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) kid.forEach(x => x && el.append(x.nodeType ? x : document.createTextNode(String(x))));
      else el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; }
    .fab { width: 52px; height: 52px; border-radius: 50%; background: #c8102e; color: #fff; border: none;
           font-size: 22px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
    .panel { width: 396px; max-height: 78vh; overflow: auto; background: #fff; border-radius: 14px;
             box-shadow: 0 10px 40px rgba(0,0,0,.25); border: 1px solid #e3e3e3; color: #1a1a1a; font-size: 13px; }
    .hd { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #c8102e; color: #fff;
          border-radius: 14px 14px 0 0; position: sticky; top: 0; z-index: 2; }
    .hd .t { font-weight: 600; font-size: 14px; flex: 1; }
    .hd button { background: rgba(255,255,255,.18); border: none; color: #fff; width: 26px; height: 26px;
                 border-radius: 7px; cursor: pointer; font-size: 14px; }
    .body { padding: 12px 14px 16px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .dot.on { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.25); }
    .dot.off { background: #9ca3af; }
    .row { display: flex; gap: 8px; align-items: center; }
    select, input[type=text], input[type=number] { border: 1px solid #d8d8d8; border-radius: 7px; padding: 5px 7px;
          font-size: 12.5px; background: #fff; color: #1a1a1a; outline: none; }
    select:focus, input:focus { border-color: #c8102e; }
    .btn { border: 1px solid #d8d8d8; background: #fff; border-radius: 7px; padding: 6px 11px; cursor: pointer;
           font-size: 12.5px; color: #333; }
    .btn:hover { border-color: #c8102e; color: #c8102e; }
    .btn.primary { background: #c8102e; border-color: #c8102e; color: #fff; }
    .btn.primary:hover { background: #a80e26; }
    .btn.ghost { border-color: transparent; color: #888; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
    input[type=number] { -moz-appearance: textfield; appearance: textfield; text-align: center; }
    .sec { margin-top: 13px; padding-top: 11px; border-top: 1px dashed #ececec; }
    .lbl { color: #888; font-size: 11.5px; margin-bottom: 6px; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip { border: 1px solid #dcdcdc; border-radius: 6px; padding: 3px 7px; font-size: 11.5px; cursor: pointer;
            background: #fff; color: #444; user-select: none; white-space: nowrap; }
    .chip.sel { background: #c8102e; border-color: #c8102e; color: #fff; }
    .chip.past { opacity: .35; text-decoration: line-through; cursor: not-allowed; }
    .tgt { border: 1px solid #eee; border-radius: 9px; padding: 8px 10px; margin-bottom: 7px; background: #fafafa; }
    .tgt .n { font-weight: 600; font-size: 12.5px; }
    .tgt .d { color: #777; font-size: 11.5px; margin-top: 3px; line-height: 1.5; }
    .tgt .x { float: right; color: #bbb; cursor: pointer; }
    .tgt .x:hover { color: #c8102e; }
    .log { font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.55; max-height: 190px;
           overflow: auto; background: #f6f7f9; border-radius: 8px; padding: 8px; }
    .log .t { color: #999; margin-right: 6px; }
    .log .ok { color: #128a4d; }
    .log .err { color: #c8102e; }
    .log .warn { color: #b45309; }
    .log .muted { color: #999; }
    .status { font-size: 11.5px; color: #666; line-height: 1.7; }
    .pay { display: block; text-align: center; background: #c8102e; color: #fff; text-decoration: none;
           border-radius: 8px; padding: 9px; margin-top: 8px; font-weight: 600; font-size: 13px; }
    .pay:hover { background: #a80e26; }
    .tabs { display: flex; gap: 4px; margin-bottom: 10px; }
    .tabs .tb { padding: 4px 12px; border-radius: 7px; cursor: pointer; font-size: 12px; color: #666; }
    .tabs .tb.on { background: #f1f1f1; color: #c8102e; font-weight: 600; }
    .hint { color: #999; font-size: 11px; margin-top: 5px; line-height: 1.5; }
    .warnbox { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; border-radius: 8px;
               padding: 7px 9px; font-size: 11.5px; line-height: 1.6; margin-top: 10px; }
    .ssm-banner { position: fixed; left: 0; right: 0; top: 0; z-index: 2147483600; display: none;
                  align-items: center; gap: 12px; padding: 12px 16px;
                  font: 500 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                  color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.28); }
    .ssm-banner.hit { background: linear-gradient(90deg, #b91c1c, #dc2626); animation: ssmPulse 1.4s ease-in-out infinite; }
    .ssm-banner.ok { background: linear-gradient(90deg, #047857, #059669); }
    .ssm-banner.info { background: linear-gradient(90deg, #1e40af, #2563eb); }
    .ssm-banner .ssm-bt { font-weight: 700; font-size: 15px; white-space: nowrap; }
    .ssm-banner .ssm-bd { opacity: .95; }
    .ssm-banner .ssm-bx { margin-left: auto; background: rgba(255,255,255,.22); color: #fff; border: 0;
                          border-radius: 8px; padding: 6px 14px; font-size: 12px; cursor: pointer; white-space: nowrap; }
    @keyframes ssmPulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.35); } }
  `;

  const uiSel = { venueId: '', typeId: '', dates: new Set(), slots: new Set() };
  let uiTab = 'cfg';

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'ssm-host';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const wrap = h('div', { class: 'wrap' });
    root.appendChild(wrap);

    const fab = h('button', { class: 'fab', title: '捡漏助手', text: '🎯', onclick: () => toggle(true) });
    wrap.appendChild(fab);

    const panel = h('div', { class: 'panel', style: 'display:none' });
    wrap.appendChild(panel);

    const closeBtn = h('button', { text: '—', onclick: () => toggle(false) });
    const title = h('div', { class: 't', text: '场馆捡漏助手' });
    const dot = h('span', { class: 'dot off' });
    const hd = h('div', { class: 'hd' }, title, dot, closeBtn);
    panel.appendChild(hd);

    const body = h('div', { class: 'body' });
    panel.appendChild(body);

    ui = { host, root, wrap, fab, panel, body, dot };
    renderAll();

    function toggle(open) {
      panel.style.display = open ? '' : 'none';
      fab.style.display = open ? 'none' : '';
      if (open) renderAll();
    }
    ui.toggle = toggle;
    toggle(false);
  }

  function renderAll() {
    if (!ui) return;
    const b = ui.body;
    b.textContent = '';

    // 状态行
    const statusBox = h('div', { class: 'status' });
    b.appendChild(statusBox);

    // 付款按钮
    const unpaid = S.pay.filter(p => Date.now() - p.at < 15 * 60000);
    for (const p of unpaid.slice(-1)) {
      b.appendChild(h('a', { class: 'pay', href: p.url, target: '_blank', text: '💳 去付款（订单 ' + p.orderId.slice(-6) + '）' }));
    }

    // tabs
    const tabs = h('div', { class: 'tabs' },
      h('div', { class: 'tb' + (uiTab === 'cfg' ? ' on' : ''), text: '配置', onclick: () => { uiTab = 'cfg'; renderAll(); } }),
      h('div', { class: 'tb' + (uiTab === 'log' ? ' on' : ''), text: '日志', onclick: () => { uiTab = 'log'; renderAll(); } })
    );
    b.appendChild(tabs);

    if (uiTab === 'cfg') renderConfig(b);
    else renderLog(b);

    renderStatus();
  }

  function renderStatus() {
    if (!ui) return;
    const statusBox = ui.body.querySelector('.status');
    if (!statusBox) return;
    ui.dot.className = 'dot ' + (S.running ? 'on' : 'off');

    const now = Date.now();
    const next = S.timer ? Math.max(0, Math.round((S.lastTickAt + cfg.pollSec * 1000 - now) / 1000)) : null;
    const parts = [];
    parts.push(S.running ? '● 监控中' : '○ 已停止');
    parts.push('目标 ' + cfg.targets.length + ' 个');
    if (S.running && S.lastTickAt) parts.push('上次检查 ' + Math.round((now - S.lastTickAt) / 1000) + ' 秒前');
    if (S.running && next !== null && !S.ticking) parts.push('下次约 ' + next + ' 秒后');
    if (S.ticking) parts.push('检查中…');
    if (Object.keys(S.pending).length) parts.push('待确认 ' + Object.keys(S.pending).length + ' 个');
    const doneN = Object.values(S.done).filter(v => v && String(v).length > 5).length;
    if (doneN) parts.push('已下单 ' + doneN);
    if (S.running && cfg.snipe.enabled) {
      const at = S.snipeAt || nextReleaseAt();
      const left = Math.max(0, at - Date.now());
      const hh = Math.floor(left / 3600000);
      const mm = Math.floor(left % 3600000 / 60000);
      const ss = Math.floor(left % 60000 / 1000);
      parts.push('⏰ 距放号 ' + (hh ? hh + ' 小时 ' : '') + mm + ' 分 ' + ss + ' 秒');
    }

    statusBox.innerHTML = '';
    parts.forEach((p, i) => {
      if (i) statusBox.append(h('span', { text: ' · ' }));
      statusBox.append(h('span', { text: p }));
    });
    if (S.lastErr) statusBox.append(h('div', { class: 'log err', text: '最近错误：' + S.lastErr, style: 'margin-top:6px' }));

    // 待确认倒计时
    const pend = Object.values(S.pending).filter(p => p.until > now);
    if (pend.length) {
      pend.slice(0, 3).forEach(p => {
        const left = Math.max(0, Math.round((p.until - now) / 1000));
        statusBox.append(h('div', {
          class: 'hint',
          text: '⏳ ' + p.item.target.venueName + ' ' + p.item.date + ' ' + SLOTS[p.item.slot] +
            ' → ' + left + ' 秒后自动下单'
        }));
      });
    }
  }

  function renderConfig(b) {
    // --- 运行控制
    const runRow = h('div', { class: 'row', style: 'margin-top:10px' });
    const startBtn = h('button', {
      class: 'btn primary', text: S.running ? '运行中' : '开始监控',
      disabled: S.running, onclick: () => { start(); renderAll(); }
    });
    const stopBtn = h('button', {
      class: 'btn', text: '停止', disabled: !S.running, onclick: () => { stop('手动停止'); renderAll(); }
    });
    const testBtn = h('button', {
      class: 'btn', text: '试跑一次', title: '只检查一轮，验证配置是否正确',
      onclick: async () => {
        testBtn.disabled = true; testBtn.textContent = '检查中…';
        const was = S.running;
        S.running = true;
        await tick();
        S.running = was;
        testBtn.disabled = false; testBtn.textContent = '试跑一次';
        renderAll();
      }
    });
    runRow.append(startBtn, stopBtn, testBtn,
      h('div', { style: 'flex:1' }),
      h('span', { class: 'hint', text: '每' }),
      h('input', {
        type: 'number', min: 20, max: 1800, value: cfg.pollSec, style: 'width:58px;margin:0 4px',
        onchange: (e) => { cfg.pollSec = Math.max(20, Math.min(1800, Number(e.target.value) || 90)); saveCfg(); renderStatus(); }
      }),
      h('span', { class: 'hint', text: '秒' })
    );
    b.appendChild(runRow);

    // --- 模式
    const modeSec = h('div', { class: 'sec' });
    modeSec.appendChild(h('div', { class: 'lbl', text: '下单模式' }));
    const m1 = h('div', {},
      h('label', { class: 'row', style: 'cursor:pointer' },
        h('input', {
          type: 'radio', name: 'ssm-mode', checked: cfg.mode === 'confirm',
          onchange: () => { cfg.mode = 'confirm'; saveCfg(); renderAll(); }
        }),
        h('span', { text: '先提醒，留时间给我自己约' })
      ),
      h('div', { class: 'row', style: 'margin:5px 0 0 22px;gap:5px;flex-wrap:wrap' },
        h('span', { class: 'hint', text: '等待' }),
        h('input', {
          type: 'number', min: 1, max: 60, value: Math.round(cfg.confirmWaitSec / 60),
          style: 'width:48px', onchange: (e) => { cfg.confirmWaitSec = Math.max(1, Math.min(60, Number(e.target.value) || 5)) * 60; saveCfg(); }
        }),
        h('span', { class: 'hint', text: '分钟；到点后名额还在就自动下单' })
      )
    );
    const m2 = h('label', { class: 'row', style: 'cursor:pointer' },
      h('input', {
        type: 'radio', name: 'ssm-mode', checked: cfg.mode === 'direct',
        onchange: () => { cfg.mode = 'direct'; saveCfg(); renderAll(); }
      }),
      h('span', { text: '直接下单：检测到空位立刻下单（手快优先）' })
    );
    modeSec.append(m1, m2);
    b.appendChild(modeSec);

    // --- 12:00 抢放号
    const snSec = h('div', { class: 'sec' });
    snSec.appendChild(h('div', { class: 'lbl', text: '⏰ 12:00 放号抢单' }));
    snSec.appendChild(h('label', { class: 'row', style: 'cursor:pointer' },
      h('input', {
        type: 'checkbox', checked: !!cfg.snipe.enabled,
        onchange: (e) => { cfg.snipe.enabled = e.target.checked; saveCfg(); if (S.running) armSnipe(); renderAll(); }
      }),
      h('span', { text: '每天 12:00 自动抢（沿用上面目标的时段，抢最新放出的那一天）' })
    ));
    snSec.appendChild(h('div', { class: 'row', style: 'margin:6px 0 0 22px;gap:5px;flex-wrap:wrap' },
      h('span', { class: 'hint', text: '提前' }),
      h('input', {
        type: 'number', min: 0, max: 30, value: Math.round(cfg.snipe.leadMs / 1000), style: 'width:52px',
        onchange: (e) => { cfg.snipe.leadMs = Math.max(0, Math.min(30, Number(e.target.value) || 0)) * 1000; saveCfg(); }
      }),
      h('span', { class: 'hint', text: '秒开抢，持续' }),
      h('input', {
        type: 'number', min: 5, max: 120, value: cfg.snipe.windowSec, style: 'width:52px',
        onchange: (e) => { cfg.snipe.windowSec = Math.max(5, Math.min(120, Number(e.target.value) || 25)); saveCfg(); }
      }),
      h('span', { class: 'hint', text: '秒，间隔' }),
      h('input', {
        type: 'number', min: 150, max: 5000, step: 50, value: cfg.snipe.intervalMs, style: 'width:64px',
        onchange: (e) => { cfg.snipe.intervalMs = Math.max(150, Math.min(5000, Number(e.target.value) || 400)); saveCfg(); }
      }),
      h('span', { class: 'hint', text: '毫秒' })
    ));
    snSec.appendChild(h('div', { class: 'row', style: 'margin:8px 0 0 22px;gap:8px' },
      h('button', { class: 'btn ghost', text: '对时', title: '用服务器时间校准本地时钟', onclick: async () => { await syncClock(); renderAll(); } }),
      h('button', {
        class: 'btn', text: '立即抢一轮',
        onclick: () => { if (!S.running) { notify('无法抢', '请先点「开始监控」'); return; } snipeBurst('手动'); }
      })
    ));
    snSec.appendChild(h('div', {
      class: 'hint', style: 'margin-top:6px',
      text: '抢放号时不做"先提醒后下单"，发现空位立即下单。12:00 前请让本标签页保持可见。'
    }));
    b.appendChild(snSec);

    // --- 添加目标
    const addSec = h('div', { class: 'sec' });
    addSec.appendChild(h('div', { class: 'lbl', text: '添加监控目标' }));

    const venueSel = h('select', {
      style: 'flex:1;min-width:0',
      onchange: async (e) => {
        uiSel.venueId = e.target.value;
        uiSel.typeId = '';
        await loadTypes();
      }
    });
    venueSel.appendChild(h('option', { value: '', text: '场馆…' }));
    (VENUES || []).forEach(v => venueSel.appendChild(h('option', {
      value: v.venueId, text: v.venueName, selected: v.venueId === uiSel.venueId
    })));

    const typeSel = h('select', {
      style: 'flex:1;min-width:0',
      onchange: (e) => { uiSel.typeId = e.target.value; renderDateChips(); }
    });
    typeSel.appendChild(h('option', { value: '', text: '项目…' }));

    addSec.appendChild(h('div', { class: 'row' }, venueSel, typeSel));

    const dateBox = h('div', { class: 'chips', style: 'margin-top:9px' });
    const slotBox = h('div', { class: 'chips', style: 'margin-top:9px' });
    const hintBox = h('div', { class: 'hint', text: '' });

    addSec.append(h('div', { class: 'lbl', style: 'margin-top:9px', text: '日期（未来 8 天，不选＝全部）' }), dateBox);
    addSec.append(h('div', { class: 'lbl', style: 'margin-top:9px', text: '时段（不选＝全部）' }), slotBox);

    const quick = h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn', text: '晚间', onclick: () => { uiSel.slots = new Set([11, 12, 13, 14]); renderSlots(); } }),
      h('button', { class: 'btn', text: '午间', onclick: () => { uiSel.slots = new Set([4, 5, 6]); renderSlots(); } }),
      h('button', { class: 'btn', text: '全选', onclick: () => { uiSel.slots = new Set(SLOTS.map((_, i) => i)); renderSlots(); } }),
      h('button', { class: 'btn', text: '清空', onclick: () => { uiSel.slots = new Set(); renderSlots(); } })
    );
    addSec.append(quick);

    const addBtn = h('button', {
      class: 'btn primary', style: 'margin-top:9px', text: '＋ 添加目标',
      onclick: () => {
        const v = (VENUES || []).find(x => x.venueId === uiSel.venueId);
        const t = (TYPES || []).find(x => x.id === uiSel.typeId);
        if (!v || !t) { hintBox.textContent = '请先选好场馆和项目'; return; }
        cfg.targets.push({
          id: 'g' + Date.now() + Math.floor(Math.random() * 1000),
          venueId: v.venueId, venueName: v.venueName,
          typeId: t.id, typeName: t.name, tension: t.tension, writeOffType: t.writeOffType,
          dates: [...uiSel.dates].sort(),
          slots: [...uiSel.slots].sort((a, b) => a - b)
        });
        saveCfg();
        renderAll();
      }
    });
    addSec.append(addBtn, hintBox);
    b.appendChild(addSec);

    // --- 目标列表
    const tgtSec = h('div', { class: 'sec' });
    tgtSec.appendChild(h('div', { class: 'lbl', text: '监控目标（' + cfg.targets.length + '）' }));
    if (!cfg.targets.length) {
      tgtSec.appendChild(h('div', { class: 'hint', text: '还没有目标。选好场馆/项目/日期/时段后点上面的「添加目标」。' }));
    }
    cfg.targets.forEach((t, idx) => {
      const prefix = fieldKey(t.venueId, t.typeId) + '|';
      const hits = Object.keys(S.done).filter(k => k.startsWith(prefix) && String(S.done[k]).length > 5);
      const box = h('div', { class: 'tgt' });
      box.appendChild(h('span', {
        class: 'x', text: '✕',
        onclick: () => { cfg.targets.splice(idx, 1); saveCfg(); renderAll(); }
      }));
      box.appendChild(h('div', { class: 'n', text: (t.venueName || '?') + ' · ' + (t.typeName || '?') + (hits.length ? '  ✅' : '') }));
      const ds = t.dates && t.dates.length ? t.dates.map(d => d.slice(5)).join('、') : '任意日期';
      const ss = t.slots && t.slots.length ? t.slots.map(i => SLOTS[i].slice(0, 5)).join('、') : '任意时段';
      box.appendChild(h('div', { class: 'd', text: ds + ' ｜ ' + ss }));
      tgtSec.appendChild(box);
    });
    b.appendChild(tgtSec);

    // --- 通知
    const nSec = h('div', { class: 'sec' });
    nSec.appendChild(h('div', { class: 'lbl', text: '通知' }));
    nSec.appendChild(h('label', { class: 'row', style: 'cursor:pointer;margin-bottom:5px' },
      h('input', {
        type: 'checkbox', checked: cfg.desktopNotify,
        onchange: (e) => { cfg.desktopNotify = e.target.checked; saveCfg(); }
      }),
      h('span', { text: '桌面通知' })
    ));
    nSec.appendChild(h('label', { class: 'row', style: 'cursor:pointer;margin-bottom:5px' },
      h('input', {
        type: 'checkbox', checked: cfg.soundNotify,
        onchange: (e) => { cfg.soundNotify = e.target.checked; saveCfg(); }
      }),
      h('span', { text: '提示音' })
    ));
    nSec.appendChild(h('label', { class: 'row', style: 'cursor:pointer;margin-bottom:5px' },
      h('input', {
        type: 'checkbox', checked: cfg.stopWhenDone,
        onchange: (e) => { cfg.stopWhenDone = e.target.checked; saveCfg(); }
      }),
      h('span', { text: '所有目标都下单成功后自动停止监控' })
    ));
    nSec.appendChild(h('label', { class: 'row', style: 'cursor:pointer;margin-bottom:5px' },
      h('input', {
        type: 'checkbox', checked: cfg.autoOpenPay !== false,
        onchange: (e) => { cfg.autoOpenPay = e.target.checked; saveCfg(); }
      }),
      h('span', { text: '下单后自动打开付款页' })
    ));
    nSec.appendChild(h('label', { class: 'row', style: 'cursor:pointer;margin-bottom:5px' },
      h('input', {
        type: 'checkbox', checked: cfg.autoRelogin !== false,
        onchange: (e) => { cfg.autoRelogin = e.target.checked; saveCfg(); }
      }),
      h('span', { text: '登录失效时自动跳转重登' })
    ));
    nSec.appendChild(h('label', { class: 'row', style: 'cursor:pointer;margin-bottom:5px' },
      h('input', {
        type: 'checkbox', checked: cfg.renewSec !== 0,
        onchange: (e) => { cfg.renewSec = e.target.checked ? 14400 : 0; saveCfg(); renderAll(); }
      }),
      h('span', { text: '每隔' }),
      h('input', {
        type: 'number', min: 0, max: 24, value: Math.round((cfg.renewSec || 0) / 3600),
        style: 'width:46px',
        onchange: (e) => { cfg.renewSec = Math.max(0, Math.min(24, Number(e.target.value) || 0)) * 3600; saveCfg(); }
      }),
      h('span', { text: '小时主动续期一次（0=关）' })
    ));
    nSec.appendChild(h('div', { class: 'row', style: 'gap:6px;margin-top:2px;margin-bottom:5px' },
      h('button', {
        class: 'btn ghost', text: '检查登录', style: 'flex:0 0 auto',
        onclick: () => { checkNow().then(n => { if (n) log('登录状态正常：' + n, 'ok'); else log('当前未登录', 'warn'); }); }
      }),
      (sessEl = h('span', { text: '未检查', style: 'font-size:12px' }))
    ));
    nSec.appendChild(h('div', { class: 'row', style: 'gap:6px;margin-top:5px' },
      h('input', {
        type: 'text', placeholder: '手机推送地址：Bark / Server酱 / ntfy',
        value: cfg.webhook || '', style: 'flex:1;min-width:0',
        onchange: (e) => { cfg.webhook = e.target.value.trim(); saveCfg(); }
      }),
      h('button', { class: 'btn ghost', text: '测试推送', style: 'flex:0 0 auto', onclick: pushTest })
    ));
    b.appendChild(nSec);

    b.appendChild(h('div', { class: 'warnbox' },
      '⚠️ 学校《场馆使用须知》明确禁止使用「外挂」等手段预约，被判定异常可能被拉黑并取消预约权限。请把轮询间隔设得合理一些（≥60 秒），本工具仅供个人便利，风险自负。'));

    renderDateChips();
    renderSlots();
    loadTypes(true);

    function renderDateChips() {
      dateBox.textContent = '';
      const ds = dateList();
      ds.forEach((d, i) => {
        const dt = new Date(d + 'T00:00:00');
        const sel = uiSel.dates.has(d);
        const chip = h('div', {
          class: 'chip' + (sel ? ' sel' : ''),
          text: d.slice(5) + ' 周' + WEEKDAY[dt.getDay()],
          onclick: () => {
            if (uiSel.dates.has(d)) uiSel.dates.delete(d); else uiSel.dates.add(d);
            renderDateChips();
          }
        });
        dateBox.appendChild(chip);
      });
    }

    function renderSlots() {
      slotBox.textContent = '';
      SLOTS.forEach((s, i) => {
        const sel = uiSel.slots.has(i);
        slotBox.appendChild(h('div', {
          class: 'chip' + (sel ? ' sel' : ''),
          text: s,
          onclick: () => {
            if (uiSel.slots.has(i)) uiSel.slots.delete(i); else uiSel.slots.add(i);
            renderSlots();
          }
        }));
      });
    }

    async function loadTypes(keep) {
      typeSel.textContent = '';
      typeSel.appendChild(h('option', { value: '', text: '项目…' }));
      if (!uiSel.venueId) return;
      if (!keep) uiSel.typeId = '';
      typeSel.appendChild(h('option', { value: '', text: '加载中…' }));
      try {
        const r = await api.motionTypes(uiSel.venueId);
        TYPES = r.types;
        typeSel.textContent = '';
        typeSel.appendChild(h('option', { value: '', text: '项目…' }));
        r.types.forEach(t => typeSel.appendChild(h('option', {
          value: t.id, text: t.name + (['3', '4'].includes(t.tension) ? '（热门）' : ''),
          selected: t.id === uiSel.typeId
        })));
        if (!uiSel.typeId && r.types.length === 1) uiSel.typeId = r.types[0].id;
        typeSel.value = uiSel.typeId || '';
      } catch (e) {
        typeSel.textContent = '';
        typeSel.appendChild(h('option', { value: '', text: '加载失败：' + e.message }));
      }
    }
  }

  function fillLog(el) {
    el.textContent = '';
    if (!S.logs.length) { el.appendChild(h('div', { class: 'hint', text: '还没有日志' })); return; }
    S.logs.slice(-120).forEach(l => {
      el.appendChild(h('div', {},
        h('span', { class: 't', text: l.t }),
        h('span', { class: l.kind || '', text: l.msg })
      ));
    });
  }

  function renderLog(b) {
    const el = h('div', { class: 'log' });
    fillLog(el);
    b.appendChild(el);
    el.scrollTop = el.scrollHeight;
    ui.logEl = el;
  }

  /* ============================ 初始化 ============================ */

  let VENUES = null, TYPES = [];

  async function bootInner() {
    buildUI();
    log('助手已加载', 'ok');
    try {
      window.__ssm = {
        notify: notify, focusAlert: focusAlert, dismissAlert: dismissAlert, pushTest: pushTest,
        cfg: cfg, S: S, saveCfg: saveCfg, start: start, stop: stop,
        syncClock: syncClock, armSnipe: armSnipe, snipeBurst: snipeBurst,
        nextReleaseAt: nextReleaseAt, serverNow: serverNow, api: api,
        whoami: whoami, checkNow: checkNow, relogin: relogin, authUrl: authUrl, keepAlivePing: keepAlivePing,
        maybeRenew: maybeRenew
      };
    } catch (e) { }
    try {
      VENUES = await api.venues();
      log('场馆列表加载完成，共 ' + VENUES.length + ' 个', 'muted');
    } catch (e) {
      VENUES = [];
      log('场馆列表加载失败：' + e.message, 'err');
    }
    if (uiTab === 'cfg') renderAll();

    // 上次是运行状态 → 自动恢复（页面刷新/重进后不用重新点）
    try {
      const wasRunning = store.get('ssm_running', '0') === '1' && cfg.targets.length > 0;
      const name = await checkNow();
      if (name) {
        store.set('ssm_rl_n', '0');   // 登录成功，重置重登计数
        if (wasRunning) {
          log('检测到上次处于运行状态，3 秒后自动恢复监控', 'muted');
          setTimeout(() => { if (!S.running) start(); renderAll(); }, 3000);
        }
      } else if (wasRunning) {
        log('上次处于运行状态，但当前未登录', 'warn');
        setTimeout(() => relogin('页面加载时发现未登录'), 800);
      } else {
        log('当前未登录（未在监控状态）', 'muted');
      }
    } catch (e) { log('登录检查异常：' + (e && e.message), 'err'); }
    setInterval(keepAlivePing, 30000);
    setInterval(maybeRenew, 5 * 60 * 1000);
  }

  async function boot() {
    try { await bootInner(); }
    catch (e) { showFatal((e && e.message) || String(e)); }
  }

  function waitApp() {
    if (getApp()) { boot(); return; }
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (getApp()) { clearInterval(t); boot(); }
      else if (n > 100) { clearInterval(t); boot(); }
    }, 200);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') waitApp();
  else window.addEventListener('DOMContentLoaded', waitApp);

  // 便于调试/自动化
  window.__SSM = { S, cfg, api, tick, start, stop, placeOrder, saveCfg, getApp, SLOTS };
})();
