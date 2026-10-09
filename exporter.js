/**
 * Offline HTML & CSV Exporter Generator
 * Zero dependencies, pure vanilla JS, XSS escaped, zero emojis.
 */

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function generateHtmlReport(job) {
  if (!job) return '';

  const numbers = job.numbers || [];
  const registered = job.stats?.registered || 0;
  const notRegistered = job.stats?.notRegistered || 0;
  const unknown = job.stats?.unknown || 0;
  const invalid = job.stats?.invalid || 0;
  const totalChecked = registered + notRegistered + unknown;
  const successPct = totalChecked > 0 ? Math.round((registered / totalChecked) * 100) : 0;
  const durationText = job.endTime ? formatDuration(job.endTime - job.startTime) : 'In progress';
  const dateText = new Date(job.startTime).toLocaleString();

  const rowsHtml = numbers.map(item => {
    let badgeClass = 'status-unknown';
    let statusLabel = item.status || 'UNKNOWN';

    if (item.status === 'REGISTERED') {
      badgeClass = 'status-registered';
      statusLabel = 'Registered';
    } else if (item.status === 'NOT_REGISTERED') {
      badgeClass = 'status-not-registered';
      statusLabel = 'Not Registered';
    } else if (item.status === 'INVALID') {
      badgeClass = 'status-invalid';
      statusLabel = 'Invalid';
    } else if (item.status === 'UNKNOWN') {
      badgeClass = 'status-unknown';
      statusLabel = 'Unknown';
    } else if (item.status === 'PENDING') {
      badgeClass = 'status-pending';
      statusLabel = 'Pending';
    }

    const timeStr = item.checkedAt ? new Date(item.checkedAt).toLocaleTimeString() : '-';

    return `
      <tr data-status="${escapeHtml(item.status)}">
        <td class="font-mono">${escapeHtml(item.original)}</td>
        <td class="font-mono">${escapeHtml(item.normalized)}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(statusLabel)}</span></td>
        <td>${escapeHtml(timeStr)}</td>
        <td class="text-subtle">${escapeHtml(item.notes || '-')}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Verification Report - BWAV</title>
  <style>
    :root {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;

      --registered-bg: #dcfce7;
      --registered-text: #166534;
      --not-registered-bg: #fee2e2;
      --not-registered-text: #991b1b;
      --unknown-bg: #fef3c7;
      --unknown-text: #92400e;
      --invalid-bg: #f1f5f9;
      --invalid-text: #475569;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --surface: #1e293b;
        --text: #f8fafc;
        --text-muted: #94a3b8;
        --border: #334155;

        --registered-bg: #064e3b;
        --registered-text: #6ee7b7;
        --not-registered-bg: #7f1d1d;
        --not-registered-text: #fca5a5;
        --unknown-bg: #78350f;
        --unknown-text: #fde68a;
        --invalid-bg: #334155;
        --invalid-text: #cbd5e1;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      padding: 32px 16px;
      line-height: 1.5;
    }

    .container {
      max-width: 1000px;
      margin: 0 auto;
    }

    header {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }

    .brand-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 4px;
    }

    .sub-title {
      font-size: 13px;
      color: var(--text-muted);
    }

    .grid-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
      margin-top: 20px;
    }

    .stat-card {
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 12px 16px;
      border-radius: 8px;
    }

    .stat-val {
      font-size: 22px;
      font-weight: 700;
    }

    .stat-lbl {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .controls-bar {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: space-between;
      align-items: center;
    }

    .search-box {
      position: relative;
      flex: 1;
      min-width: 220px;
    }

    .search-box input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
    }

    .filter-tabs {
      display: flex;
      gap: 6px;
    }

    .filter-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      font-weight: 500;
    }

    .filter-btn.active {
      background: var(--primary);
      color: #ffffff;
      border-color: var(--primary);
    }

    .table-container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 14px;
    }

    th, td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    }

    th {
      background: var(--bg);
      font-weight: 600;
      color: var(--text-muted);
      font-size: 12px;
      text-transform: uppercase;
    }

    tr:last-child td {
      border-bottom: none;
    }

    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
    }

    .status-registered { background: var(--registered-bg); color: var(--registered-text); }
    .status-not-registered { background: var(--not-registered-bg); color: var(--not-registered-text); }
    .status-unknown { background: var(--unknown-bg); color: var(--unknown-text); }
    .status-invalid { background: var(--invalid-bg); color: var(--invalid-text); }
    .status-pending { background: var(--invalid-bg); color: var(--invalid-text); }

    .text-subtle { color: var(--text-muted); font-size: 13px; }

    @media print {
      body { background: #ffffff; color: #000000; padding: 0; }
      .controls-bar { display: none; }
      header, .table-container { border: 1px solid #cccccc; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand-title">
        Bulk WhatsApp Number Checker Report
      </div>
      <div class="sub-title">
        Generated on ${escapeHtml(dateText)} • Duration: ${escapeHtml(durationText)}
      </div>

      <div class="grid-stats">
        <div class="stat-card">
          <div class="stat-lbl">Total Imported</div>
          <div class="stat-val">${job.totalImported || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Duplicates</div>
          <div class="stat-val">${job.duplicateCount || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Registered</div>
          <div class="stat-val" style="color: var(--primary);">${registered}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Not Registered</div>
          <div class="stat-val">${notRegistered}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Unknown</div>
          <div class="stat-val">${unknown}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Success Rate</div>
          <div class="stat-val">${successPct}%</div>
        </div>
      </div>
    </header>

    <div class="controls-bar">
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="Search phone numbers..." oninput="filterTable()">
      </div>
      <div class="filter-tabs">
        <button class="filter-btn active" onclick="setFilter('ALL', this)">All</button>
        <button class="filter-btn" onclick="setFilter('REGISTERED', this)">Registered</button>
        <button class="filter-btn" onclick="setFilter('NOT_REGISTERED', this)">Not Registered</button>
        <button class="filter-btn" onclick="setFilter('UNKNOWN', this)">Unknown</button>
        <button class="filter-btn" onclick="setFilter('INVALID', this)">Invalid</button>
      </div>
    </div>

    <div class="table-container">
      <table id="resultsTable">
        <thead>
          <tr>
            <th>Original Input</th>
            <th>Normalized (E.164)</th>
            <th>Status</th>
            <th>Checked At</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    let currentFilter = 'ALL';

    function setFilter(status, btn) {
      currentFilter = status;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterTable();
    }

    function filterTable() {
      const q = document.getElementById('searchInput').value.toLowerCase().trim();
      const rows = document.querySelectorAll('#resultsTable tbody tr');

      rows.forEach(row => {
        const rowStatus = row.getAttribute('data-status');
        const text = row.textContent.toLowerCase();

        const matchesStatus = (currentFilter === 'ALL' || rowStatus === currentFilter);
        const matchesQuery = (!q || text.includes(q));

        if (matchesStatus && matchesQuery) {
          row.style.display = '';
        } else {
          row.style.display = 'none';
        }
      });
    }
  <\/script>
</body>
</html>`;
}

function generateCsvReport(job) {
  if (!job) return '';

  const numbers = job.numbers || [];
  const header = ['Phone Number', 'Normalized (E.164)', 'Status', 'Checked At', 'Notes'];

  const rows = numbers.map(item => {
    const timeStr = item.checkedAt ? new Date(item.checkedAt).toISOString() : '';
    return [
      item.original || '',
      item.normalized || '',
      item.status || '',
      timeStr,
      item.notes || ''
    ];
  });

  function escapeCsvCell(val) {
    const str = String(val || '');
    let out = str;
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      out = `"${str.replace(/"/g, '""')}"`;
    }
    // CSV injection guard: force text on cells Excel/Sheets would treat as formulas
    if (/^[@=+\-]/.test(str)) out = "'" + out;
    return out;
  }

  return [
    header.map(escapeCsvCell).join(','),
    ...rows.map(row => row.map(escapeCsvCell).join(','))
  ].join('\r\n');
}

if (typeof globalThis !== 'undefined') {
  globalThis.generateHtmlReport = generateHtmlReport;
  globalThis.generateCsvReport = generateCsvReport;
}
