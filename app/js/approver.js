// approver.js — Dashboard for ALL approver roles (Manager/TL/PM/HR)

var session = getSession();

(function guardRoute() {
  if (!session.token) { window.location.href = 'index.html'; return; }
  if (session.approvalLevel === 0) { window.location.href = 'employee.html'; return; }

  // Set navbar
  document.getElementById('navName').textContent = session.name;

  var roleInfo = getRoleInfo(session.role);
  var badge    = document.getElementById('navRoleBadge');
  badge.textContent = roleInfo.label;
  badge.className   = 'role-badge badge-' + session.role;

  var levelBadge = document.getElementById('navLevelBadge');
  levelBadge.textContent = '(Level ' + session.approvalLevel + ' Approver)';
})();

// ── Tab switching ─────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var tab = this.getAttribute('data-tab');
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
    this.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  });
});

// ── Current pending action ────────────────────────────────────────
var pendingAction = null; // { type, leaveId, employeeName, leaveInfo }

// ── Load all leave data ───────────────────────────────────────────
async function loadLeaves() {
  try {
    var res = await apiFetch('/LeaveRequests?$orderby=createdAt%20desc&$expand=employee');
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error('Server error ' + res.status);

    var data = await safeJson(res);
    var rows = data.value || [];

    // Leaves that need MY approval right now
    var myLevel = session.approvalLevel;
    var needMyApproval = rows.filter(function(r) {
      return r.currentLevel === myLevel &&
             r.status !== 'FULLY_APPROVED' &&
             r.status !== 'REJECTED' &&
             r.status !== 'CANCELLED';
    });

    var myApproved = rows.filter(function(r) {
      // Approved means current level passed my level
      return r.currentLevel > myLevel || r.status === 'FULLY_APPROVED';
    });

    var myRejected = rows.filter(function(r) { return r.status === 'REJECTED'; });

    // Update stats
    document.getElementById('statTotal').textContent    = rows.length;
    document.getElementById('statPending').textContent  = needMyApproval.length;
    document.getElementById('statApproved').textContent = myApproved.length;
    document.getElementById('statRejected').textContent = myRejected.length;

    // Update pending count badge on tab
    var countEl = document.getElementById('pendingCount');
    countEl.textContent = needMyApproval.length > 0 ? needMyApproval.length : '';

    renderPendingTable(needMyApproval);
    renderAllTable(rows);

  } catch (err) {
    console.error('loadLeaves failed:', err);
    showAlert('pageError', 'Failed to load data. Please refresh.', 'error');
  }
}

// ── Render pending approvals table ───────────────────────────────
function renderPendingTable(rows) {
  var tbody = document.getElementById('pendingTable');

  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" style="text-align:center;padding:40px;color:#9ca3af;">' +
      'No requests awaiting your approval — all caught up!' +
      '</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function(row) {
    var empName = getEmpName(row);
    return '<tr>' +
      '<td><strong>' + empName + '</strong><br><span class="text-muted text-sm">' + getEmpEmail(row) + '</span></td>' +
      '<td>' + (row.leaveType || '—') + '</td>' +
      '<td>' + formatDate(row.startDate) + '</td>' +
      '<td>' + formatDate(row.endDate) + '</td>' +
      '<td>' + (row.totalDays || '—') + '</td>' +
      '<td>' +
        '<span style="font-size:12px;color:#6b7280;">Level ' + row.currentLevel + ' of ' + row.totalLevels + '</span>' +
      '</td>' +
      '<td class="text-sm text-muted" style="max-width:160px;">' + (row.reason || '—') + '</td>' +
      '<td>' +
        '<div class="flex-gap">' +
          '<button class="btn btn-success btn-sm approve-btn"' +
            ' data-id="' + row.ID + '" data-name="' + empName + '"' +
            ' data-type="' + (row.leaveType||'') + '"' +
            ' data-start="' + (row.startDate||'') + '"' +
            ' data-end="' + (row.endDate||'') + '"' +
            ' data-days="' + (row.totalDays||'') + '">Approve</button>' +
          '<button class="btn btn-danger btn-sm reject-btn"' +
            ' data-id="' + row.ID + '" data-name="' + empName + '"' +
            ' data-type="' + (row.leaveType||'') + '"' +
            ' data-start="' + (row.startDate||'') + '"' +
            ' data-end="' + (row.endDate||'') + '"' +
            ' data-days="' + (row.totalDays||'') + '">Reject</button>' +
        '</div>' +
      '</td>' +
      '</tr>';
  }).join('');

  // Attach events
  document.querySelectorAll('.approve-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openModal('approve', this.dataset.id, this.dataset.name, this.dataset);
    });
  });
  document.querySelectorAll('.reject-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openModal('reject', this.dataset.id, this.dataset.name, this.dataset);
    });
  });
}

// ── Render all requests table ─────────────────────────────────────
function renderAllTable(rows) {
  var tbody = document.getElementById('allTable');

  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" style="text-align:center;padding:32px;color:#9ca3af;">No requests visible yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function(row) {
    var steps = '';
    if (row.totalLevels > 1) {
      for (var i = 1; i <= row.totalLevels; i++) {
        var done = (row.status === 'FULLY_APPROVED') || (row.currentLevel > i);
        var active = (row.currentLevel === i && row.status !== 'REJECTED' && row.status !== 'FULLY_APPROVED');
        var rejected = (row.status === 'REJECTED' && row.currentLevel === i);
        var dotStyle = 'display:inline-flex;align-items:center;justify-content:center;' +
          'width:18px;height:18px;border-radius:50%;font-size:9px;font-weight:700;margin:0 2px;' +
          (done    ? 'background:#059669;color:#fff;' :
           active  ? 'background:#4f46e5;color:#fff;' :
           rejected? 'background:#dc2626;color:#fff;' :
                     'background:#e5e7eb;color:#9ca3af;');
        steps += '<span style="' + dotStyle + '">' + (done ? '✓' : i) + '</span>';
      }
    }

    return '<tr>' +
      '<td>' + getEmpName(row) + '</td>' +
      '<td>' + (row.leaveType || '—') + '</td>' +
      '<td>' + formatDate(row.startDate) + '</td>' +
      '<td>' + formatDate(row.endDate) + '</td>' +
      '<td>' + (row.totalDays || '—') + '</td>' +
      '<td>' + statusBadge(row.status) + '</td>' +
      '<td>' + (steps || '—') + '</td>' +
      '<td class="text-sm text-muted">' + (row.comments || '—') + '</td>' +
      '</tr>';
  }).join('');
}

// ── Open modal ────────────────────────────────────────────────────
function openModal(type, leaveId, employeeName, dataset) {
  pendingAction = { type: type, leaveId: leaveId };

  document.getElementById('modalTitle').textContent =
    type === 'approve' ? 'Approve leave request' : 'Reject leave request';

  document.getElementById('modalSubtitle').textContent =
    'Employee: ' + employeeName;

  document.getElementById('modalLeaveInfo').innerHTML =
    '<strong>Leave type:</strong> ' + (dataset.type || '—') + ' &nbsp;|&nbsp; ' +
    '<strong>From:</strong> ' + formatDate(dataset.start) + ' &nbsp;|&nbsp; ' +
    '<strong>To:</strong> ' + formatDate(dataset.end) + ' &nbsp;|&nbsp; ' +
    '<strong>Days:</strong> ' + (dataset.days || '—');

  document.getElementById('modalComments').value = '';

  var confirmBtn = document.getElementById('modalConfirmBtn');
  if (type === 'approve') {
    confirmBtn.className   = 'btn btn-success';
    confirmBtn.textContent = 'Approve';
  } else {
    confirmBtn.className   = 'btn btn-danger';
    confirmBtn.textContent = 'Reject';
  }
  confirmBtn.style.flex = '1';

  var backdrop = document.getElementById('modalBackdrop');
  backdrop.classList.remove('hidden');
  backdrop.style.display = 'flex';
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.add('hidden');
  document.getElementById('modalBackdrop').style.display = 'none';
  pendingAction = null;
}

// ── Confirm approve/reject ────────────────────────────────────────
async function confirmAction() {
  if (!pendingAction) return;

  var type     = pendingAction.type;
  var leaveId  = pendingAction.leaveId;
  var comments = document.getElementById('modalComments').value.trim();
  var endpoint = type === 'approve' ? '/approveLeave' : '/rejectLeave';
  var btn      = document.getElementById('modalConfirmBtn');

  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>Processing...';

  try {
    var res = await apiFetch(endpoint, 'POST', { leaveId: leaveId, comments: comments });

    if (!res.ok) {
      var errData = await safeJson(res);
      throw new Error(errData.error && errData.error.message ? errData.error.message : 'Action failed');
    }

    closeModal();

    var msg = type === 'approve'
      ? 'Leave approved. Next approver has been notified.'
      : 'Leave request rejected.';
    showAlert('pageSuccess', msg, 'success');

    setTimeout(function() { clearAlert('pageSuccess'); }, 5000);
    loadLeaves();

  } catch (err) {
    showAlert('pageError', err.message, 'error');
  } finally {
    btn.disabled  = false;
    btn.textContent = type === 'approve' ? 'Approve' : 'Reject';
  }
}

// ── Helper: get employee name from expanded data ──────────────────
function getEmpName(row) {
  if (row.employee && row.employee.firstName) {
    return row.employee.firstName + ' ' + row.employee.lastName;
  }
  return 'Employee';
}

function getEmpEmail(row) {
  if (row.employee && row.employee.email) return row.employee.email;
  return '';
}

// ── Wire up events ────────────────────────────────────────────────
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('modalConfirmBtn').addEventListener('click', confirmAction);
document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
document.getElementById('modalBackdrop').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// Refresh button in header — reuse the tab's refresh
document.querySelectorAll('[id="refreshBtn"]').forEach(function(btn) {
  btn.addEventListener('click', loadLeaves);
});

// Auto-refresh every 30 seconds
var autoRefresh = setInterval(loadLeaves, 30000);
document.addEventListener('visibilitychange', function() {
  if (document.hidden) {
    clearInterval(autoRefresh);
  } else {
    loadLeaves();
    autoRefresh = setInterval(loadLeaves, 30000);
  }
});

loadLeaves();