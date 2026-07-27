'use strict';

const $ = (sel) => document.querySelector(sel);

const state = { page: 1, pageSize: 50, total: 0 };

// ---- 共用 ----
async function api(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `請求失敗（${res.status}）`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-TW', { hour12: false });
}

let currentUser = null;

async function loadCurrentUser() {
  try {
    currentUser = await api('/api/current-user');
    const label = currentUser.staff
      ? `${currentUser.staff.name} (${currentUser.staff.employee_id || currentUser.windows_username})`
      : `Windows: ${currentUser.windows_username || '-'}`;
    $('#current-user-badge').textContent = label;
    autoFillUserFields();
  } catch {
    $('#current-user-badge').textContent = '使用者讀取失敗';
  }
}

function autoFillUserFields() {
  if (!currentUser) return;
  const displayName = currentUser.staff ? currentUser.staff.name : currentUser.windows_username;
  ['#upload-by', '#bulk-by', '#redeem-by'].forEach((sel) => {
    const el = $(sel);
    if (el && !el.value) el.value = displayName || '';
  });
}

// ---- 分頁切換 ----
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'overview') loadStats();
    if (btn.dataset.tab === 'codes') { loadFilterOptions(); loadCodes(); }
    if (btn.dataset.tab === 'batches') loadBatches();
    if (btn.dataset.tab === 'bulk') loadCampaignList();
    if (btn.dataset.tab === 'settings') { loadSyncStatus(); loadBackupStatus(); loadDbConfig(); }
    if (btn.dataset.tab === 'staff') loadStaff();
  });
});

// ---- 總覽 ----
async function loadStats() {
  try {
    const [s, campaigns] = await Promise.all([api('/api/stats'), api('/api/campaigns')]);
    $('#stat-total').textContent = s.total;
    $('#stat-available').textContent = s.available;
    $('#stat-earmarked').textContent = s.earmarked ?? 0;
    $('#stat-redeemed').textContent = s.redeemed;
    $('#stat-batches').textContent = s.batch_count;
    const body = $('#campaign-stats');
    const fmt = (n) => n == null ? '-' : `$${Number(n).toLocaleString()}`;
    body.innerHTML = campaigns.length
      ? campaigns.map((c) => {
        const over = c.remaining != null && c.remaining < 0;
        const dateRange = c.start_date && c.end_date
          ? `${c.start_date} ~ ${c.end_date}`
          : (c.start_date || c.end_date || '–');
        return `<tr class="${over ? 'over-budget' : ''}">
          <td>${escapeHtml(c.name)}</td>
          <td style="white-space:nowrap;font-size:0.85em">${escapeHtml(dateRange)}</td>
          <td>${c.planned_count || '–'}</td>
          <td>${c.redeemed_count}</td>
          <td>${c.budget ? fmt(c.budget) : '–'}</td>
          <td>${fmt(c.cost || 0)}</td>
          <td>${c.budget ? fmt(c.remaining) : '–'}</td>
          <td><button class="btn btn-small" data-action="edit-campaign" data-id="${c.id}">編輯</button></td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="8" class="empty">尚無活動</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- 活動管理 ----
$('#btn-add-campaign').addEventListener('click', () => {
  $('#campaign-dialog-title').textContent = '新增活動';
  $('#campaign-id').value = '';
  $('#campaign-form').reset();
  $('#campaign-planned').value = 0;
  $('#campaign-budget').value = 0;
  $('#campaign-dialog').showModal();
});

$('#campaign-cancel').addEventListener('click', () => $('#campaign-dialog').close());

$('#campaign-stats').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="edit-campaign"]');
  if (!btn) return;
  try {
    const campaigns = await api('/api/campaigns');
    const campaign = campaigns.find((c) => c.id == btn.dataset.id);
    if (!campaign) return;
    $('#campaign-dialog-title').textContent = '編輯活動';
    $('#campaign-id').value = campaign.id;
    $('#campaign-name').value = campaign.name;
    $('#campaign-start').value = campaign.start_date || '';
    $('#campaign-end').value = campaign.end_date || '';
    $('#campaign-planned').value = campaign.planned_count || 0;
    $('#campaign-budget').value = campaign.budget || 0;
    $('#campaign-dialog').showModal();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#campaign-id').value;
  const body = {
    name: $('#campaign-name').value,
    start_date: $('#campaign-start').value,
    end_date: $('#campaign-end').value,
    planned_count: Number($('#campaign-planned').value) || 0,
    budget: Number($('#campaign-budget').value) || 0,
  };
  try {
    await api(id ? `/api/campaigns/${id}` : '/api/campaigns', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('#campaign-dialog').close();
    toast(id ? '活動已更新' : '活動已新增');
    loadStats();
    loadCampaignList();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- 禮券列表 ----
function currentFilters() {
  const params = new URLSearchParams();
  const q = $('#filter-q').value.trim();
  if (q) params.set('q', q);
  if ($('#filter-status').value) params.set('status', $('#filter-status').value);
  if ($('#filter-batch').value) params.set('batch_id', $('#filter-batch').value);
  if ($('#filter-campaign').value) params.set('campaign_id', $('#filter-campaign').value);
  return params;
}

async function loadCodes() {
  const params = currentFilters();
  params.set('page', state.page);
  params.set('page_size', state.pageSize);
  try {
    const data = await api(`/api/codes?${params}`);
    state.total = data.total;
    const body = $('#codes-body');
    body.innerHTML = data.items.length
      ? data.items.map(renderCodeRow).join('')
      : '<tr><td colspan="12" class="empty">沒有符合條件的禮券</td></tr>';
    const totalPages = Math.max(1, Math.ceil(data.total / state.pageSize));
    $('#page-info').textContent = `第 ${data.page} / ${totalPages} 頁（共 ${data.total} 筆）`;
    $('#btn-prev').disabled = data.page <= 1;
    $('#btn-next').disabled = data.page >= totalPages;
  } catch (err) {
    toast(err.message, true);
  }
}

const STATUS_BADGE = {
  redeemed: '<span class="badge badge-redeemed">已兌換</span>',
  earmarked: '<span class="badge badge-earmarked">已圈存</span>',
  available: '<span class="badge badge-available">未兌換</span>',
};

function renderCodeRow(item) {
  const status = item.display_status || item.status;
  const statusBadge = STATUS_BADGE[status] || STATUS_BADGE.available;
  const action = status === 'redeemed'
    ? `<button class="btn btn-small btn-danger" data-action="unredeem" data-id="${item.id}" data-code="${escapeHtml(item.code)}">取消兌換</button>`
    : `<button class="btn btn-small" data-action="redeem" data-id="${item.id}" data-code="${escapeHtml(item.code)}">標記兌換</button>`;
  const urlCell = item.redeem_url
    ? `<a href="${escapeHtml(item.redeem_url)}" target="_blank" rel="noopener" class="redeem-link" title="${escapeHtml(item.redeem_url)}">開啟連結</a>`
    : '';
  let earmarkCell = '';
  if (item.earmark_start || item.earmark_end) {
    earmarkCell = `${escapeHtml(item.earmark_start || '?')} ~ ${escapeHtml(item.earmark_end || '?')}`;
  } else if (status === 'earmarked') {
    earmarkCell = '<span class="muted">無期限</span>';
  }
  return `<tr>
    <td>${escapeHtml(item.gift_name || '')}</td>
    <td><code>${escapeHtml(item.code)}</code></td>
    <td>${urlCell}</td>
    <td>${escapeHtml(item.face_value)}</td>
    <td>${escapeHtml(item.expires_at)}</td>
    <td>${statusBadge}</td>
    <td style="white-space:nowrap;font-size:0.9em">${earmarkCell}</td>
    <td>${escapeHtml(item.campaign_name || '')}</td>
    <td>${escapeHtml(item.redeemed_by)}</td>
    <td>${formatTime(item.redeemed_at)}</td>
    <td>${escapeHtml(item.redeemed_note)}</td>
    <td>${action}</td>
  </tr>`;
}

$('#filter-form').addEventListener('submit', (e) => {
  e.preventDefault();
  state.page = 1;
  loadCodes();
});
$('#btn-prev').addEventListener('click', () => { state.page--; loadCodes(); });
$('#btn-next').addEventListener('click', () => { state.page++; loadCodes(); });
$('#btn-export').addEventListener('click', () => {
  window.location.href = `/api/export.csv?${currentFilters()}`;
});

async function loadFilterOptions() {
  try {
    const [batches, campaigns] = await Promise.all([api('/api/batches'), api('/api/campaigns')]);
    fillSelect($('#filter-batch'), '全部批次', batches.map((b) => [b.id, `#${b.id} ${b.filename}`]));
    fillSelect($('#filter-campaign'), '全部活動', campaigns.map((c) => [c.id, c.name]));
    fillCampaignDatalist(campaigns);
  } catch (err) {
    toast(err.message, true);
  }
}

function fillSelect(select, placeholder, pairs) {
  const current = select.value;
  select.innerHTML = `<option value="">${placeholder}</option>` +
    pairs.map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join('');
  select.value = current;
}

function fillCampaignDatalist(campaigns) {
  $('#campaign-list').innerHTML = campaigns
    .map((c) => `<option value="${escapeHtml(c.name)}"></option>`).join('');
}

async function loadCampaignList() {
  try {
    fillCampaignDatalist(await api('/api/campaigns'));
  } catch { /* datalist 只是輔助，失敗可忽略 */ }
}

// ---- 兌換操作 ----
let redeemTargetId = null;

$('#codes-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'redeem') {
    redeemTargetId = btn.dataset.id;
    $('#redeem-code-label').textContent = btn.dataset.code;
    $('#redeem-form').reset();
    autoFillUserFields();
    loadCampaignList();
    $('#redeem-dialog').showModal();
  } else if (btn.dataset.action === 'unredeem') {
    if (!confirm(`確定要把「${btn.dataset.code}」改回未兌換嗎？`)) return;
    try {
      await api(`/api/codes/${btn.dataset.id}/unredeem`, { method: 'POST' });
      toast('已改回未兌換');
      loadCodes();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

$('#redeem-cancel').addEventListener('click', () => $('#redeem-dialog').close());

$('#redeem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/api/codes/${redeemTargetId}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign: $('#redeem-campaign').value,
        redeemed_by: $('#redeem-by').value,
        note: $('#redeem-note').value,
      }),
    });
    $('#redeem-dialog').close();
    toast('兌換成功');
    loadCodes();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- 上傳 CSV ----
$('#btn-open-upload').addEventListener('click', () => {
  $('#upload-form').reset();
  const box = $('#upload-result');
  box.classList.add('hidden');
  box.classList.remove('error');
  box.innerHTML = '';
  autoFillUserFields();
  $('#upload-dialog').showModal();
});
$('#upload-cancel').addEventListener('click', () => $('#upload-dialog').close());

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#upload-file').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('gift_name', $('#upload-gift-name').value);
  fd.append('uploaded_by', $('#upload-by').value);
  fd.append('note', $('#upload-note').value);
  const box = $('#upload-result');
  try {
    const r = await api('/api/batches', { method: 'POST', body: fd });
    box.classList.remove('hidden', 'error');
    let html = `上傳完成：檔內共 <strong>${r.total}</strong> 筆，成功匯入 <strong>${r.imported}</strong> 筆`;
    if (r.duplicates.length) {
      html += `，與資料庫重複略過 <strong>${r.duplicates.length}</strong> 筆`;
      html += `<ul>${r.duplicates.slice(0, 20).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}${r.duplicates.length > 20 ? '<li>…</li>' : ''}</ul>`;
    }
    if (r.cost_summary) {
      html += `<br>面額合計：<strong>$${Number(r.cost_summary.total).toLocaleString()}</strong>`;
      if (r.cost_summary.no_value > 0) {
        html += `（${r.cost_summary.with_value} 筆有面額，${r.cost_summary.no_value} 筆無面額）`;
      }
    }
    if (r.warnings.length) {
      html += `<ul>${r.warnings.slice(0, 20).map((w) => `<li>${escapeHtml(w)}</li>`).join('')}${r.warnings.length > 20 ? '<li>…</li>' : ''}</ul>`;
    }
    box.innerHTML = html;
    $('#upload-form').reset();
    // 上傳表單與禮券列表同頁，不刷新的話下方列表會停在舊資料
    loadFilterOptions();
    loadCodes();
    toast('上傳成功');
  } catch (err) {
    box.classList.remove('hidden');
    box.classList.add('error');
    box.textContent = err.message;
  }
});

// ---- 批次兌換 ----
$('#bulk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const codes = $('#bulk-codes').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const box = $('#bulk-result');
  try {
    const r = await api('/api/codes/redeem-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codes,
        campaign: $('#bulk-campaign').value,
        redeemed_by: $('#bulk-by').value,
        note: $('#bulk-note').value,
      }),
    });
    box.classList.remove('hidden', 'error');
    let html = `成功兌換 <strong>${r.redeemed_count}</strong> 筆`;
    if (r.already_redeemed.length) {
      html += `<br>已兌換過（略過）：${r.already_redeemed.map(escapeHtml).join('、')}`;
    }
    if (r.not_found.length) {
      html += `<br>找不到的禮券碼：${r.not_found.map(escapeHtml).join('、')}`;
    }
    box.innerHTML = html;
    toast(`成功兌換 ${r.redeemed_count} 筆`);
  } catch (err) {
    box.classList.remove('hidden');
    box.classList.add('error');
    box.textContent = err.message;
  }
});

// ---- NAS 同步 ----
function renderSyncStatus(s) {
  const info = $('#sync-info');
  const dirInput = $('#sync-dir');
  if (document.activeElement !== dirInput) dirInput.value = s.sync_dir || '';
  if (!s.configured) {
    info.textContent = '尚未設定同步資料夾：填入路徑並按「儲存路徑」。';
    $('#btn-sync').disabled = true;
    return;
  }
  $('#btn-sync').disabled = false;
  const lines = [s.dir_exists ? '路徑可讀取 ✓' : '⚠️ 目前無法讀取此路徑，請確認 NAS 連線與權限'];
  lines.push(s.last_synced_at ? `上次同步：${formatTime(s.last_synced_at)}，已追蹤 ${s.files.length} 個檔案` : '尚未同步過');
  info.textContent = lines.join('　｜　');
}

async function loadSyncStatus() {
  try {
    renderSyncStatus(await api('/api/sync/status'));
  } catch (err) {
    $('#sync-info').textContent = err.message;
  }
}

$('#sync-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const s = await api('/api/sync/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_dir: $('#sync-dir').value }),
    });
    $('#sync-dir').blur();
    renderSyncStatus(s);
    toast('已儲存同步路徑');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-sync').addEventListener('click', async () => {
  const box = $('#sync-result');
  const btn = $('#btn-sync');
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    box.classList.remove('hidden', 'error');
    let html = `掃描 ${r.scanned} 個 CSV：新匯入 <strong>${r.imported_files.length}</strong> 個檔案`
      + `（新增 <strong>${r.new_codes}</strong> 筆禮券、重複略過 ${r.duplicate_codes} 筆），`
      + `未變動跳過 ${r.skipped_files} 個`;
    if (r.imported_files.length) {
      html += `<ul>${r.imported_files.map((f) =>
        `<li>${escapeHtml(f.path)}：新增 ${f.imported} 筆${f.duplicates ? `、重複 ${f.duplicates} 筆` : ''}</li>`).join('')}</ul>`;
    }
    if (r.errors.length) {
      html += `<ul>${r.errors.map((e) => `<li>⚠️ ${escapeHtml(e)}</li>`).join('')}</ul>`;
    }
    box.innerHTML = html;
    toast(`同步完成，新增 ${r.new_codes} 筆禮券`);
    loadSyncStatus();
  } catch (err) {
    box.classList.remove('hidden');
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即同步';
  }
});

// ---- 上傳紀錄 ----
// ---- DB 備份 ----
function renderBackupStatus(s) {
  const info = $('#backup-info');
  const dirInput = $('#backup-dir');
  if (document.activeElement !== dirInput) dirInput.value = s.backup_dir || '';
  if (!s.configured) {
    info.textContent = '尚未設定備份資料夾：填入路徑並按「儲存設定」。';
    $('#btn-backup-now').disabled = true;
  } else {
    $('#btn-backup-now').disabled = false;
    info.textContent = s.dir_exists ? '路徑可讀取' : '目前無法讀取此路徑，請確認權限或 NAS 連線';
  }
  $('#backup-list').innerHTML = s.files.length
    ? s.files.slice(0, 5).map((f) => `<li>${escapeHtml(f)}</li>`).join('')
    : '';
}

async function loadDbConfig() {
  try {
    const cfg = await api('/api/db-config');
    const input = $('#db-data-dir');
    if (document.activeElement !== input) input.value = cfg.data_dir || '';
    const info = $('#db-config-info');
    if (cfg.current_data_dir) {
      info.textContent = `目前使用：${cfg.current_data_dir}${cfg.data_dir && cfg.data_dir !== cfg.current_data_dir ? '（重啟後將切換至新路徑）' : ''}`;
    } else {
      info.textContent = '';
    }
  } catch (err) {
    $('#db-config-info').textContent = err.message;
  }
}

async function loadBackupStatus() {
  try {
    renderBackupStatus(await api('/api/backup/config'));
  } catch (err) {
    $('#backup-info').textContent = err.message;
  }
}

$('#db-config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const newDataDir = $('#db-data-dir').value.trim();
    const newBackupDir = $('#backup-dir').value.trim();
    // 同時儲存 DB 路徑 + 備份路徑
    const [dbRes, backupRes] = await Promise.all([
      api('/api/db-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_dir: newDataDir }),
      }),
      api('/api/backup/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup_dir: newBackupDir }),
      }),
    ]);
    renderBackupStatus(backupRes);
    await loadDbConfig();
    if (dbRes.restart_required) {
      toast('已儲存設定，請重啟伺服器讓 DB 路徑生效');
    } else {
      toast('已儲存設定');
    }
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-backup-now').addEventListener('click', async () => {
  const box = $('#backup-result');
  const btn = $('#btn-backup-now');
  btn.disabled = true;
  btn.textContent = '備份中...';
  try {
    const result = await api('/api/backup', { method: 'POST' });
    box.classList.remove('hidden', 'error');
    box.textContent = `備份完成：${result.dest}`;
    toast('備份完成');
    loadBackupStatus();
  } catch (err) {
    box.classList.remove('hidden');
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即備份';
  }
});

async function loadBatches() {
  try {
    const batches = await api('/api/batches');
    const body = $('#batches-body');
    body.innerHTML = batches.length
      ? batches.map((b) => `<tr>
          <td>${b.id}</td>
          <td>${escapeHtml(b.filename)}</td>
          <td>${escapeHtml(b.uploaded_by)}</td>
          <td>${escapeHtml(b.note)}</td>
          <td>${b.total_count}</td>
          <td>${b.imported_count}</td>
          <td>${b.duplicate_count}</td>
          <td>${formatTime(b.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="8" class="empty">尚無上傳紀錄</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- 同仁管理 ----
async function loadStaff() {
  try {
    const staff = await api('/api/staff');
    const body = $('#staff-body');
    body.innerHTML = staff.length
      ? staff.map((s) => `<tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.department)}</td>
          <td>${escapeHtml(s.employee_id)}</td>
          <td>${escapeHtml(s.windows_username)}</td>
          <td>
            <button class="btn btn-small" data-action="edit-staff" data-id="${s.id}">編輯</button>
            <button class="btn btn-small btn-danger" data-action="del-staff" data-id="${s.id}" data-name="${escapeHtml(s.name)}">刪除</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty">尚無同仁資料</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btn-add-staff').addEventListener('click', () => {
  $('#staff-dialog-title').textContent = '新增同仁';
  $('#staff-id').value = '';
  $('#staff-form').reset();
  $('#staff-dialog').showModal();
});

$('#staff-cancel').addEventListener('click', () => $('#staff-dialog').close());

$('#staff-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'edit-staff') {
    try {
      const staff = await api('/api/staff');
      const item = staff.find((s) => s.id == btn.dataset.id);
      if (!item) return;
      $('#staff-dialog-title').textContent = '編輯同仁';
      $('#staff-id').value = item.id;
      $('#staff-name').value = item.name;
      $('#staff-dept').value = item.department;
      $('#staff-empid').value = item.employee_id;
      $('#staff-winuser').value = item.windows_username;
      $('#staff-dialog').showModal();
    } catch (err) {
      toast(err.message, true);
    }
  } else if (btn.dataset.action === 'del-staff') {
    if (!confirm(`確定刪除 ${btn.dataset.name}？`)) return;
    try {
      await api(`/api/staff/${btn.dataset.id}`, { method: 'DELETE' });
      toast('同仁已刪除');
      loadStaff();
      loadCurrentUser();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

$('#staff-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#staff-id').value;
  const body = {
    name: $('#staff-name').value,
    department: $('#staff-dept').value,
    employee_id: $('#staff-empid').value,
    windows_username: $('#staff-winuser').value,
  };
  try {
    await api(id ? `/api/staff/${id}` : '/api/staff', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('#staff-dialog').close();
    toast(id ? '同仁已更新' : '同仁已新增');
    loadStaff();
    loadCurrentUser();
  } catch (err) {
    toast(err.message, true);
  }
});

// 初始載入
loadStats();
loadCurrentUser();
