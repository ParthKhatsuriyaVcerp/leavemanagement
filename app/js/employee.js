// employee.js — Employee Dashboard

(function guardRoute() {
  var s = getSession();
  if (!s.token) { window.location.href = 'index.html'; return; }
  if (s.approvalLevel > 0) { window.location.href = 'approver.html'; return; }
  document.getElementById('navName').textContent = s.name;
  var badge = document.getElementById('navRole');
  if (badge) {
    badge.textContent = 'Employee';
    badge.className   = 'role-badge badge-EMPLOYEE';
  }
})();

// ── Set default dates ─────────────────────────────────────────────
(function setDates() {
  var today   = new Date().toISOString().split('T')[0];
  var startEl = document.getElementById('startDate');
  var endEl   = document.getElementById('endDate');
  startEl.value = today; endEl.value = today;
  startEl.min   = today; endEl.min   = today;
  startEl.addEventListener('change', function() {
    endEl.min = this.value;
    if (endEl.value < this.value) endEl.value = this.value;
  });
})();

// ── Build approval progress indicator ────────────────────────────
function buildProgressBar(currentLevel, totalLevels, status) {
  if (!totalLevels || totalLevels <= 1) return '';

  var steps = '';
  for (var i = 1; i <= totalLevels; i++) {
    var dotClass = 'step-dot';
    if (status === 'REJECTED' && i === currentLevel) {
      dotClass += ' rejected';
    } else if (i < currentLevel || status === 'FULLY_APPROVED') {
      dotClass += ' done';
    } else if (i === currentLevel && status !== 'REJECTED') {
      dotClass += ' active';
    }

    var levelNames = { 1: 'Mgr', 2: 'TL', 3: 'PM', 4: 'HR' };
    steps +=
      '<div class="approval-step">' +
        '<div class="' + dotClass + '">' +
          (i < currentLevel || status === 'FULLY_APPROVED' ? '✓' : i) +
        '</div>' +
        '<div class="step-label">' + (levelNames[i] || 'L' + i) + '</div>' +
      '</div>';
  }
  return '<div class="approval-progress">' + steps + '</div>';
}

// ── Load leave requests ───────────────────────────────────────────
async function loadLeaves() {
  var tbody = document.getElementById('leavesTable');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:#9ca3af;">Loading...</td></tr>';

  try {
    var res = await apiFetch('/LeaveRequests?$orderby=createdAt%20desc');
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error('Server error ' + res.status);

    var data = await safeJson(res);
    var rows = data.value || [];

    // Update stats
    document.getElementById('statTotal').textContent    = rows.length;
    document.getElementById('statPending').textContent  = rows.filter(function(r) {
      return r.status === 'PENDING' || r.status === 'LEVEL1_APPROVED' ||
             r.status === 'LEVEL2_APPROVED' || r.status === 'LEVEL3_APPROVED';
    }).length;
    document.getElementById('statApproved').textContent = rows.filter(function(r) {
      return r.status === 'FULLY_APPROVED';
    }).length;
    document.getElementById('statRejected').textContent = rows.filter(function(r) {
      return r.status === 'REJECTED';
    }).length;

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:#9ca3af;">No leave requests yet. Submit your first one above!</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function(row) {
      var canCancel = row.status === 'PENDING';
      var actionBtn = canCancel
        ? '<button class="btn btn-danger btn-sm cancel-btn" data-id="' + row.ID + '">Cancel</button>'
        : '—';

      var progress = buildProgressBar(row.currentLevel, row.totalLevels, row.status);

      return '<tr>' +
        '<td>' + (row.leaveType || '—') + '</td>' +
        '<td>' + formatDate(row.startDate) + '</td>' +
        '<td>' + formatDate(row.endDate) + '</td>' +
        '<td>' + (row.totalDays || '—') + '</td>' +
        '<td>' + statusBadge(row.status) + '</td>' +
        '<td>' + (progress || '—') + '</td>' +
        '<td class="text-muted text-sm">' + (row.comments || '—') + '</td>' +
        '<td>' + actionBtn + '</td>' +
        '</tr>';
    }).join('');

    document.querySelectorAll('.cancel-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { cancelLeave(this.getAttribute('data-id')); });
    });

  } catch (err) {
    console.error('loadLeaves failed:', err);
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:#dc2626;">Failed to load data. Please refresh.</td></tr>';
  }
}

// ── Submit leave ──────────────────────────────────────────────────
async function submitLeave() {
  clearAlert('formError');
  clearAlert('formSuccess');

  var leaveType = document.getElementById('leaveType').value;
  var startDate = document.getElementById('startDate').value;
  var endDate   = document.getElementById('endDate').value;
  var reason    = document.getElementById('reason').value.trim();
  var userId    = getSession().userId;

  if (!leaveType)             return showAlert('formError', 'Please select a leave type.', 'error');
  if (!startDate || !endDate) return showAlert('formError', 'Please select start and end dates.', 'error');
  if (endDate < startDate)    return showAlert('formError', 'End date cannot be before start date.', 'error');

  var totalDays = calcDays(startDate, endDate);
  var btn       = document.getElementById('submitBtn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>Submitting...';

  try {
    // Step 1 — Create leave record (Prefer: return=representation gets us the ID)
    var createRes = await apiCreate('/LeaveRequests', {
      employee_ID: userId,
      leaveType  : leaveType,
      startDate  : startDate,
      endDate    : endDate,
      totalDays  : totalDays,
      reason     : reason,
      status     : 'PENDING'
    });

    if (!createRes.ok) {
      var errText = await createRes.text();
      try {
        var errJson = JSON.parse(errText);
        throw new Error(errJson.error && errJson.error.message ? errJson.error.message : 'Failed to create leave request');
      } catch(e) {
        throw new Error('Failed to create leave request');
      }
    }

     // ── Extract ID — try 3 sources in order of reliability ───────
    var createdId = null;
    // 1. Location header: SAP BAS proxy always sets this even when it
    //    strips the body. Format: "LeaveRequests(uuid)" or full URL ending in same.
    //    This is the most reliable source in the BAS hosted environment.
    var locationHeader = createRes.headers.get('Location') || createRes.headers.get('location') || '';
    console.log('[submitLeave] Location header:', locationHeader);
    if (locationHeader) {
      var locMatch = locationHeader.match(/LeaveRequests\(([^)]+)\)/);
      if (locMatch) createdId = locMatch[1];
    }

    // 2. Response body: works in local dev / non-BAS environments
    if (!createdId) {
      var createdText = await createRes.text();
      console.log('[submitLeave] Response body:', createdText);
      if (createdText && createdText.trim() !== '') {
        try {
          var created = JSON.parse(createdText);
          createdId = created.ID || created.id;
        } catch(e) { /* body was not JSON */ }
      }
    }

    // console.log('[submitLeave] Resolved ID:', createdId);

    // var created   = await safeJson(createRes);
    // var createdId = created.ID || created.id;

    if (!createdId) throw new Error('Leave record created but ID not returned');

    // Step 2 — Trigger the approval workflow
    var wfRes = await apiFetch('/LeaveRequests(' + createdId + ')/submitLeave', 'POST', {});

    if (!wfRes.ok) {
      var wfErr = await safeJson(wfRes);
      console.warn('Workflow trigger issue:', wfErr);
      showAlert('formSuccess', 'Leave request saved. Approval process starting shortly.', 'success');
    } else {
      var wfData = await safeJson(wfRes);
      showAlert('formSuccess',
        'Leave request submitted successfully! It will go through ' +
        (wfData.totalLevels || 'the required') + ' approval level(s).',
        'success');
    }

    document.getElementById('leaveType').value = '';
    document.getElementById('reason').value    = '';
    loadLeaves();

  } catch (err) {
    showAlert('formError', err.message, 'error');
  } finally {
    btn.disabled  = false;
    btn.innerHTML = 'Submit leave request';
  }
}

// ── Cancel leave ──────────────────────────────────────────────────
async function cancelLeave(leaveId) {
  if (!confirm('Are you sure you want to cancel this leave request?')) return;
  try {
    var res = await apiFetch('/LeaveRequests(' + leaveId + ')/cancelLeave', 'POST', {});
    if (!res.ok) throw new Error('Cancel failed');
    loadLeaves();
  } catch (err) {
    alert('Failed to cancel: ' + err.message);
  }
}

// ── Wire up events ────────────────────────────────────────────────
document.getElementById('submitBtn').addEventListener('click', submitLeave);
document.getElementById('refreshBtn').addEventListener('click', loadLeaves);
document.getElementById('logoutBtn').addEventListener('click', logout);

// Auto-refresh every 30 seconds to pick up approval status changes
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