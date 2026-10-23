/* Hivekeeper frontend.
 *
 * Connections live in localStorage and never leave this browser except as the
 * body of an API call the user triggers. There are no accounts and no
 * server-side profile - clearing site data removes every saved connection.
 */
'use strict';

const STORE_KEY = 'hivekeeper.connections.v1';
const TOKEN_KEY = 'hivekeeper.token';
const PAGE_SIZE = 100;

const state = {
  connections: [],
  activeId: null,
  engines: [],
  tables: [],
  activeTable: null,
  offset: 0,
  total: 0,
  editingId: null,
  token: sessionStorage.getItem(TOKEN_KEY) || null,
};

const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------ storage

function loadConnections() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state.connections = raw ? JSON.parse(raw) : [];
  } catch {
    state.connections = [];
  }
}

function saveConnections() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.connections));
}

function activeConnection() {
  return state.connections.find((c) => c.id === state.activeId) || null;
}

// ------------------------------------------------------------ api

async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function apiGet(path) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { headers });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

// ------------------------------------------------------------ gate

async function initGate() {
  const { required } = await (await fetch('/api/auth/required')).json();

  if (!required) {
    $('#app').classList.remove('hidden');
    return true;
  }
  if (state.token) {
    // Validate the cached token before trusting it.
    const res = await fetch('/api/auth/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: state.token }),
    });
    if (res.ok) {
      $('#app').classList.remove('hidden');
      return true;
    }
    sessionStorage.removeItem(TOKEN_KEY);
    state.token = null;
  }

  $('#gate').classList.remove('hidden');
  $('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#gate-password').value;
    const res = await fetch('/api/auth/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      state.token = password;
      sessionStorage.setItem(TOKEN_KEY, password);
      $('#gate').classList.add('hidden');
      $('#app').classList.remove('hidden');
      boot();
    } else {
      $('#gate-error').textContent = 'Incorrect password';
    }
  });
  return false;
}

// ------------------------------------------------------------ render

function renderConnections() {
  const ul = $('#conn-list');
  ul.innerHTML = '';

  if (state.connections.length === 0) {
    ul.innerHTML = '<li class="muted tiny" style="padding:8px">No connections yet.</li>';
    return;
  }

  for (const c of state.connections) {
    const li = document.createElement('li');
    li.className = 'conn-item' + (c.id === state.activeId ? ' active' : '');

    const target = c.engine === 'mongodb' || c.engine === 'redis'
      ? `${c.host}:${c.port}`
      : `${c.host}:${c.port}/${c.database || ''}`;

    li.innerHTML = `
      <span class="dot"></span>
      <span class="conn-meta">
        <div class="conn-name"></div>
        <div class="conn-sub"></div>
      </span>
      <span class="conn-actions">
        <button class="icon-btn" data-act="edit" title="Edit">✎</button>
        <button class="icon-btn" data-act="del" title="Delete">🗑</button>
      </span>`;

    // Use textContent for user data so a connection name can't inject markup.
    li.querySelector('.conn-name').textContent = c.name;
    li.querySelector('.conn-sub').textContent = target;
    // Names and hostnames are ellipsis-truncated; expose the full value on hover.
    li.title = `${c.name}\n${c.engine} · ${target}`;

    li.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'edit') { e.stopPropagation(); openModal(c.id); return; }
      if (act === 'del') { e.stopPropagation(); deleteConnection(c.id); return; }
      selectConnection(c.id);
    });
    ul.appendChild(li);
  }
}

function renderTables() {
  const ul = $('#tables');
  const filter = $('#table-filter').value.toLowerCase();
  ul.innerHTML = '';

  const visible = state.tables.filter(
    (t) => !filter || t.name.toLowerCase().includes(filter) || (t.schema || '').toLowerCase().includes(filter)
  );

  if (visible.length === 0) {
    ul.innerHTML = '<li class="muted tiny">No tables found.</li>';
    return;
  }

  for (const t of visible) {
    const li = document.createElement('li');
    const key = `${t.schema}.${t.name}`;
    if (state.activeTable && `${state.activeTable.schema}.${state.activeTable.name}` === key) {
      li.className = 'active';
    }
    li.title = key;
    li.textContent = t.name;
    if (t.approxRows !== null && t.approxRows !== undefined) {
      const span = document.createElement('span');
      span.className = 'cnt';
      span.textContent = t.approxRows;
      li.appendChild(span);
    }
    li.addEventListener('click', () => { openTable(t); showTableData(); });
    ul.appendChild(li);
  }
}

/* ---------------------------------------------------------- responsive

   The narrow layout (<=760px) turns the sidebar into an off-canvas drawer and
   splits Browse into two steps: table list, then data. These helpers drive the
   classes those breakpoints key off. isNarrow() is checked at call time rather
   than cached so rotating a phone takes effect immediately.
*/

const NARROW_QUERY = '(max-width: 760px)';
function isNarrow() { return window.matchMedia(NARROW_QUERY).matches; }

function openDrawer() {
  $('#sidebar').classList.add('open');
  $('#drawer-backdrop').classList.remove('hidden');
  $('#menu-btn').setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  $('#sidebar').classList.remove('open');
  $('#drawer-backdrop').classList.add('hidden');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}

/* Slide the data pane in over the table list (narrow only). */
function showTableData() {
  if (isNarrow()) $('#browse-split').classList.add('show-data');
}

/* Return to the table list. */
function showTableList() {
  $('#browse-split').classList.remove('show-data');
}

function renderGrid(target, payload) {
  const { columns, rows } = payload;

  if (!rows || rows.length === 0) {
    target.innerHTML = '<div class="muted pad">No rows.</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'grid';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const val = row[col];
      if (val === null || val === undefined) {
        td.className = 'null';
        td.textContent = 'NULL';
      } else if (typeof val === 'object') {
        td.textContent = JSON.stringify(val);
      } else {
        td.textContent = String(val);
      }
      td.title = td.textContent;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  target.innerHTML = '';
  target.appendChild(table);
}

// ------------------------------------------------------------ actions

async function selectConnection(id) {
  state.activeId = id;
  state.activeTable = null;
  state.tables = [];
  state.offset = 0;

  // Picking a connection is the drawer's purpose; dismiss it and return the
  // browse pane to step one so the new connection opens on its table list.
  closeDrawer();
  showTableList();

  const conn = activeConnection();
  if (!conn) return;

  $('#empty-state').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#active-name').textContent = conn.name;
  $('#active-engine').textContent = conn.engine;
  $('#active-target').textContent = `${conn.host}:${conn.port}`;

  const engine = state.engines.find((e) => e.id === conn.engine);
  $('#query-hint').textContent = engine?.supportsSql
    ? 'SQL query'
    : `Syntax: ${engine?.queryHint || 'see docs'}`;
  $('#sql').placeholder = engine?.supportsSql
    ? 'SELECT * FROM users LIMIT 10;'
    : engine?.queryHint || '';

  renderConnections();

  const wrap = $('#grid-wrap');
  wrap.innerHTML = '<div class="muted pad">Loading tables…</div>';
  try {
    state.tables = await api('/api/tables', { connection: conn });
    renderTables();
    wrap.innerHTML = '<div class="muted pad">Select a table.</div>';
  } catch (err) {
    $('#tables').innerHTML = '';
    wrap.innerHTML = `<div class="error pad">${escapeHtml(err.message)}</div>`;
  }
}

async function openTable(t, offset = 0) {
  state.activeTable = t;
  state.offset = offset;
  renderTables();

  $('#data-title').textContent = `${t.schema}.${t.name}`;
  const wrap = $('#grid-wrap');
  wrap.innerHTML = '<div class="muted pad">Loading…</div>';

  try {
    const payload = await api('/api/rows', {
      connection: activeConnection(),
      schema: t.schema,
      table: t.name,
      limit: PAGE_SIZE,
      offset,
    });
    state.total = payload.total;
    renderGrid(wrap, payload);

    const from = payload.total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE_SIZE, payload.total);
    $('#row-info').textContent = `${from}–${to} of ${payload.total}`;
    $('#prev-page').disabled = offset <= 0;
    $('#next-page').disabled = to >= payload.total;
  } catch (err) {
    wrap.innerHTML = `<div class="error pad">${escapeHtml(err.message)}</div>`;
    $('#row-info').textContent = '';
  }
}

async function runQuery() {
  const sql = $('#sql').value.trim();
  const out = $('#query-results');
  if (!sql) return;

  out.innerHTML = '<div class="muted pad">Running…</div>';
  try {
    const results = await api('/api/query', { connection: activeConnection(), sql });
    out.innerHTML = '';
    for (const r of results) {
      const meta = document.createElement('div');
      meta.className = 'result-meta';
      meta.textContent = `${r.command || 'OK'} · ${r.rowCount ?? 0} row(s) · ${r.durationMs}ms`;
      out.appendChild(meta);

      const holder = document.createElement('div');
      renderGrid(holder, r);
      out.appendChild(holder);
    }
  } catch (err) {
    out.innerHTML = `<div class="error pad">${escapeHtml(err.message)}</div>`;
  }
}

function deleteConnection(id) {
  const conn = state.connections.find((c) => c.id === id);
  if (!conn) return;
  if (!confirm(`Delete connection "${conn.name}"?`)) return;

  state.connections = state.connections.filter((c) => c.id !== id);
  saveConnections();

  if (state.activeId === id) {
    state.activeId = null;
    $('#workspace').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
  }
  renderConnections();
}

// ------------------------------------------------------------ modal

function openModal(id = null) {
  state.editingId = id;
  $('#form-error').textContent = '';
  $('#form-ok').textContent = '';
  $('#modal-title').textContent = id ? 'Edit connection' : 'New connection';

  const c = id ? state.connections.find((x) => x.id === id) : null;
  $('#f-name').value = c?.name || '';
  $('#f-engine').value = c?.engine || 'postgres';
  $('#f-host').value = c?.host || '';
  $('#f-port').value = c?.port || defaultPort($('#f-engine').value);
  $('#f-user').value = c?.user || '';
  $('#f-password').value = c?.password || '';
  $('#f-database').value = c?.database || '';
  $('#f-ssl').checked = Boolean(c?.ssl);

  updateDbHint();
  $('#modal').classList.remove('hidden');
  $('#f-name').focus();
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.editingId = null;
}

function defaultPort(engineId) {
  return state.engines.find((e) => e.id === engineId)?.defaultPort || '';
}

function updateDbHint() {
  const engine = $('#f-engine').value;
  const hint = $('#db-hint');
  if (engine === 'redis') hint.textContent = '(DB number, e.g. 0)';
  else if (engine === 'mongodb') hint.textContent = '(optional — blank lists all)';
  else if (engine === 'mysql') hint.textContent = '(optional)';
  else hint.textContent = '(e.g. postgres)';
}

function readForm() {
  return {
    id: state.editingId || `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: $('#f-name').value.trim(),
    engine: $('#f-engine').value,
    host: $('#f-host').value.trim(),
    port: Number($('#f-port').value) || defaultPort($('#f-engine').value),
    user: $('#f-user').value,
    password: $('#f-password').value,
    database: $('#f-database').value.trim(),
    ssl: $('#f-ssl').checked,
  };
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

// ------------------------------------------------------------ boot

async function boot() {
  state.engines = await apiGet('/api/engines');

  const sel = $('#f-engine');
  sel.innerHTML = '';
  for (const e of state.engines) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.label;
    sel.appendChild(opt);
  }

  loadConnections();
  renderConnections();
}

function wireEvents() {
  $('#new-connection').addEventListener('click', () => openModal());
  $('#cancel').addEventListener('click', closeModal);

  $('#f-engine').addEventListener('change', () => {
    $('#f-port').value = defaultPort($('#f-engine').value);
    updateDbHint();
  });

  $('#test-conn').addEventListener('click', async () => {
    $('#form-error').textContent = '';
    $('#form-ok').textContent = 'Testing…';
    try {
      const res = await api('/api/test', { connection: readForm() });
      $('#form-ok').textContent = `✓ Connected — ${res.version || 'ok'}`;
    } catch (err) {
      $('#form-ok').textContent = '';
      $('#form-error').textContent = err.message;
    }
  });

  $('#conn-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const conn = readForm();
    if (!conn.name || !conn.host) {
      $('#form-error').textContent = 'Name and host are required';
      return;
    }
    const idx = state.connections.findIndex((c) => c.id === conn.id);
    if (idx >= 0) state.connections[idx] = conn;
    else state.connections.push(conn);

    saveConnections();
    renderConnections();
    closeModal();
    selectConnection(conn.id);
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      $('#pane-browse').classList.toggle('hidden', target !== 'browse');
      $('#pane-query').classList.toggle('hidden', target !== 'query');
    });
  });

  $('#table-filter').addEventListener('input', renderTables);
  $('#run-query').addEventListener('click', runQuery);

  $('#sql').addEventListener('keydown', (e) => {
    // Ctrl/Cmd+Enter runs the query, matching most SQL editors.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
  });

  $('#prev-page').addEventListener('click', () => {
    if (state.activeTable) openTable(state.activeTable, Math.max(0, state.offset - PAGE_SIZE));
  });
  $('#next-page').addEventListener('click', () => {
    if (state.activeTable) openTable(state.activeTable, state.offset + PAGE_SIZE);
  });

  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });

  // --- narrow-layout controls ---
  $('#menu-btn').addEventListener('click', () => {
    if ($('#sidebar').classList.contains('open')) closeDrawer(); else openDrawer();
  });
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#back-to-tables').addEventListener('click', showTableList);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // Leaving the narrow breakpoint (rotation, desktop resize) must clear the
  // drawer and two-step state, or the restored layout inherits stale classes
  // and renders with the sidebar translated off-screen.
  window.matchMedia(NARROW_QUERY).addEventListener('change', (e) => {
    if (!e.matches) { closeDrawer(); showTableList(); }
  });
}

(async function main() {
  wireEvents();
  const unlocked = await initGate();
  if (unlocked) boot();
})();
