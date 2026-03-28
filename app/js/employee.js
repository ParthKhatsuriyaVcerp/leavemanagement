// ── employee.js ───────────────────────────────────────────────────

(function guardRoute() {
  var s = getSession();
  if (!s.token) { window.location.href = 'index.html'; return; }
  if (s.role === 'MANAGER') { window.location.href = 'manager.html'; return; }
  document.getElementById('navName').textContent = s.name;
})();

(function setDefaultDates() {
  var today   = new Date().toISOString().split('T')[0];
  var startEl = document.getElementById('startDate');
  var endEl   = document.getElementById('endDate');
  startEl.value = today;
  endEl.value   = today;
  startEl.min   = today;
  endEl.min     = today;
  startEl.addEventListener('change', function () {
    endEl.min = this.value;
    if (endEl.value < this.value) endEl.value = this.value;
  });
})();

// ── Load leave requests ───────────────────────────────────────────
async function loadLeaves() {
  var tbody = document.getElementById('leavesTable');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#9ca3af;">Loading...</td></tr>';

  try {
    var res = await apiFetch('/LeaveRequests?$orderby=createdAt%20desc');
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error('Server error ' + res.status);

    var data = await safeJson(res);
    var rows = data.value || [];

    document.getElementById('statTotal').textContent    = rows.length;
    document.getElementById('statPending').textContent  = rows.filter(function(r){ return r.status==='PENDING';  }).length;
    document.getElementById('statApproved').textContent = rows.filter(function(r){ return r.status==='APPROVED'; }).length;
    document.getElementById('statRejected').textContent = rows.filter(function(r){ return r.status==='REJECTED'; }).length;

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#9ca3af;">No leave requests yet.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function(row) {
      var cancelBtn = row.status === 'PENDING'
        ? '<button class="btn btn-danger btn-sm cancel-btn" data-id="' + row.ID + '">Cancel</button>'
        : '—';
      return '<tr>' +
        '<td>' + (row.leaveType || '—') + '</td>' +
        '<td>' + formatDate(row.startDate) + '</td>' +
        '<td>' + formatDate(row.endDate) + '</td>' +
        '<td>' + (row.totalDays || '—') + '</td>' +
        '<td><span class="status status-' + row.status + '">' + row.status + '</span></td>' +
        '<td class="text-muted text-sm">' + (row.comments || '—') + '</td>' +
        '<td>' + cancelBtn + '</td>' +
        '</tr>';
    }).join('');

    document.querySelectorAll('.cancel-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { cancelLeave(this.getAttribute('data-id')); });
    });

  } catch (err) {
    console.error('loadLeaves failed:', err);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#dc2626;">Failed to load. Please refresh.</td></tr>';
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

  if (!leaveType)           return showAlert('formError', 'Please select a leave type.', 'error');
  if (!startDate || !endDate) return showAlert('formError', 'Please select start and end dates.', 'error');
  if (endDate < startDate)  return showAlert('formError', 'End date cannot be before start date.', 'error');

  var totalDays = calcDays(startDate, endDate);
  var btn       = document.getElementById('submitBtn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>Submitting...';

  try {
    // ── Step 1: Create leave record ──────────────────────────────
    // Send "Prefer: return=representation" so CAP returns the created
    // record with its ID instead of the default empty 204 response
    var token = getSession().token;
    var createRes = await fetch(API_BASE + '/LeaveRequests', {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'X-JWT-Token'  : token,
        'Prefer'       : 'return=representation'   // ← KEY: tells CAP return the created record
      },
      body: JSON.stringify({
        employee_ID: userId,
        leaveType  : leaveType,
        startDate  : startDate,
        endDate    : endDate,
        totalDays  : totalDays,
        reason     : reason,
        status     : 'PENDING'
      })
    });

    console.log('[submitLeave] Create status:', createRes.status);

    // With Prefer: return=representation, CAP returns 201 with the full record
    if (!createRes.ok) {
      var errText = await createRes.text();
      console.error('[submitLeave] Create failed:', errText);
      try {
        var errJson = JSON.parse(errText);
        throw new Error(errJson.error && errJson.error.message ? errJson.error.message : 'Failed to create leave request');
      } catch(e) {
        if (e.message !== 'Failed to create leave request') throw e;
        throw new Error('Failed to create leave request');
      }
    }

    var createdText = await createRes.text();
    console.log('[submitLeave] Create response body:', createdText);

    var created = {};
    if (createdText && createdText.trim() !== '') {
      try { created = JSON.parse(createdText); } catch(e) { created = {}; }
    }

    var createdId = created.ID || created.id;
    console.log('[submitLeave] Created ID:', createdId);

    // ── Step 2: Trigger workflow if we have the ID ───────────────
    if (createdId) {
      var wfRes = await apiFetch('/LeaveRequests(' + createdId + ')/submitLeave', 'POST', {});
      if (!wfRes.ok) {
        var wfErr = await safeJson(wfRes);
        console.warn('[submitLeave] Workflow trigger failed:', wfErr);
        showAlert('formSuccess', 'Leave request saved. Workflow notification may be delayed.', 'success');
      } else {
        showAlert('formSuccess', 'Leave request submitted! Your manager will receive an approval task.', 'success');
      }
    } else {
      // Record created but could not get ID — still success
      console.warn('[submitLeave] Record created but ID not returned. Workflow not triggered.');
      showAlert('formSuccess', 'Leave request saved successfully.', 'success');
    }

    document.getElementById('leaveType').value = '';
    document.getElementById('reason').value    = '';
    loadLeaves();

  } catch (err) {
    console.error('[submitLeave] Error:', err.message);
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

loadLeaves();