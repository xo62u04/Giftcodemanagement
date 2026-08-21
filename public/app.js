'use strict';

const $ = (sel) => document.querySelector(sel);

const state = { page: 1, pageSize: 50, total: 0 };

// 列表上勾選的禮券 id（跨頁保留，直到成功兌換或按「清除選取」）
const selectedCodeIds = new Set();

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
    const adminTag = currentUser.is_admin ? '（管理員）' : '';
    const label = currentUser.staff
      ? `${currentUser.staff.name}${adminTag} (${currentUser.staff.employee_id || currentUser.windows_username})`
      : `Windows: ${currentUser.windows_username || '-'}`;
    $('#current-user-badge').textContent = label;
    // 依權限顯示/隱藏破壞性動作按鈕（含 zero-admin 引導）
    document.body.classList.toggle('is-admin', Boolean(currentUser.can_admin));
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
    const amt = s.amounts || {};
    const money = (n) => `$${Number(n || 0).toLocaleString()}`;
    $('#stat-total-amt').textContent = money(amt.total);
    $('#stat-available-amt').textContent = money(amt.available);
    $('#stat-earmarked-amt').textContent = money(amt.earmarked);
    $('#stat-redeemed-amt').textContent = money(amt.redeemed);
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
          <td class="actions-cell"><button class="btn btn-small" data-action="edit-campaign" data-id="${c.id}">編輯</button></td>
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

// ---- 篩選（像自訂欄位：勾選要對哪些「可見欄位」篩選，勾了才出現輸入）----
// 收起所有開著的下拉（篩選、自訂欄位），確保同時只開一個
function closeAllDropdowns() {
  const fm = $('#filter-menu'); if (fm) fm.classList.remove('open');
  const cm = $('#col-menu'); if (cm) cm.classList.remove('open');
}
// 可篩選的欄位＝目前可見的欄位（圈存起訖為計算顯示，排除）
function filterPickerColumns() {
  return COLUMNS.filter((c) => c.key !== 'earmark' && !hiddenCols.has(c.key));
}
function hasFilterRow(key) {
  return !!document.querySelector(`#cond-list .cond-row[data-field="${key}"]`);
}
function buildFilterMenu() {
  const cols = filterPickerColumns();
  $('#filter-menu').innerHTML = cols.length
    ? cols.map((c) =>
      `<label class="col-opt"><input type="checkbox" data-fcol="${c.key}"${hasFilterRow(c.key) ? ' checked' : ''}> ${escapeHtml(c.label)}</label>`
    ).join('')
    : '<div class="ms-empty">請先在「自訂欄位」勾選欄位</div>';
}
function addFilterRow(key) {
  if (hasFilterRow(key)) return;
  const col = COLUMNS.find((c) => c.key === key);
  if (!col) return;
  const row = document.createElement('div');
  row.className = 'cond-row';
  row.dataset.field = key;
  const valueHtml = key === 'status'
    ? '<div class="cond-status">'
      + '<label><input type="checkbox" value="available">未兌換</label>'
      + '<label><input type="checkbox" value="earmarked">已圈存</label>'
      + '<label><input type="checkbox" value="redeemed">已兌換</label></div>'
    : '<input type="text" class="cond-value" placeholder="包含…">';
  row.innerHTML = `<span class="cond-label">${escapeHtml(col.label)}</span>${valueHtml}`
    + '<button type="button" class="btn btn-secondary btn-small cond-remove" title="移除此條件">✕</button>';
  $('#cond-list').appendChild(row);
  const v = row.querySelector('.cond-value');
  if (v) v.focus();
}
function removeFilterRow(key) {
  const row = document.querySelector(`#cond-list .cond-row[data-field="${key}"]`);
  if (row) row.remove();
}
// 自訂欄位改變時：篩選選單與已展開的條件列，跟著只保留可見欄位
function refreshFilterUI() {
  const avail = new Set(filterPickerColumns().map((c) => c.key));
  let changed = false;
  document.querySelectorAll('#cond-list .cond-row').forEach((row) => {
    if (!avail.has(row.dataset.field)) { row.remove(); changed = true; }
  });
  if ($('#filter-menu').classList.contains('open')) buildFilterMenu();
  if (changed) applyFilters();
}

// ---- 禮券列表 ----
function currentFilters() {
  const params = new URLSearchParams();
  const q = $('#filter-q').value.trim();
  if (q) params.set('q', q);
  document.querySelectorAll('#cond-list .cond-row').forEach((row) => {
    const field = row.dataset.field;
    if (field === 'status') {
      const vals = [...row.querySelectorAll('.cond-status input:checked')].map((cb) => cb.value);
      if (vals.length) params.set('status', vals.join(','));
    } else {
      const val = row.querySelector('.cond-value').value.trim();
      if (val) params.append(`f_${field}`, val);
    }
  });
  return params;
}

// 即時篩選會連續發請求，用序號擋掉比較慢回來的舊結果
let codesRequestSeq = 0;

async function loadCodes() {
  const params = currentFilters();
  params.set('page', state.page);
  params.set('page_size', state.pageSize);
  const seq = ++codesRequestSeq;
  try {
    const data = await api(`/api/codes?${params}`);
    if (seq !== codesRequestSeq) return; // 已有更新的查詢，丟棄這次結果
    state.total = data.total;
    state.items = data.items;
    const body = $('#codes-body');
    const firstSeq = (data.page - 1) * state.pageSize;
    body.innerHTML = data.items.length
      ? data.items.map((item, i) => renderCodeRow(item, firstSeq + i + 1)).join('')
      : `<tr><td colspan="${TABLE_COLSPAN}" class="empty">沒有符合條件的禮券</td></tr>`;
    const totalPages = Math.max(1, Math.ceil(data.total / state.pageSize));
    // 表格上下各有一組分頁列，一起更新
    const label = `第 ${data.page} / ${totalPages} 頁（共 ${data.total} 筆）`;
    document.querySelectorAll('#tab-codes .page-info').forEach((el) => { el.textContent = label; });
    $('#filter-count').textContent = `符合條件：${data.total} 筆`;
    document.querySelectorAll('#tab-codes [data-page="prev"]').forEach((b) => { b.disabled = data.page <= 1; });
    document.querySelectorAll('#tab-codes [data-page="next"]').forEach((b) => { b.disabled = data.page >= totalPages; });
    updateBulkBar();
  } catch (err) {
    toast(err.message, true);
  }
}

const STATUS_BADGE = {
  redeemed: '<span class="badge badge-redeemed">已兌換</span>',
  earmarked: '<span class="badge badge-earmarked">已圈存</span>',
  available: '<span class="badge badge-available">未兌換</span>',
};

// 列表所有「資料欄」的單一設定來源；每一欄都可在「自訂欄位」勾選顯示/隱藏。
// 結構欄（流水號#、操作、勾選框）不在此、固定顯示。
const COLUMNS = [
  { key: 'name', label: '禮券名稱', cell: (it) => escapeHtml(it.gift_name || '') },
  { key: 'code', label: '密碼/序號', cell: (it) => `<code>${escapeHtml(it.code)}</code>` },
  { key: 'url', label: '兌換連結', cell: (it, c) => c.urlCell },
  { key: 'value', label: '面額', cell: (it) => escapeHtml(it.face_value) },
  { key: 'expires', label: '到期日', cell: (it) => escapeHtml(it.expires_at) },
  { key: 'status', label: '狀態', cell: (it, c) => c.statusBadge },
  { key: 'earmark', label: '圈存起訖', style: 'white-space:nowrap;font-size:0.9em', cell: (it, c) => c.earmarkCell },
  { key: 'campaign', label: '使用活動', cell: (it) => escapeHtml(it.campaign_name || '') },
  { key: 'recipient', label: '兌換人', cell: (it) => escapeHtml(it.recipient_name || '') },
  { key: 'account', label: '期貨帳號', cell: (it) => escapeHtml(it.account_no || '') },
  { key: 'nid', label: '身分證字號', cell: (it) => escapeHtml(it.national_id || '') },
  { key: 'address', label: '戶籍地址', cell: (it) => escapeHtml(it.address || '') },
  { key: 'mobile', label: '手機', cell: (it) => escapeHtml(it.recipient_mobile || '') },
  { key: 'email', label: 'Email', cell: (it) => escapeHtml(it.recipient_email || '') },
  { key: 'method', label: '發送方式', cell: (it) => escapeHtml(it.send_method || '') },
  { key: 'sentat', label: '發送時間', cell: (it) => escapeHtml(it.sent_at || '') },
  { key: 'sendstatus', label: '發送狀態', cell: (it) => escapeHtml(it.send_status || '') },
  { key: 'statusupdated', label: '狀態更新時間', cell: (it) => escapeHtml(it.status_updated_at || '') },
  { key: 'unit', label: '單位', cell: (it) => escapeHtml(it.unit || '') },
  { key: 'salesrep', label: '營業員', cell: (it) => escapeHtml(it.sales_rep || '') },
  { key: 'handler', label: '經手人', cell: (it) => escapeHtml(it.redeemed_by || '') },
  { key: 'redeemedat', label: '兌換時間', cell: (it) => formatTime(it.redeemed_at) },
  { key: 'note', label: '備註', cell: (it) => escapeHtml(it.redeemed_note || '') },
];
// 首次使用（DB 尚無紀錄）預設顯示的欄；其餘預設收起
const DEFAULT_VISIBLE = new Set(['name', 'code', 'value', 'status', 'recipient', 'campaign']);
function defaultHiddenCols() {
  return new Set(COLUMNS.filter((c) => !DEFAULT_VISIBLE.has(c.key)).map((c) => c.key));
}
const TABLE_COLSPAN = COLUMNS.length + 3; // 資料欄 + 流水號 + 操作 + 勾選

function buildTableHead() {
  const tr = document.querySelector('#tab-codes thead tr');
  if (!tr) return;
  tr.innerHTML = '<th class="col-seq">#</th>'
    + COLUMNS.map((c) => `<th class="c-${c.key}">${c.label}</th>`).join('')
    + '<th>操作</th>'
    + '<th class="col-check"><input type="checkbox" id="check-all" title="全選本頁未兌換的禮券"></th>';
}

function renderCodeRow(item, seq) {
  const status = item.display_status || item.status;
  const statusBadge = STATUS_BADGE[status] || STATUS_BADGE.available;
  const redeemAction = status === 'redeemed'
    ? `<button class="btn btn-small btn-danger" data-action="unredeem" data-id="${item.id}" data-code="${escapeHtml(item.code)}">取消兌換</button>`
    : `<button class="btn btn-small" data-action="redeem" data-id="${item.id}" data-code="${escapeHtml(item.code)}">標記兌換</button>`;
  const deleteAction = `<button class="btn btn-small btn-danger admin-only" data-action="delete-code" data-id="${item.id}" data-code="${escapeHtml(item.code)}" data-redeemed="${status === 'redeemed' ? 1 : 0}">刪除</button>`;
  const action = `<button class="btn btn-small btn-secondary" data-action="edit-code" data-id="${item.id}">編輯</button>${redeemAction}${deleteAction}`;
  const urlCell = item.redeem_url
    ? `<a href="${escapeHtml(item.redeem_url)}" target="_blank" rel="noopener" class="redeem-link" title="${escapeHtml(item.redeem_url)}">開啟連結</a>`
    : '';
  let earmarkCell = '';
  if (item.earmark_start || item.earmark_end) {
    earmarkCell = `${escapeHtml(item.earmark_start || '?')} ~ ${escapeHtml(item.earmark_end || '?')}`;
  } else if (status === 'earmarked') {
    earmarkCell = '<span class="muted">無期限</span>';
  }
  // 已兌換的不給勾，避免全選時把它們也算進批次兌換
  const checkCell = status === 'redeemed'
    ? '<td class="col-check"></td>'
    : `<td class="col-check"><input type="checkbox" class="row-check" data-id="${item.id}"${selectedCodeIds.has(String(item.id)) ? ' checked' : ''}></td>`;
  const ctx = { status, statusBadge, earmarkCell, urlCell };
  const dataCells = COLUMNS.map((c) =>
    `<td class="c-${c.key}"${c.style ? ` style="${c.style}"` : ''}>${c.cell(item, ctx)}</td>`).join('');
  return `<tr>
    <td class="col-seq muted">${seq}</td>
    ${dataCells}
    <td class="actions-cell">${action}</td>
    ${checkCell}
  </tr>`;
}

// ---- 勾選與批次兌換 ----
function updateBulkBar() {
  const count = selectedCodeIds.size;
  $('#bulk-count').textContent = `已選取 ${count} 張`;
  $('#bulk-count').classList.toggle('muted', count === 0);
  $('#btn-bulk-redeem').disabled = count === 0;
  $('#btn-bulk-clear').disabled = count === 0;

  const boxes = [...document.querySelectorAll('#codes-body .row-check')];
  const checked = boxes.filter((b) => b.checked).length;
  const all = $('#check-all');
  all.checked = boxes.length > 0 && checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
}

$('#codes-body').addEventListener('change', (e) => {
  const box = e.target.closest('.row-check');
  if (!box) return;
  if (box.checked) selectedCodeIds.add(box.dataset.id);
  else selectedCodeIds.delete(box.dataset.id);
  updateBulkBar();
});

// 表頭由 JS 動態產生，check-all 用委派綁定（元素會被重建）
$('#tab-codes').addEventListener('change', (e) => {
  if (!e.target || e.target.id !== 'check-all') return;
  document.querySelectorAll('#codes-body .row-check').forEach((box) => {
    box.checked = e.target.checked;
    if (box.checked) selectedCodeIds.add(box.dataset.id);
    else selectedCodeIds.delete(box.dataset.id);
  });
  updateBulkBar();
});

function clearSelection() {
  selectedCodeIds.clear();
  document.querySelectorAll('#codes-body .row-check').forEach((box) => { box.checked = false; });
  updateBulkBar();
}

$('#btn-bulk-clear').addEventListener('click', clearSelection);

// 打「第 N ~ M 號」直接跨頁選取，不用一頁一頁翻
async function selectSeqRange() {
  const from = Number($('#range-from').value);
  const to = Number($('#range-to').value);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
    return toast('請輸入起訖流水號', true);
  }
  if (to < from) return toast('結束流水號不可小於開始流水號', true);

  const params = currentFilters();
  params.set('from', from);
  params.set('to', to);
  try {
    const r = await api(`/api/codes/ids?${params}`);
    r.ids.forEach((id) => selectedCodeIds.add(String(id)));
    // 目前這一頁的勾選框跟著同步
    document.querySelectorAll('#codes-body .row-check').forEach((box) => {
      box.checked = selectedCodeIds.has(box.dataset.id);
    });
    updateBulkBar();
    const parts = [`已加入 ${r.ids.length} 張`];
    if (r.skipped_redeemed) parts.push(`略過已兌換 ${r.skipped_redeemed} 張`);
    if (r.found < to - from + 1) parts.push(`第 ${from + r.found} 號之後已無資料`);
    toast(parts.join('，'));
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btn-range-select').addEventListener('click', selectSeqRange);
['#range-from', '#range-to'].forEach((sel) => {
  $(sel).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); selectSeqRange(); }
  });
});

$('#btn-bulk-redeem').addEventListener('click', async () => {
  if (selectedCodeIds.size === 0) return;

  // 先問後端這批裡有沒有已圈存的，有就先警告（可以繼續）
  try {
    const check = await dryRunBulk({ ids: [...selectedCodeIds].map(Number) });
    if (!await confirmEarmarked(check.earmarked)) return;
  } catch (err) {
    return toast(err.message, true);
  }

  redeemTargetId = null;
  $('#redeem-dialog-title').textContent = '統一標記兌換';
  $('#redeem-target-line').innerHTML = `將把勾選的 <strong>${selectedCodeIds.size}</strong> 張禮券標記為同一個活動的兌換。`;
  $('#redeem-form').reset();
  autoFillUserFields();
  loadCampaignList();
  $('#redeem-dialog').showModal();
});

// 篩選條件一改就直接查，不必等全部選完再按按鈕
function applyFilters() {
  state.page = 1;
  loadCodes();
}

$('#filter-form').addEventListener('submit', (e) => {
  e.preventDefault();
  applyFilters();
});

// 點空白處收起開著的多選下拉
document.addEventListener('click', (e) => {
  if (!e.target.closest('.ms')) {
    document.querySelectorAll('.ms.open').forEach((el) => el.classList.remove('open'));
  }
});

// 搜尋框邊打邊查（停止輸入 300ms 後才送出，避免每個按鍵都打 API）
let filterQueryTimer;
$('#filter-q').addEventListener('input', () => {
  clearTimeout(filterQueryTimer);
  filterQueryTimer = setTimeout(applyFilters, 300);
});
$('#filter-q').addEventListener('search', () => {
  clearTimeout(filterQueryTimer);
  applyFilters();
});

$('#btn-reset-filter').addEventListener('click', () => {
  clearTimeout(filterQueryTimer);
  $('#filter-q').value = '';
  $('#cond-list').innerHTML = '';
  if ($('#filter-menu').classList.contains('open')) buildFilterMenu();
  applyFilters();
});
// 換頁後捲回列表最上方，不用自己滾滑鼠回去
async function goToPage(page) {
  state.page = page;
  await loadCodes();
  window.scrollTo(0, 0);
}

document.querySelectorAll('#tab-codes [data-page]').forEach((btn) => {
  btn.addEventListener('click', () => {
    goToPage(btn.dataset.page === 'next' ? state.page + 1 : state.page - 1);
  });
});
$('#btn-export').addEventListener('click', () => {
  window.location.href = `/api/export.csv?${currentFilters()}`;
});
$('#btn-export-signoff').addEventListener('click', () => {
  window.location.href = `/api/signoff.csv?${currentFilters()}`;
});

// ---- 自訂欄位（勾選顯示哪些欄，存 DB 依使用者；操作/流水號/勾選框固定顯示）----
const TOGGLE_COLS = COLUMNS; // 所有資料欄都可自訂
let hiddenCols = defaultHiddenCols();
const colStyle = document.createElement('style');
document.head.appendChild(colStyle);
function applyColVisibility() {
  colStyle.textContent = [...hiddenCols].map((k) => `.data-table .c-${k}{display:none}`).join('');
}
function buildColMenu() {
  const menu = $('#col-menu');
  const allVisible = TOGGLE_COLS.every((c) => !hiddenCols.has(c.key));
  menu.innerHTML =
    `<label class="col-opt col-opt-all"><input type="checkbox" data-col="__all__"${allVisible ? ' checked' : ''}> 全部</label>` +
    TOGGLE_COLS.map((c) =>
      `<label class="col-opt"><input type="checkbox" data-col="${c.key}"${hiddenCols.has(c.key) ? '' : ' checked'}> ${c.label}</label>`
    ).join('');
}
async function saveColumnPrefs() {
  try {
    await api('/api/column-prefs', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: [...hiddenCols] }),
    });
  } catch { /* 存檔失敗不阻斷操作 */ }
}
async function loadColumnPrefs() {
  try {
    const data = await api('/api/column-prefs');
    hiddenCols = new Set(data.saved ? (data.hidden || []) : [...defaultHiddenCols()]);
  } catch { /* 用預設 */ }
  buildColMenu();
  applyColVisibility();
}
// 選單變更（監聽掛在容器上，只掛一次）
$('#col-menu').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-col]');
  if (!cb) return;
  if (cb.dataset.col === '__all__') {
    if (cb.checked) TOGGLE_COLS.forEach((c) => hiddenCols.delete(c.key));
    else TOGGLE_COLS.forEach((c) => hiddenCols.add(c.key));
  } else if (cb.checked) {
    hiddenCols.delete(cb.dataset.col);
  } else {
    hiddenCols.add(cb.dataset.col);
  }
  buildColMenu();
  applyColVisibility();
  saveColumnPrefs();
  refreshFilterUI();
});
$('#btn-col-picker').addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = !$('#col-menu').classList.contains('open');
  closeAllDropdowns();
  if (willOpen) $('#col-menu').classList.add('open');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.col-picker')) closeAllDropdowns();
});

// ---- 篩選選單與條件列（委派，只掛一次）----
$('#btn-filter-picker').addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = !$('#filter-menu').classList.contains('open');
  closeAllDropdowns();
  if (willOpen) { buildFilterMenu(); $('#filter-menu').classList.add('open'); }
});
$('#filter-menu').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-fcol]');
  if (!cb) return;
  if (cb.checked) addFilterRow(cb.dataset.fcol); else removeFilterRow(cb.dataset.fcol);
  applyFilters();
});
let condDebounce;
$('#cond-list').addEventListener('input', (e) => {
  if (!e.target.classList.contains('cond-value')) return;
  clearTimeout(condDebounce);
  condDebounce = setTimeout(applyFilters, 300);
});
$('#cond-list').addEventListener('change', (e) => {
  if (e.target.closest('.cond-status')) applyFilters();
});
$('#cond-list').addEventListener('click', (e) => {
  if (!e.target.closest('.cond-remove')) return;
  const row = e.target.closest('.cond-row');
  const key = row.dataset.field;
  row.remove();
  const cb = document.querySelector(`#filter-menu input[data-fcol="${key}"]`);
  if (cb) cb.checked = false;
  applyFilters();
});

buildTableHead();
loadColumnPrefs();

// 彈窗點外面（backdrop）即關閉
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
});

async function loadFilterOptions() {
  try {
    const campaigns = await api('/api/campaigns');
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

// ---- 活動選單（可打字也可下拉選，允許輸入不存在的新活動）----
let campaignNames = [];

function fillCampaignDatalist(campaigns) {
  campaignNames = campaigns.map((c) => c.name);
}

/*
 * 把一般 <input> 升級成可搜尋的下拉選單。
 * 沒有引入 select2：這個專案沒有打包流程，而且是內網離線環境載不到 CDN，
 * 所以用原生實作同樣的操作方式——點開看全部、打字即時篩選、上下鍵＋Enter 選取。
 */
function setupCombo(input, getOptions) {
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.classList.add('combo-input');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'combo-toggle';
  toggle.tabIndex = -1;
  toggle.setAttribute('aria-label', '展開活動清單');
  wrap.appendChild(toggle);

  const list = document.createElement('ul');
  list.className = 'combo-list hidden';
  list.setAttribute('role', 'listbox');
  wrap.appendChild(list);

  let items = [];
  let active = -1;

  function render(filterText) {
    const q = filterText.trim().toLowerCase();
    items = getOptions().filter((name) => !q || name.toLowerCase().includes(q));
    active = -1;
    list.innerHTML = items.length
      ? items.map((name) => `<li role="option" class="combo-item">${escapeHtml(name)}</li>`).join('')
      : '<li class="combo-empty">查無相符的活動，直接輸入即可新增</li>';
  }

  function open(filterText = '') {
    render(filterText);
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  }

  function highlight(next) {
    if (!items.length) return;
    active = (next + items.length) % items.length;
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function choose(name) {
    input.value = name;
    close();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.addEventListener('focus', () => open(''));
  input.addEventListener('input', () => open(input.value));
  toggle.addEventListener('click', () => {
    if (list.classList.contains('hidden')) { open(''); input.focus(); } else close();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.classList.contains('hidden')) open(input.value);
      else highlight(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(active - 1);
    } else if (e.key === 'Enter') {
      // 只有正在選清單裡的項目時才攔截，否則讓表單照常送出
      if (!list.classList.contains('hidden') && active >= 0) {
        e.preventDefault();
        choose(items[active]);
      } else {
        close();
      }
    } else if (e.key === 'Escape') {
      // 清單開著時 Esc 只收清單，不要順便把整個對話框關掉
      if (!list.classList.contains('hidden')) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
  });

  // 用 mousedown 才不會先觸發 blur 導致清單關閉、點不到項目
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.combo-item');
    if (!li) return;
    e.preventDefault();
    choose(li.textContent);
  });

  input.addEventListener('blur', () => setTimeout(close, 0));
}

document.querySelectorAll('.campaign-input').forEach((input) => {
  setupCombo(input, () => campaignNames);
});

async function loadCampaignList() {
  try {
    fillCampaignDatalist(await api('/api/campaigns'));
  } catch { /* datalist 只是輔助，失敗可忽略 */ }
}

// ---- 圈存警告（提醒，不阻擋）----
const WARN_LIST_LIMIT = 20;
let earmarkWarnResolve = null;

// 顯示警告並等使用者決定；回傳 true 代表照樣兌換
function confirmEarmarked(items) {
  if (!items.length) return Promise.resolve(true);

  $('#earmark-warn-count').textContent = items.length;
  const shown = items.slice(0, WARN_LIST_LIMIT);
  $('#earmark-warn-body').innerHTML = shown.map((it) => {
    const range = (it.earmark_start || it.earmark_end)
      ? `${escapeHtml(it.earmark_start || '?')} ~ ${escapeHtml(it.earmark_end || '?')}`
      : '<span class="muted">無期限</span>';
    return `<tr>
      <td><code>${escapeHtml(it.code)}</code></td>
      <td style="white-space:nowrap">${range}</td>
      <td>${escapeHtml(it.campaign_name || '')}</td>
    </tr>`;
  }).join('');
  $('#earmark-warn-more').textContent = items.length > shown.length
    ? `（只列出前 ${shown.length} 張，其餘 ${items.length - shown.length} 張未列出）`
    : '';

  $('#earmark-warn-dialog').showModal();
  return new Promise((resolve) => { earmarkWarnResolve = resolve; });
}

function closeEarmarkWarn(result) {
  // 先取走 resolver 再關，避免 close 事件重入時把答案覆蓋成取消
  const resolve = earmarkWarnResolve;
  earmarkWarnResolve = null;
  $('#earmark-warn-dialog').close();
  resolve?.(result);
}

$('#earmark-warn-cancel').addEventListener('click', () => closeEarmarkWarn(false));
$('#earmark-warn-confirm').addEventListener('click', () => closeEarmarkWarn(true));
// 按 Esc 或點外面關掉，一律視為取消
$('#earmark-warn-dialog').addEventListener('close', () => {
  if (earmarkWarnResolve) closeEarmarkWarn(false);
});

// 問後端這批會發生什麼事（不寫入），用來取得其中的已圈存清單
async function dryRunBulk(payload) {
  return api('/api/codes/redeem-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, dry_run: true }),
  });
}

// ---- 兌換操作 ----
let redeemTargetId = null;

$('#codes-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'redeem') {
    const item = (state.items || []).find((i) => String(i.id) === btn.dataset.id);
    if (item && (item.display_status || item.status) === 'earmarked') {
      if (!await confirmEarmarked([item])) return;
    }
    redeemTargetId = btn.dataset.id;
    $('#redeem-dialog-title').textContent = '標記兌換';
    $('#redeem-target-line').innerHTML = '禮券碼：<strong id="redeem-code-label"></strong>';
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
  } else if (btn.dataset.action === 'edit-code') {
    const item = (state.items || []).find((i) => String(i.id) === btn.dataset.id);
    if (!item) return;
    $('#code-edit-id').value = item.id;
    $('#code-edit-gift-name').value = item.gift_name || '';
    $('#code-edit-code').value = item.code || '';
    $('#code-edit-url').value = item.redeem_url || '';
    $('#code-edit-value').value = item.face_value || '';
    $('#code-edit-expires').value = item.expires_at || '';
    $('#code-edit-earmark-start').value = item.earmark_start || '';
    $('#code-edit-earmark-end').value = item.earmark_end || '';
    $('#code-edit-unit').value = item.unit || '';
    $('#code-edit-recipient-name').value = item.recipient_name || '';
    $('#code-edit-account-no').value = item.account_no || '';
    $('#code-edit-national-id').value = item.national_id || '';
    $('#code-edit-address').value = item.address || '';
    $('#code-edit-mobile').value = item.recipient_mobile || '';
    $('#code-edit-email').value = item.recipient_email || '';
    $('#code-edit-send-method').value = item.send_method || '';
    $('#code-edit-sent-at').value = item.sent_at || '';
    $('#code-edit-send-status').value = item.send_status || '';
    $('#code-edit-status-updated-at').value = item.status_updated_at || '';
    $('#code-edit-sales-rep').value = item.sales_rep || '';
    $('#code-dialog').showModal();
  } else if (btn.dataset.action === 'delete-code') {
    const isRedeemed = btn.dataset.redeemed === '1';
    const msg = isRedeemed
      ? `「${btn.dataset.code}」已經被兌換，確定要刪除嗎？此動作無法復原。`
      : `確定要刪除「${btn.dataset.code}」嗎？此動作無法復原。`;
    if (!confirm(msg)) return;
    try {
      await api(`/api/codes/${btn.dataset.id}`, { method: 'DELETE' });
      toast('已刪除禮券');
      loadCodes();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

$('#code-cancel').addEventListener('click', () => $('#code-dialog').close());

$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#code-edit-id').value;
  try {
    await api(`/api/codes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gift_name: $('#code-edit-gift-name').value,
        code: $('#code-edit-code').value,
        redeem_url: $('#code-edit-url').value,
        face_value: $('#code-edit-value').value,
        expires_at: $('#code-edit-expires').value,
        earmark_start: $('#code-edit-earmark-start').value,
        earmark_end: $('#code-edit-earmark-end').value,
        unit: $('#code-edit-unit').value,
        recipient_name: $('#code-edit-recipient-name').value,
        account_no: $('#code-edit-account-no').value,
        national_id: $('#code-edit-national-id').value,
        address: $('#code-edit-address').value,
        recipient_mobile: $('#code-edit-mobile').value,
        recipient_email: $('#code-edit-email').value,
        send_method: $('#code-edit-send-method').value,
        sent_at: $('#code-edit-sent-at').value,
        send_status: $('#code-edit-send-status').value,
        status_updated_at: $('#code-edit-status-updated-at').value,
        sales_rep: $('#code-edit-sales-rep').value,
      }),
    });
    $('#code-dialog').close();
    toast('已更新禮券');
    loadCodes();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#redeem-cancel').addEventListener('click', () => $('#redeem-dialog').close());

$('#redeem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    campaign: $('#redeem-campaign').value,
    redeemed_by: $('#redeem-by').value,
    note: $('#redeem-note').value,
  };
  try {
    if (redeemTargetId) {
      await api(`/api/codes/${redeemTargetId}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      $('#redeem-dialog').close();
      toast('兌換成功');
    } else {
      const r = await api('/api/codes/redeem-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ids: [...selectedCodeIds].map(Number) }),
      });
      $('#redeem-dialog').close();
      const skipped = r.already_redeemed.length + r.not_found.length;
      toast(`已兌換 ${r.redeemed_count} 張${skipped ? `，略過 ${skipped} 張（已兌換或已不存在）` : ''}`);
      clearSelection();
    }
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
    const parts = [`匯入 ${r.imported} 筆`];
    if (r.duplicates.length) parts.push(`重複略過 ${r.duplicates.length} 筆`);
    if (r.warnings.length) parts.push(`警告 ${r.warnings.length} 筆`);
    toast(`上傳完成：${parts.join('、')}`);
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
    const check = await dryRunBulk({ codes });
    if (!await confirmEarmarked(check.earmarked)) return;

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
          <td>${b.redeemed_count || 0}</td>
          <td>${formatTime(b.created_at)}</td>
          <td><button class="btn btn-small btn-danger admin-only" data-action="delete-batch"
                data-id="${b.id}" data-filename="${escapeHtml(b.filename)}"
                data-count="${b.code_count || 0}" data-redeemed="${b.redeemed_count || 0}">刪除整批</button></td>
        </tr>`).join('')
      : '<tr><td colspan="10" class="empty">尚無上傳紀錄</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

$('#batches-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="delete-batch"]');
  if (!btn) return;
  const count = Number(btn.dataset.count) || 0;
  const redeemed = Number(btn.dataset.redeemed) || 0;
  let msg = `確定要刪除批次「${btn.dataset.filename}」嗎？\n將一併刪除該批 ${count} 張禮券，此動作無法復原。`;
  if (redeemed > 0) msg += `\n⚠️ 其中 ${redeemed} 張已兌換！`;
  if (!confirm(msg)) return;
  try {
    const r = await api(`/api/batches/${btn.dataset.id}`, { method: 'DELETE' });
    toast(`已刪除批次，共移除 ${r.deleted_codes} 張禮券`);
    loadBatches();
  } catch (err) {
    toast(err.message, true);
  }
});

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
          <td>${s.is_admin ? '<span class="badge badge-admin">管理員</span>' : ''}</td>
          <td class="actions-cell">
            <button class="btn btn-small" data-action="edit-staff" data-id="${s.id}">編輯</button><button class="btn btn-small btn-danger" data-action="del-staff" data-id="${s.id}" data-name="${escapeHtml(s.name)}">刪除</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty">尚無同仁資料</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btn-add-staff').addEventListener('click', () => {
  $('#staff-dialog-title').textContent = '新增同仁';
  $('#staff-id').value = '';
  $('#staff-form').reset();
  $('#staff-is-admin').checked = false;
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
      $('#staff-is-admin').checked = Boolean(item.is_admin);
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
    is_admin: $('#staff-is-admin').checked,
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
