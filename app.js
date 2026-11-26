/* Offline-first schedule app with optional Google Apps Script sync. */
(() => {
  'use strict';

  const STORAGE_KEY = 'schedule.entries.v1';
  const SETTINGS_KEY = 'schedule.settings.v1';
  const OUTBOX_KEY = 'schedule.outbox.v1';
  const META_KEY = 'schedule.meta.v1';

  const TYPE_CONFIG = {
    training: { label: 'Тренировка', color: '#1f6feb' },
    event: { label: 'Мероприятие', color: '#8a3ffc' },
    task: { label: 'Задача', color: '#d92d20' },
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
  const toastEl = $('toast');

  const API_URL = 'https://script.google.com/macros/s/AKfycbyx04sF3QiaBgEQ0x-XPgyI5IbFS01EAUVCBvOqxcxxXwoW6cRZorzs9A_WG2puOhUg/exec';

  let entries = loadJSON(STORAGE_KEY, []);
  let outbox = loadJSON(OUTBOX_KEY, []);
  let settings = loadJSON(SETTINGS_KEY, { deviceName: '' });
  let meta = loadJSON(META_KEY, { lastSyncAt: '' });
  let syncing = false;
  let toastTimer;
  let actionDialogState = null;
  
  const actionDialog = document.getElementById('actionDialog');
  const actionDialogForm = document.getElementById('actionDialogForm');
  const actionDialogTitle = document.getElementById('actionDialogTitle');
  const actionDialogDesc = document.getElementById('actionDialogDesc');
  const actionDialogClose = document.getElementById('actionDialogClose');
  const actionDialogCancel = document.getElementById('actionDialogCancel');
  const actionDialogSubmit = document.getElementById('actionDialogSubmit');
  const actionScopeWrap = document.getElementById('actionScopeWrap');
  const actionDateWrap = document.getElementById('actionDateWrap');
  const actionTimeWrap = document.getElementById('actionTimeWrap');
  const actionRepeatWrap = document.getElementById('actionRepeatWrap');
  const actionDateInput = document.getElementById('actionDateInput');
  const actionTimeInput = document.getElementById('actionTimeInput');
  const actionRepeatInput = document.getElementById('actionRepeatInput');
  const actionRepeatUnitInput = document.getElementById('actionRepeatUnitInput');

  init();

  function init() {
    normalizeState();
    bindEvents();
    setDefaultDateTime();
    updateNetStatus();
    ensureAutoRecurrences();
    render();
    updateSyncStatus();
    registerServiceWorker();
    window.addEventListener('online', () => { updateNetStatus(); syncNow({ silent: true }); });
    window.addEventListener('offline', updateNetStatus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { ensureAutoRecurrences(); render(); if (navigator.onLine) syncNow({ silent: true }); }
    });
    window.addEventListener('pageshow', () => { ensureAutoRecurrences(); render(); if (navigator.onLine) syncNow({ silent: true }); });
    window.addEventListener('focus', () => { if (navigator.onLine) syncNow({ silent: true }); });
    if (navigator.onLine) syncNow({ silent: true });
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
    actionDialogClose.addEventListener('click', closeActionDialog);
    actionDialogCancel.addEventListener('click', closeActionDialog);
    actionDialog.addEventListener('click', (e) => { if (e.target === actionDialog) closeActionDialog(); });
    actionDialogForm.addEventListener('submit', onActionDialogSubmit);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && actionDialogState) closeActionDialog(); });
    scheduleList.addEventListener('click', onScheduleClick);
  }

  function normalizeState() {
    if (!Array.isArray(entries)) entries = [];
    if (!Array.isArray(outbox)) outbox = [];
    if (!settings || typeof settings !== 'object') settings = { deviceName: '' };
    if (typeof settings.deviceName !== 'string') settings.deviceName = '';
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
    const type = TYPE_CONFIG[e.type] ? e.type : 'training';
    const status = ['active','cancelled','moved'].includes(e.status) ? e.status : 'active';
    const rt = parseInt(e.repeatTotal, 10);
    const rr = parseInt(e.repeatRemaining, 10);
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
      status,
      seriesId: String(e.seriesId || ''),
      recurrence: ["daily","weekly","monthly"].includes(e.recurrence) ? e.recurrence : "",
      repeatTotal: Number.isFinite(rt) && rt >= 0 ? rt : "",
      repeatRemaining: Number.isFinite(rr) && rr >= 0 ? rr : "",
      movedToId: String(e.movedToId || ""),
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
      showToast(navigator.onLine ? 'Запись сохранена и отправляется.' : 'Запись сохранена на устройстве.')
    }

    persist();
    render();
    resetForm({ keepDate: true });
    syncNow({ silent: true });
  }

  function onScheduleClick(ev) {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    const action = btn.getAttribute("data-action");
    const entry = entries.find((e) => e.id === id && !e.deleted);
    if (!entry) return;

    if (action === "edit") {
      entryId.value = entry.id;
      dateInput.value = entry.date;
      timeInput.value = entry.time;
      infoInput.value = entry.info;
      setSelectedType(entry.type);
      colorInput.value = normalizeColor(entry.color) || defaultColorFor(entry.type);
      cancelEditBtn.classList.remove("hidden");
      saveBtn.textContent = "Сохранить изменения";
      $("formTitle").textContent = "Редактировать запись";
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      infoInput.focus();
      return;
    }

    if (action === "delete") {
      const label = entry.info.length > 40 ? entry.info.slice(0, 40) + "…" : entry.info;
      if (!confirm(`Удалить запись "${label}"?`)) return;
      applyStatusChange(entry, "deleted", { now: new Date().toISOString(), scope: "single" });
      showToast("Запись удалена.");
      if (entryId.value === id) resetForm();
      return;
    }

    if (action === "cancel" || action === "move" || action === "repeat") {
      openActionDialog(action, entry);
    }
  }

  function isSeriesEntry(entry) {
    return Boolean(entry.recurrence || entry.seriesId);
  }

  function openActionDialog(action, entry) {
    actionDialogState = { action, id: entry.id };
    actionDialogForm.reset();
    actionScopeWrap.classList.toggle("hidden", !isSeriesEntry(entry));
    actionDateWrap.classList.add("hidden");
    actionTimeWrap.classList.add("hidden");
    actionRepeatWrap.classList.add("hidden");
    actionDialogSubmit.textContent = "Ок";
    const scopeSingle = actionDialogForm.querySelector('input[name="actionScope"][value="single"]');
    if (scopeSingle) scopeSingle.checked = true;

    if (action === "cancel") {
      actionDialogTitle.textContent = "Отмена";
      actionDialogDesc.textContent = "Пометить запись как отменённую.";
      actionDialogSubmit.textContent = "Отменить";
    } else if (action === "move") {
      actionDialogTitle.textContent = "Перенос";
      actionDialogDesc.textContent = "Новая дата и время.";
      actionDateWrap.classList.remove("hidden");
      actionTimeWrap.classList.remove("hidden");
      actionDateInput.value = entry.date;
      actionTimeInput.value = entry.time;
      actionDialogSubmit.textContent = "Перенести";
    } else if (action === "repeat") {
      actionDialogTitle.textContent = "Повторение";
      actionDialogDesc.textContent = "Период и количество.";
      actionRepeatWrap.classList.remove("hidden");
      actionRepeatUnitInput.value = entry.recurrence || "weekly";
      actionRepeatInput.value = entry.repeatTotal === "" || entry.repeatTotal == null ? "" : String(entry.repeatTotal);
      actionDialogSubmit.textContent = "Сохранить";
    }

    actionDialog.classList.remove("hidden");
    const focusEl = action === "move" ? actionDateInput : action === "repeat" ? actionRepeatInput : actionDialogSubmit;
    setTimeout(() => focusEl && focusEl.focus(), 0);
  }
  function closeActionDialog() {
    actionDialogState = null;
    actionDialog.classList.add("hidden");
    actionDialogForm.reset();
  }

  function getDialogScope() {
    const checked = actionDialogForm.querySelector('input[name="actionScope"]:checked');
    return checked ? checked.value : "single";
  }

  async function onActionDialogSubmit(ev) {
    ev.preventDefault();
    if (!actionDialogState) return;
    const { action, id } = actionDialogState;
    const entry = entries.find((e) => e.id === id && !e.deleted);
    if (!entry) { closeActionDialog(); return; }
    const scope = isSeriesEntry(entry) ? getDialogScope() : "single";
    const now = new Date().toISOString();

    if (action === "cancel") {
      applyStatusChange(entry, "cancelled", { now, scope });
      showToast(scope === "future" ? "Запись и последующие отменены." : "Запись отменена.");
      actionDialogState = null; actionDialog.classList.add("hidden");
      return;
    }

    if (action === "move") {
      const nextDate = actionDateInput.value;
      const nextTime = actionTimeInput.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate) || !/^\d{2}:\d{2}$/.test(nextTime)) { showToast("Укажите дату и время."); return; }
      actionDialog.classList.add("hidden");
      actionDialogState = null;
      moveEntry(entry, nextDate, nextTime, { now, scope });
      showToast(scope === "future" ? "Запись и последующие перенесены." : "Запись перенесена.");
      return;
    }

    if (action === "repeat") {
      const raw = actionRepeatInput.value.trim();
      const count = raw === "" ? "" : parseInt(raw, 10);
      if (count !== "" && (!Number.isFinite(count) || count < 0)) { showToast("Введите число 0 или больше."); return; }
      setupRecurrence(entry, { count, now, recurrence: actionRepeatUnitInput.value || "weekly" });
      showToast("Повторение настроено.");
      actionDialogState = null; actionDialog.classList.add("hidden");
      return;
    }
  }

  function getSeriesScope(entry, actionLabel) {
    if (!entry.recurrence && !entry.seriesId) return "single";
    const msg = actionLabel + ': разово или все последующие периоды?\nOK = все последующие, Отмена = только эту запись';
    return confirm(msg) ? 'future' : 'single';
  }

  function touch(entry, now, patch) {
    Object.assign(entry, patch, { updatedAt: now, syncStatus: 'pending', lastError: '' });
    enqueue({ op: 'upsert', id: entry.id, entry: exportEntry(entry), updatedAt: now });
  }

  function futureSeriesEntries(entry, includeSelf) {
    if (!entry.seriesId) return includeSelf ? [entry] : [];
    const key = entry.date + 'T' + entry.time;
    return entries
      .filter((e) => !e.deleted && e.seriesId === entry.seriesId && (includeSelf ? (e.date + 'T' + e.time >= key) : (e.date + 'T' + e.time > key)))
      .sort(compareEntries);
  }

  function applyStatusChange(entry, status, opts) {
    const now = opts.now;
    const scope = opts.scope;
    const targets = scope === 'future' ? futureSeriesEntries(entry, true) : [entry];
    for (const t of targets) {
      if (status === 'deleted') {
        t.deleted = true; t.updatedAt = now; t.syncStatus = 'pending'; t.lastError = '';
        enqueue({ op: 'delete', id: t.id, entry: exportEntry(t), updatedAt: now });
      } else {
        touch(t, now, { status });
      }
    }
    persist(); render(); syncNow({ silent: true });
  }

  function moveEntry(entry, nextDate, nextTime, opts) {
    const now = opts.now;
    const scope = opts.scope;
    if (scope === "future") {
      const targets = futureSeriesEntries(entry, true);
      const delta = dateDiffDays(entry.date, nextDate);
      for (const t of targets) {
        const nd = addDaysISO(t.date, delta);
        const moved = cloneAsNew(t, nd, nextTime, now);
        moved.status = "active"; moved.movedToId = "";
        touch(t, now, { status: "moved", movedToId: moved.id });
        entries.push(moved);
        enqueue({ op: "upsert", id: moved.id, entry: exportEntry(moved), updatedAt: now });
      }
    } else {
      const moved = cloneAsNew(entry, nextDate, nextTime, now);
      moved.status = "active"; moved.movedToId = "";
      touch(entry, now, { status: "moved", movedToId: moved.id });
      entries.push(moved);
      enqueue({ op: "upsert", id: moved.id, entry: exportEntry(moved), updatedAt: now });
    }
    persist(); render(); syncNow({ silent: true });
  }
  function recurrenceStep(recurrence) {
    if (recurrence === "daily") return { days: 1, months: 0 };
    if (recurrence === "monthly") return { days: 0, months: 1 };
    return { days: 7, months: 0 };
  }
  function addRecurrenceISO(iso, recurrence, n) {
    let cur = iso;
    for (let i = 0; i < n; i++) {
      const step = recurrenceStep(recurrence);
      if (step.months) cur = addMonthsISO(cur, step.months);
      else cur = addDaysISO(cur, step.days);
    }
    return cur;
  }
  function addMonthsISO(iso, months) {
    const d = new Date(iso + "T00:00:00");
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() < day) d.setDate(0);
    return localDateValue(d);
  }
  function recurrenceLabel(rec) {
    return rec === "daily" ? "Ежедневно" : rec === "monthly" ? "Ежемесячно" : "Еженедельно";
  }

  function setupRecurrence(entry, opts) {
    const now = opts.now;
    const count = opts.count; // "" = infinite
    const recurrence = ["daily","weekly","monthly"].includes(opts.recurrence) ? opts.recurrence : "weekly";
    const seriesId = entry.seriesId || entry.id;
    touch(entry, now, { seriesId, recurrence, repeatTotal: count, repeatRemaining: count === "" ? "" : Math.max(0, count - 1), status: "active" });
    // remove future auto/series entries beyond what we need for clean reset
    const existing = entries.filter((e) => e.seriesId === seriesId && !e.deleted).sort(compareEntries);
    if (count === "") {
      for (const e of existing) {
        if (e.id === entry.id) continue;
        if ((e.date + "T" + e.time) > (entry.date + "T" + entry.time)) {
          e.deleted = true; e.updatedAt = now; e.syncStatus = "pending"; e.lastError = "";
          enqueue({ op: "delete", id: e.id, entry: exportEntry(e), updatedAt: now });
        }
      }
      ensureNextAutoOccurrence(entry, now);
    } else {
      const total = Number(count);
      for (let i = 1; i < total; i++) {
        const d = addRecurrenceISO(entry.date, recurrence, i);
        const has = existing.some((e) => !e.deleted && e.date === d && e.time === entry.time);
        if (!has) {
          const n = normalizeEntry({ ...entry, id: makeId(), date: d, time: entry.time, updatedAt: now, deleted:false, syncStatus:"pending", lastError:"", seriesId, recurrence, repeatTotal: total, repeatRemaining: Math.max(0, total - i - 1), status:"active", movedToId:"" });
          entries.push(n);
          enqueue({ op: "upsert", id: n.id, entry: exportEntry(n), updatedAt: now });
        }
      }
      // trim extra future occurrences
      for (const e of existing) {
        if (e.id === entry.id || e.deleted) continue;
        const idx = occurrenceIndex(entry, e);
        if (idx >= total) {
          e.deleted = true; e.updatedAt = now; e.syncStatus = "pending"; e.lastError = "";
          enqueue({ op: "delete", id: e.id, entry: exportEntry(e), updatedAt: now });
        } else if (idx > 0) {
          touch(e, now, { recurrence, repeatTotal: total, repeatRemaining: Math.max(0, total - idx - 1), seriesId });
        }
      }
    }
    persist(); render(); syncNow({ silent: true });
  }

  function occurrenceIndex(base, e) {
    // approximate by stepping forward; small counts expected
    for (let i=0;i<400;i++) { if (addRecurrenceISO(base.date, base.recurrence || e.recurrence || "weekly", i) === e.date) return i; }
    return -1;
  }

  function ensureNextAutoOccurrence(entry, now) {
    if (!entry.recurrence || entry.repeatTotal !== "") return;
    const seriesId = entry.seriesId || entry.id;
    const series = entries.filter((e) => !e.deleted && e.seriesId === seriesId && e.status !== "cancelled").sort(compareEntries);
    const last = series[series.length - 1] || entry;
    const nextDate = addRecurrenceISO(last.date, entry.recurrence, 1);
    // Extend only when day of current/last occurrence has arrived (avoid infinite clutter)
    const today = localDateValue(new Date());
    if (last.date > today) return;
    const has = series.some((e) => e.date === nextDate && e.time === entry.time);
    if (has) return;
    const n = normalizeEntry({ ...entry, id: makeId(), date: nextDate, updatedAt: now, deleted:false, syncStatus:"pending", lastError:"", status:"active", movedToId:"", repeatTotal:"", repeatRemaining:"" });
    entries.push(n);
    enqueue({ op: "upsert", id: n.id, entry: exportEntry(n), updatedAt: now });
  }
  function cloneAsNew(entry, date, time, now) {
    return normalizeEntry({ ...entry, id: makeId(), date, time, updatedAt: now, deleted:false, syncStatus:'pending', lastError:'', status:'active', movedToId:'', repeatRemaining: entry.repeatTotal === '' ? '' : entry.repeatRemaining });
  }

  function addDaysISO(iso, days) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return localDateValue(d);
  }
  function dateDiffDays(a,b){ const da=new Date(a+'T00:00:00'); const db=new Date(b+'T00:00:00'); return Math.round((db-da)/86400000); }
  function resetForm(opts = {}) {
    entryId.value = '';
    if (!opts.keepDate) setDefaultDateTime(); else { timeInput.value = ''; infoInput.focus(); }
    infoInput.value = opts.keepDate ? '' : infoInput.value;
    setSelectedType('training');
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
    const li = document.createElement("li");
    const color = normalizeColor(entry.color) || defaultColorFor(entry.type);
    const pending = entry.syncStatus === "pending";
    const error = entry.syncStatus === "error";
    const status = entry.status || "active";
    li.className = "entry-row" + (status !== "active" ? " entry-row-inactive" : "");
    const statusBadge = status === "cancelled"
      ? '<span class="badge badge-cancelled">Отмена</span>'
      : status === "moved"
        ? '<span class="badge badge-moved">Перенос</span>'
        : "";
    const recurBadge = entry.recurrence
      ? `<span class="badge badge-recur">${escapeHTML(recurrenceLabel(entry.recurrence))}${entry.repeatTotal === "" ? " · ∞" : (entry.repeatRemaining !== "" && entry.repeatRemaining != null ? ` · ${entry.repeatRemaining}` : "")}</span>`
      : "";
    li.innerHTML = `
      <div class="entry-time">${escapeHTML(entry.time)}</div>
      <div class="entry-main">
        <div class="entry-info ${status !== 'active' ? 'entry-info-inactive' : ''}">
          <span class="entry-color" style="background:${escapeAttr(color)};box-shadow:0 0 0 2px #fff,0 0 0 4px ${escapeAttr(color)}33"></span>
          <span class="entry-text">${escapeHTML(entry.info)}</span>
        </div>
        <div class="entry-meta">
          <span class="badge">${escapeHTML(getTypeLabel(entry.type))}</span>
          ${statusBadge}
          ${recurBadge}
          ${pending ? '<span class="badge badge-pending">Ждёт отправки</span>' : ''}
          ${error ? `<span class="badge badge-error" title="${escapeAttr(entry.lastError || 'Ошибка синхронизации')}">Ошибка</span>` : ''}
        </div>
      </div>
      <div class="entry-actions">
        <button class="icon-btn" type="button" data-action="edit" data-id="${escapeAttr(entry.id)}" aria-label="Редактировать" title="Редактировать">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm2.92 2.83H5v-.92l9.06-9.06.92.92L5.92 20.08zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="icon-btn" type="button" data-action="cancel" data-id="${escapeAttr(entry.id)}" aria-label="Отменить" title="Отмена">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm3.54-10.12L13.41 12l2.13 2.12-1.42 1.42L12 13.41l-2.12 2.13-1.42-1.42L10.59 12 8.46 9.88l1.42-1.42L12 10.59l2.12-2.13 1.42 1.42z"/></svg>
        </button>
        <button class="icon-btn" type="button" data-action="move" data-id="${escapeAttr(entry.id)}" aria-label="Перенести" title="Перенос">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10l4-4V6a2 2 0 0 0-2-2zm0 11h-3a2 2 0 0 0-2 2v3H5V9h14v6zm-8 2h2v2l3-3-3-3v2h-2v2z"/></svg>
        </button>
        <button class="icon-btn" type="button" data-action="repeat" data-id="${escapeAttr(entry.id)}" aria-label="Повторение" title="Повторение">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
        </button>
        <button class="icon-btn danger" type="button" data-action="delete" data-id="${escapeAttr(entry.id)}" aria-label="Удалить" title="Удалить">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2h4v2H4V6h4l1-2zm1 6h2v8h-2v-8zm4 0h2v8h-2v-8z"/></svg>
        </button>
      </div>
    `;
    return li;
  }
  async function syncNow(opts = {}) {
    const silent = Boolean(opts.silent);
    if (syncing) return;
    if (!navigator.onLine) {
      updateSyncStatus();
      if (!silent) showToast('Нет интернета. Данные отправятся позже.');
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
    const res = await postJson(API_URL, payload);
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
    const res = await postJson(API_URL, { action: 'pull' });
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
        }
        continue;
      }
      if ((r.updatedAt || '') >= (local.updatedAt || '')) {
        byId.set(r.id, { ...r, syncStatus: 'synced', lastError: '' });
      }
    }
    entries = Array.from(byId.values());
    entries = entries.filter((e) => !e.deleted || outbox.some((o) => o.id === e.id));
    ensureAutoRecurrences();
    persist();
  }

  function ensureAutoRecurrences() {
    const now = new Date().toISOString();
    const activeRecurring = entries.filter((e) => !e.deleted && e.recurrence && e.repeatTotal === "" && e.status !== "cancelled");
    for (const e of activeRecurring) ensureNextAutoOccurrence(e, now);
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
      status: entry.status || 'active',
      seriesId: entry.seriesId || '',
      recurrence: entry.recurrence || '',
      repeatTotal: entry.repeatTotal === '' || entry.repeatTotal == null ? '' : Number(entry.repeatTotal),
      repeatRemaining: entry.repeatRemaining === '' || entry.repeatRemaining == null ? '' : Number(entry.repeatRemaining),
      movedToId: entry.movedToId || '',
    };
  }

  function updateNetStatus() {
    const online = navigator.onLine;
    netStatus.textContent = online ? 'Онлайн' : 'Офлайн';
    netStatus.className = 'status-pill ' + (online ? 'status-online' : 'status-offline');
  }

  function updateSyncStatus(state) {
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
    return checked ? checked.value : 'training';
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
