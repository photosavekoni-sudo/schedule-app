/* Offline-first schedule app with optional Google Apps Script sync. */
(() => {
  'use strict';

  const STORAGE_KEY = 'schedule.entries.v1';
  const SETTINGS_KEY = 'schedule.settings.v1';
  const OUTBOX_KEY = 'schedule.outbox.v1';
  const META_KEY = 'schedule.meta.v1';

  const TYPE_CONFIG = {
    client: { label: 'Клиент', color: '#1f6feb' },
    event: { label: 'Мероприятие', color: '#8a3ffc' },
    task: { label: 'Задача', color: '#14866d' },
  };

  const $ = (id) => document.getElementById(id);
  const form = $('entryForm');
  const entryId = $('entryId');
  const dateInput = $('dateInput');
  const timeInput = $('timeInput');
  const infoInput = $('infoInput');
  const colorInput = $('colorInput');
  const saveBtn = $('saveBtn');
  const cancelEditBtn = $('cancelEditBtn');
  const resetColorBtn = $('resetColorBtn');
  const scheduleList = $('scheduleList');
  const emptyTemplate = $('emptyTemplate');
  const searchInput = $('searchInput');
  const netStatus = $('netStatus');
  const syncStatus = $('syncStatus');
  const syncBtn = $('syncBtn');
  const settingsBtn = $('settingsBtn');
  const settingsDialog = $('settingsDialog');
  const apiUrlInput = $('apiUrlInput');
  const deviceNameInput = $('deviceNameInput');
  const saveSettingsBtn = $('saveSettingsBtn');
  const toastEl = $('toast');

  let entries = loadJSON(STORAGE_KEY, []);
  let outbox = loadJSON(OUTBOX_KEY, []);
  let settings = loadJSON(SETTINGS_KEY, { apiUrl: '', deviceName: '' });
  let meta = loadJSON(META_KEY, { lastSyncAt: '' });
  let syncing = false;
  let toastTimer;

  init();

  function init() {
    normalizeState();
    bindEvents();
    applySettingsToUI();
    setDefaultDateTime();
    updateNetStatus();
    render();
    updateSyncStatus();
    registerServiceWorker();
    window.addEventListener('online', () => { updateNetStatus(); syncNow({ silent: true }); });
    window.addEventListener('offline', updateNetStatus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) syncNow({ silent: true });
    });
    if (navigator.onLine && settings.apiUrl) syncNow({ silent: true });
  }

  function bindEvents() {
    form.addEventListener('submit', onSubmit);
    cancelEditBtn.addEventListener('click', resetForm);
    resetColorBtn.addEventListener('click', () => { colorInput.value = defaultColorFor(getSelectedType()); });
    document.querySelectorAll('input[name="type"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!entryId.value) colorInput.value = defaultColorFor(getSelectedType());
      });
    });
    searchInput.addEventListener('input', render);
    syncBtn.addEventListener('click', () => syncNow());
    settingsBtn.addEventListener('click', () => {
      applySettingsToUI();
      if (typeof settingsDialog.showModal === 'function') settingsDialog.showModal();
      else settingsDialog.setAttribute('open', '');
    });
    saveSettingsBtn.addEventListener('click', saveSettings);
    scheduleList.addEventListener('click', onScheduleClick);
  }

  function normalizeState() {
    if (!Array.isArray(entries)) entries = [];
    if (!Array.isArray(outbox)) outbox = [];
    if (!settings || typeof settings !== 'object') settings = { apiUrl: '', deviceName: '' };
    if (!meta || typeof meta !== 'object') meta = { lastSyncAt: '' };
    entries = entries.filter(isValidEntry).map(normalizeEntry);
    outbox = outbox.filter((op) => op && typeof op.id === 'string' && op.entry);
    dedupeEntries();
    persist();
  }

  function isValidEntry(e) {
    return e && typeof e === 'object' && typeof e.id === 'string' && typeof e.date === 'string' && typeof e.time === 'string';
  }

  function normalizeEntry(e) {
    const type = TYPE_CONFIG[e.type] ? e.type : 'client';
    return {
      id: String(e.id),
      date: String(e.date || ''),
      time: String(e.time || ''),
      info: String(e.info || '').trim(),
      type,
      color: normalizeColor(e.color) || TYPE_CONFIG[type].color,
      updatedAt: String(e.updatedAt || new Date().toISOString()),
      deleted: Boolean(e.deleted),
      sourceDevice: String(e.sourceDevice || ''),
      syncStatus: e.syncStatus === 'error' ? 'error' : (e.syncStatus === 'pending' ? 'pending' : 'synced'),
      lastError: String(e.lastError || ''),
    };
  }

  function dedupeEntries() {
    const map = new Map();
    for (const e of entries) {
      const prev = map.get(e.id);
      if (!prev || e.updatedAt >= prev.updatedAt) map.set(e.id, e);
    }
    entries = Array.from(map.values());
  }

  function onSubmit(ev) {
    ev.preventDefault();
    const date = dateInput.value;
    const time = timeInput.value;
    const info = infoInput.value.trim();
    const type = getSelectedType();
    const color = normalizeColor(colorInput.value) || defaultColorFor(type);

    if (!date || !time || !info) {
      showToast('Заполните дату, время и информацию.');
      return;
    }

    const now = new Date().toISOString();
    const existingId = entryId.value;
    const device = settings.deviceName || getDeviceLabel();

    if (existingId) {
      const idx = entries.findIndex((e) => e.id === existingId);
      if (idx === -1) { showToast('Запись не найдена.'); resetForm(); return; }
      const next = normalizeEntry({ ...entries[idx], date, time, info, type, color, updatedAt: now, deleted: false, sourceDevice: device, syncStatus: 'pending', lastError: '' });
      entries[idx] = next;
      enqueue({ op: 'upsert', id: next.id, entry: exportEntry(next), updatedAt: now });
      showToast('Запись обновлена.');
    } else {
      const next = normalizeEntry({ id: makeId(), date, time, info, type, color, updatedAt: now, deleted: false, sourceDevice: device, syncStatus: 'pending', lastError: '' });
      entries.push(next);
      enqueue({ op: 'upsert', id: next.id, entry: exportEntry(next), updatedAt: now });
      showToast(navigator.onLine && settings.apiUrl ? 'Запись сохранена и отправляется.' : 'Запись сохранена на устройстве.');
    }

    persist();
    render();
    resetForm({ keepDate: true });
    syncNow({ silent: true });
  }

  function onScheduleClick(ev) {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;

    if (action === 'edit') {
      entryId.value = entry.id;
      dateInput.value = entry.date;
      timeInput.value = entry.time;
      infoInput.value = entry.info;
      setSelectedType(entry.type);
      colorInput.value = normalizeColor(entry.color) || defaultColorFor(entry.type);
      cancelEditBtn.classList.remove('hidden');
      saveBtn.textContent = 'Сохранить изменения';
      $('formTitle').textContent = 'Редактировать запись';
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      infoInput.focus();
    }

    if (action === 'delete') {
      const label = entry.info.length > 40 ? entry.info.slice(0, 40) + '…' : entry.info;
      if (!confirm(`Удалить запись "${label}"?`)) return;
      const now = new Date().toISOString();
      entry.deleted = true;
      entry.updatedAt = now;
      entry.syncStatus = 'pending';
      entry.lastError = '';
      enqueue({ op: 'delete', id: entry.id, entry: exportEntry(entry), updatedAt: now });
      persist();
      render();
      showToast('Запись удалена.');
      if (entryId.value === id) resetForm();
      syncNow({ silent: true });
    }
  }

  function resetForm(opts = {}) {
    entryId.value = '';
    if (!opts.keepDate) setDefaultDateTime(); else { timeInput.value = ''; infoInput.focus(); }
    infoInput.value = opts.keepDate ? '' : infoInput.value;
    setSelectedType('client');
    colorInput.value = TYPE_CONFIG.client.color;
    cancelEditBtn.classList.add('hidden');
    saveBtn.textContent = 'Сохранить запись';
    $('formTitle').textContent = 'Добавить в расписание';
    if (!opts.keepDate) {
      infoInput.value = '';
      setDefaultDateTime();
    }
  }

  function render() {
    const q = searchInput.value.trim().toLowerCase();
    const visible = entries
      .filter((e) => !e.deleted)
      .filter((e) => !q || e.info.toLowerCase().includes(q) || getTypeLabel(e.type).toLowerCase().includes(q) || formatDate(e.date).includes(q))
      .sort(compareEntries);

    scheduleList.innerHTML = '';
    if (!visible.length) {
      scheduleList.appendChild(emptyTemplate.content.cloneNode(true));
      return;
    }

    const groups = groupByDate(visible);
    for (const [date, items] of groups) {
      const section = document.createElement('section');
      section.className = 'day-group';

      const header = document.createElement('div');
      header.className = 'day-header';
      header.innerHTML = `
        <div class="day-date">${escapeHTML(formatDate(date))}</div>
        <div class="day-weekday">${escapeHTML(weekdayLabel(date))}</div>
        <div class="day-count">${items.length} ${plural(items.length, 'запись', 'записи', 'записей')}</div>
      `;

      const list = document.createElement('ul');
      list.className = 'entry-list';
      for (const entry of items) list.appendChild(renderEntry(entry));

      section.append(header, list);
      scheduleList.appendChild(section);
    }
  }

  function renderEntry(entry) {
    const li = document.createElement('li');
    li.className = 'entry-row';
    const color = normalizeColor(entry.color) || defaultColorFor(entry.type);
    const pending = entry.syncStatus === 'pending';
    const error = entry.syncStatus === 'error';
    li.innerHTML = `
      <div class="entry-time">${escapeHTML(entry.time)}</div>
      <div class="entry-main">
        <div class="entry-info">
          <span class="entry-color" style="background:${escapeAttr(color)}"></span>
          <span>${escapeHTML(entry.info)}</span>
        </div>
        <div class="entry-meta">
          <span class="badge">${escapeHTML(getTypeLabel(entry.type))}</span>
          ${pending ? '<span class="badge badge-pending">Ждёт отправки</span>' : ''}
          ${error ? `<span class="badge badge-error" title="${escapeAttr(entry.lastError || 'Ошибка синхронизации')}">Ошибка синхронизации</span>` : ''}
        </div>
      </div>
      <div class="entry-actions">
        <button class="icon-btn" type="button" data-action="edit" data-id="${escapeAttr(entry.id)}" aria-label="Редактировать">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm2.92 2.83H5v-.92l9.06-9.06.92.92L5.92 20.08zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="icon-btn danger" type="button" data-action="delete" data-id="${escapeAttr(entry.id)}" aria-label="Удалить">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2h4v2H4V6h4l1-2zm1 6h2v8h-2v-8zm4 0h2v8h-2v-8z"/></svg>
        </button>
      </div>
    `;
    return li;
  }

  async function syncNow(opts = {}) {
    const silent = Boolean(opts.silent);
    if (syncing) return;
    if (!settings.apiUrl) {
      updateSyncStatus();
      if (!silent) showToast('Укажите URL Apps Script в настройках.');
      return;
    }
    if (!navigator.onLine) {
      updateSyncStatus();
      if (!silent) showToast('Нет подключения. Записи отправятся позже.');
      return;
    }

    syncing = true;
    updateSyncStatus('syncing');
    try {
      await flushOutbox();
      await pullFromServer();
      meta.lastSyncAt = new Date().toISOString();
      persist();
      render();
      updateSyncStatus();
      if (!silent) showToast('Синхронизация завершена.');
    } catch (err) {
      console.error(err);
      markPendingError(err);
      updateSyncStatus('error');
      if (!silent) showToast('Не удалось синхронизироваться. Данные сохранены локально.');
    } finally {
      syncing = false;
      updateSyncStatus();
    }
  }

  async function flushOutbox() {
    if (!outbox.length) return;
    const pendingOps = collapseOutbox(outbox);
    const payload = { action: 'push', device: settings.deviceName || getDeviceLabel(), ops: pendingOps };
    const res = await postJson(settings.apiUrl, payload);
    if (!res || res.ok !== true) throw new Error(res && res.error ? res.error : 'Push failed');

    const ackedIds = new Set(pendingOps.map((o) => o.id + ':' + o.updatedAt));
    outbox = outbox.filter((o) => !ackedIds.has(o.id + ':' + o.updatedAt));
    // Mark entries as synced if no newer outbox op exists.
    for (const e of entries) {
      if (e.deleted) continue;
      const stillPending = outbox.some((o) => o.id === e.id);
      if (!stillPending) { e.syncStatus = 'synced'; e.lastError = ''; }
    }
    // Remove deleted entries that are fully synced.
    entries = entries.filter((e) => !(e.deleted && !outbox.some((o) => o.id === e.id)));
    persist();
  }

  async function pullFromServer() {
    const res = await postJson(settings.apiUrl, { action: 'pull' });
    if (!res || res.ok !== true || !Array.isArray(res.entries)) throw new Error(res && res.error ? res.error : 'Pull failed');
    const remote = res.entries.filter(isValidEntry).map(normalizeEntry);
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const r of remote) {
      const local = byId.get(r.id);
      if (!local) {
        byId.set(r.id, { ...r, syncStatus: 'synced', lastError: '' });
        continue;
      }
      const localPending = outbox.some((o) => o.id === r.id);
      if (localPending) {
        // Keep local if it's newer or same age; server will get it on next push.
        if ((r.updatedAt || '') > (local.updatedAt || '')) {
          // Conflict: remote newer but local has pending op. Prefer local pending change,
          // but keep remote if local was just a stale pending marker. Here local wins.
        }
        continue;
      }
      if ((r.updatedAt || '') >= (local.updatedAt || '')) {
        byId.set(r.id, { ...r, syncStatus: 'synced', lastError: '' });
      }
    }
    entries = Array.from(byId.values());
    // Keep locally deleted tombstones only while pending.
    entries = entries.filter((e) => !e.deleted || outbox.some((o) => o.id === e.id));
    persist();
  }

  function collapseOutbox(ops) {
    const map = new Map();
    for (const op of ops) {
      const prev = map.get(op.id);
      if (!prev || (op.updatedAt || '') >= (prev.updatedAt || '')) map.set(op.id, op);
    }
    return Array.from(map.values()).map((op) => ({ op: op.op, id: op.id, entry: op.entry, updatedAt: op.updatedAt }));
  }

  function enqueue(op) {
    outbox.push(op);
    outbox = collapseOutbox(outbox);
  }

  function markPendingError(err) {
    const msg = String(err && err.message ? err.message : err).slice(0, 160);
    for (const e of entries) {
      if (outbox.some((o) => o.id === e.id)) { e.syncStatus = 'error'; e.lastError = msg; }
    }
    persist();
    render();
  }

  async function postJson(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      // Apps Script web apps redirect; POST may be converted to GET on 302 by browsers.
      // Use POST with text/plain (no preflight). If response isn't valid JSON, fall back to GET.
      let res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: controller.signal,
      });
      let text = await res.text();
      let parsed = tryParseJson(text);
      if (parsed) return parsed;

      // Fallback for GAS redirect/method quirks: GET with encoded payload.
      const payload = encodeURIComponent(JSON.stringify(body));
      res = await fetch(`${url}${url.includes('?') ? '&' : '?'}payload=${payload}`, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      text = await res.text();
      parsed = tryParseJson(text);
      if (parsed) return parsed;
      throw new Error('Некорректный ответ сервера');
    } finally {
      clearTimeout(timer);
    }
  }

  function tryParseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function exportEntry(entry) {
    return {
      id: entry.id,
      date: entry.date,
      time: entry.time,
      info: entry.info,
      type: entry.type,
      color: entry.color,
      updatedAt: entry.updatedAt,
      deleted: Boolean(entry.deleted),
      sourceDevice: entry.sourceDevice || settings.deviceName || getDeviceLabel(),
    };
  }

  function saveSettings() {
    const url = apiUrlInput.value.trim();
    if (url && !/^https:\/\/script\.google\.com\//.test(url)) {
      showToast('URL должен начинаться с https://script.google.com/');
      return;
    }
    settings.apiUrl = url;
    settings.deviceName = deviceNameInput.value.trim();
    persist();
    settingsDialog.close();
    updateSyncStatus();
    showToast('Настройки сохранены.');
    if (settings.apiUrl) syncNow({ silent: true });
  }

  function applySettingsToUI() {
    apiUrlInput.value = settings.apiUrl || '';
    deviceNameInput.value = settings.deviceName || '';
  }

  function updateNetStatus() {
    const online = navigator.onLine;
    netStatus.textContent = online ? 'Онлайн' : 'Офлайн';
    netStatus.className = 'status-pill ' + (online ? 'status-online' : 'status-offline');
  }

  function updateSyncStatus(state) {
    if (!settings.apiUrl) {
      syncStatus.textContent = 'Синхронизация не настроена';
      syncStatus.className = 'status-pill status-idle';
      return;
    }
    if (syncing || state === 'syncing') {
      syncStatus.textContent = 'Синхронизация…';
      syncStatus.className = 'status-pill status-sync';
      return;
    }
    if (state === 'error' || entries.some((e) => e.syncStatus === 'error')) {
      syncStatus.textContent = 'Ошибка синхронизации';
      syncStatus.className = 'status-pill status-error';
      return;
    }
    const pendingCount = outbox.length;
    if (pendingCount > 0) {
      syncStatus.textContent = `Ожидает отправки: ${pendingCount}`;
      syncStatus.className = 'status-pill status-offline';
      return;
    }
    if (meta.lastSyncAt) {
      const t = new Date(meta.lastSyncAt);
      syncStatus.textContent = 'Синхронизировано ' + t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else {
      syncStatus.textContent = 'Готово к синхронизации';
    }
    syncStatus.className = 'status-pill status-online';
  }

  function compareEntries(a, b) {
    return (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || '') || (a.updatedAt || '').localeCompare(b.updatedAt || '');
  }

  function groupByDate(items) {
    const map = new Map();
    for (const item of items) {
      if (!map.has(item.date)) map.set(item.date, []);
      map.get(item.date).push(item);
    }
    return map;
  }

  function formatDate(isoDate) {
    const [y, m, d] = (isoDate || '').split('-');
    if (!y || !m || !d) return isoDate || '';
    return `${d}.${m}`;
  }

  function weekdayLabel(isoDate) {
    const dt = new Date(isoDate + 'T00:00:00');
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString('ru-RU', { weekday: 'long' });
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function getSelectedType() {
    const checked = document.querySelector('input[name="type"]:checked');
    return checked ? checked.value : 'client';
  }
  function setSelectedType(type) {
    const input = document.querySelector(`input[name="type"][value="${CSS.escape(type)}"]`);
    if (input) input.checked = true;
  }
  function defaultColorFor(type) { return (TYPE_CONFIG[type] || TYPE_CONFIG.client).color; }
  function getTypeLabel(type) { return (TYPE_CONFIG[type] || TYPE_CONFIG.client).label; }
  function normalizeColor(value) { return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value.toLowerCase() : ''; }
  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function getDeviceLabel() {
    return (navigator.platform || 'device') + '-' + Math.random().toString(36).slice(2, 6);
  }

  function setDefaultDateTime() {
    const now = new Date();
    dateInput.value = localDateValue(now);
    const mins = now.getMinutes();
    const rounded = new Date(now.getTime());
    rounded.setMinutes(mins + (30 - (mins % 30 || 30)), 0, 0);
    timeInput.value = `${String(rounded.getHours()).padStart(2, '0')}:${String(rounded.getMinutes()).padStart(2, '0')}`;
    colorInput.value = defaultColorFor(getSelectedType());
  }

  function localDateValue(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function persist() {
    saveJSON(STORAGE_KEY, entries);
    saveJSON(OUTBOX_KEY, outbox);
    saveJSON(SETTINGS_KEY, settings);
    saveJSON(META_KEY, meta);
  }
  function loadJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.error('Storage error', e); showToast('Не удалось сохранить данные в браузере.'); }
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(str) { return escapeHTML(str).replace(/`/g, '&#96;'); }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(() => {});
    } catch (e) {
      console.warn('SW registration failed', e);
    }
  }
})();
