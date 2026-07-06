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
  });
});

// ---- 總覽 ----
async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#stat-total').textContent = s.total;
    $('#stat-available').textContent = s.available;
    $('#stat-redeemed').textContent = s.redeemed;
    $('#stat-batches').textContent = s.batch_count;
    const body = $('#campaign-stats');
    body.innerHTML = s.campaigns.length
      ? s.campaigns.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${c.redeemed_count}</td></tr>`).join('')
      : '<tr><td colspan="2" class="empty">尚無活動</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

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
      : '<tr><td colspan="9" class="empty">沒有符合條件的禮券</td></tr>';
    const totalPages = Math.max(1, Math.ceil(data.total / state.pageSize));
    $('#page-info').textContent = `第 ${data.page} / ${totalPages} 頁（共 ${data.total} 筆）`;
    $('#btn-prev').disabled = data.page <= 1;
    $('#btn-next').disabled = data.page >= totalPages;
  } catch (err) {
    toast(err.message, true);
  }
}

function renderCodeRow(item) {
  const statusBadge = item.status === 'redeemed'
    ? '<span class="badge badge-redeemed">已兌換</span>'
    : '<span class="badge badge-available">未兌換</span>';
  const action = item.status === 'redeemed'
    ? `<button class="btn btn-small btn-danger" data-action="unredeem" data-id="${item.id}" data-code="${escapeHtml(item.code)}">取消兌換</button>`
    : `<button class="btn btn-small" data-action="redeem" data-id="${item.id}" data-code="${escapeHtml(item.code)}">標記兌換</button>`;
  return `<tr>
    <td><code>${escapeHtml(item.code)}</code></td>
    <td>${escapeHtml(item.face_value)}</td>
    <td>${escapeHtml(item.expires_at)}</td>
    <td>${statusBadge}</td>
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
$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#upload-file').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
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
    if (r.warnings.length) {
      html += `<ul>${r.warnings.slice(0, 20).map((w) => `<li>${escapeHtml(w)}</li>`).join('')}${r.warnings.length > 20 ? '<li>…</li>' : ''}</ul>`;
    }
    box.innerHTML = html;
    $('#upload-form').reset();
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

// ---- 上傳紀錄 ----
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

// 初始載入
loadStats();
