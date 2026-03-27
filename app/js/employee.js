// ── employee.js — Employee Dashboard Logic ────────────────────────

// ── Auth guard: redirect if not logged in or is a manager ─────────
(function guardRoute() {
  const { token, role, name } = getSession();
  if (!token) {
    window.location.href = 'index.html';
    return;
  }
  if (role === 'MANAGER') {
    window.location.href = 'manager.html';
    return;
  }
  document.getElementById('navName').textContent = name;
})();

// ── Set default dates to today ────────────────────────────────────
(function setDefaultDates() {
  const today = new Date().toISOString().split('T')[0];
  const startEl = document.getElementById('startDate');
  const endEl   = document.getElementById('endDate');

  startEl.value = today;
  endEl.value   = today;
  startEl.min   = today;
  endEl.min     = today;

  startEl.addEventListener('change', function () {
    endEl.min = this.value;
    if (endEl.value < this.value) {
      endEl.value = this.value;
    }
  });
})();

// ── Load leave requests from backend ─────────────────────────────
async function loadLeaves() {
  const tbody = document.getElementById('leavesTable');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#9ca3af;">Loading...</td></tr>';

  try {
    const res = await apiFetch('/LeaveRequests?$orderby=createdAt%20desc');

    // Handle 401 — token expired
    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      throw new Error('Server error: ' + res.status);
    }

    const data = await safeJson(res);
    const rows = data.value || [];

    // Update stat cards
    document.getElementById('statTotal').textContent    = rows.length;
    document.getElementById('statPending').textContent  = rows.filter(r => r.status === 'PENDING').length;
    document.getElementById('statApproved').textContent = rows.filter(r => r.status === 'APPROVED').length;
    document.getElementById('statRejected').textContent = rows.filter(r => r.status === 'REJECTED').length;

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#9ca3af;">No leave requests yet. Submit your first one above!</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (row) {
      const cancelBtn = row.status === 'PENDING'
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

    // Attach cancel button events
    document.querySelectorAll('.cancel-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        cancelLeave(this.getAttribute('data-id'));
      });
    });

  } catch (err) {
    console.error('Failed to load leaves:', err);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#dc2626;">Failed to load data. Please refresh.</td></tr>';
  }
}

// ── Submit new leave request ──────────────────────────────────────
async function submitLeave() {
  clearAlert('formError');
  clearAlert('formSuccess');

  const leaveType = document.getElementById('leaveType').value;
  const startDate = document.getElementById('startDate').value;
  const endDate   = document.getElementById('endDate').value;
  const reason    = document.getElementById('reason').value.trim();
  const { userId } = getSession();

  // Validate inputs
  if (!leaveType) {
    return showAlert('formError', 'Please select a leave type.', 'error');
  }
  if (!startDate || !endDate) {
    return showAlert('formError', 'Please select start and end dates.', 'error');
  }
  if (endDate < startDate) {
    return showAlert('formError', 'End date cannot be before start date.', 'error');
  }

  const totalDays = calcDays(startDate, endDate);
  const btn       = document.getElementById('submitBtn');
  btn.disabled    = true;
  btn.innerHTML   = '<span class="spinner"></span>Submitting...';

  try {
    // Step 1 — Create the leave record in HANA
    const createRes = await apiFetch('/LeaveRequests', 'POST', {
      employee_ID: userId,
      leaveType,
      startDate,
      endDate,
      totalDays,
      reason,
      status: 'PENDING'
    });

    if (!createRes.ok) {
      const errData = await safeJson(createRes);
      throw new Error(errData.error && errData.error.message
        ? errData.error.message
        : 'Failed to create leave request');
    }

    const created = await safeJson(createRes);

    // Step 2 — Trigger the SBPA workflow
    const wfRes = await apiFetch(
      '/LeaveRequests(' + created.ID + ')/submitLeave',
      'POST',
      {}
    );

    if (!wfRes.ok) {
      // Workflow trigger failed but record was created — still show partial success
      const errData = await safeJson(wfRes);
      console.warn('Workflow trigger failed:', errData);
      showAlert('formSuccess', 'Leave request saved. Workflow notification may be delayed.', 'success');
    } else {
      showAlert('formSuccess', 'Leave request submitted! Your manager will receive an approval task.', 'success');
    }

    // Reset form fields
    document.getElementById('leaveType').value = '';
    document.getElementById('reason').value    = '';

    // Refresh the table
    loadLeaves();

  } catch (err) {
    showAlert('formError', err.message, 'error');
  } finally {
    btn.disabled  = false;
    btn.innerHTML = 'Submit leave request';
  }
}

// ── Cancel a pending leave request ───────────────────────────────
async function cancelLeave(leaveId) {
  if (!confirm('Are you sure you want to cancel this leave request?')) return;

  try {
    const res = await apiFetch('/LeaveRequests(' + leaveId + ')/cancelLeave', 'POST', {});
    if (!res.ok) throw new Error('Cancel failed');
    loadLeaves();
  } catch (err) {
    alert('Failed to cancel: ' + err.message);
  }
}

// ── Wire up buttons ───────────────────────────────────────────────
document.getElementById('submitBtn').addEventListener('click', submitLeave);
document.getElementById('refreshBtn').addEventListener('click', loadLeaves);
document.getElementById('logoutBtn').addEventListener('click', logout);

// ── Load data on page start ───────────────────────────────────────
loadLeaves();
