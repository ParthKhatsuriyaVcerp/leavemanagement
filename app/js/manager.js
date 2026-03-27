// ── manager.js — Manager Dashboard Logic ──────────────────────────

// ── Auth guard ────────────────────────────────────────────────────
(function guardRoute() {
  const { token, role, name } = getSession();
  if (!token) {
    window.location.href = 'index.html';
    return;
  }
  if (role !== 'MANAGER') {
    window.location.href = 'employee.html';
    return;
  }
  document.getElementById('navName').textContent = name;
})();

// ── Track which leave + action is in progress ─────────────────────
let pendingAction = null; // { type: 'approve'|'reject', leaveId }

// ── Load all team leave requests ──────────────────────────────────
async function loadLeaves() {
  try {
    const res = await apiFetch('/LeaveRequests?$orderby=createdAt%20desc&$expand=employee');

    if (res.status === 401) {
      logout();
      return;
    }
    if (!res.ok) throw new Error('Server error ' + res.status);

    const data = await safeJson(res);
    const rows = data.value || [];

    const pending  = rows.filter(function (r) { return r.status === 'PENDING';  });
    const approved = rows.filter(function (r) { return r.status === 'APPROVED'; });
    const rejected = rows.filter(function (r) { return r.status === 'REJECTED'; });

    // Update stats
    document.getElementById('statTotal').textContent    = rows.length;
    document.getElementById('statPending').textContent  = pending.length;
    document.getElementById('statApproved').textContent = approved.length;
    document.getElementById('statRejected').textContent = rejected.length;

    renderPendingTable(pending);
    renderAllTable(rows);

  } catch (err) {
    console.error('Failed to load leaves:', err);
    showAlert('pageError', 'Failed to load data. Please refresh.', 'error');
  }
}

// ── Render pending approvals table ───────────────────────────────
function renderPendingTable(rows) {
  const tbody = document.getElementById('pendingTable');

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#9ca3af;">No pending requests — all caught up!</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function (row) {
    const empName = getEmployeeName(row);
    return '<tr>' +
      '<td><strong>' + empName + '</strong></td>' +
      '<td>' + (row.leaveType || '—') + '</td>' +
      '<td>' + formatDate(row.startDate) + '</td>' +
      '<td>' + formatDate(row.endDate) + '</td>' +
      '<td>' + (row.totalDays || '—') + '</td>' +
      '<td class="text-sm text-muted">' + (row.reason || '—') + '</td>' +
      '<td>' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="btn btn-success btn-sm action-btn" data-id="' + row.ID + '" data-action="approve" data-name="' + empName + '">Approve</button>' +
          '<button class="btn btn-danger btn-sm action-btn"  data-id="' + row.ID + '" data-action="reject"  data-name="' + empName + '">Reject</button>' +
        '</div>' +
      '</td>' +
      '</tr>';
  }).join('');

  // Attach click events to all action buttons
  document.querySelectorAll('.action-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openModal(
        this.getAttribute('data-action'),
        this.getAttribute('data-id'),
        this.getAttribute('data-name')
      );
    });
  });
}

// ── Render all requests table ─────────────────────────────────────
function renderAllTable(rows) {
  const tbody = document.getElementById('allTable');

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#9ca3af;">No requests from your team yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(function (row) {
    return '<tr>' +
      '<td>' + getEmployeeName(row) + '</td>' +
      '<td>' + (row.leaveType || '—') + '</td>' +
      '<td>' + formatDate(row.startDate) + '</td>' +
      '<td>' + formatDate(row.endDate) + '</td>' +
      '<td>' + (row.totalDays || '—') + '</td>' +
      '<td><span class="status status-' + row.status + '">' + row.status + '</span></td>' +
      '<td class="text-sm text-muted">' + (row.comments || '—') + '</td>' +
      '</tr>';
  }).join('');
}

// ── Get employee display name safely ─────────────────────────────
function getEmployeeName(row) {
  if (row.employee && row.employee.firstName) {
    return row.employee.firstName + ' ' + row.employee.lastName;
  }
  return 'Employee';
}

// ── Open the approve/reject confirmation modal ────────────────────
function openModal(type, leaveId, employeeName) {
  pendingAction = { type, leaveId };

  const title     = type === 'approve' ? 'Approve leave request' : 'Reject leave request';
  const confirmBtn = document.getElementById('modalConfirmBtn');

  document.getElementById('modalTitle').textContent    = title;
  document.getElementById('modalSubtitle').textContent = 'Employee: ' + employeeName;
  document.getElementById('modalComments').value       = '';

  // Style the confirm button based on action type
  if (type === 'approve') {
    confirmBtn.className   = 'btn btn-success';
    confirmBtn.textContent = 'Approve';
  } else {
    confirmBtn.className   = 'btn btn-danger';
    confirmBtn.textContent = 'Reject';
  }
  confirmBtn.style.flex = '1';

  document.getElementById('modalBackdrop').classList.remove('hidden');
  document.getElementById('modalBackdrop').style.display = 'flex';
}

// ── Close the modal ───────────────────────────────────────────────
function closeModal() {
  document.getElementById('modalBackdrop').classList.add('hidden');
  document.getElementById('modalBackdrop').style.display = 'none';
  pendingAction = null;
}

// ── Confirm approve or reject action ─────────────────────────────
async function confirmAction() {
  if (!pendingAction) return;

  const { type, leaveId } = pendingAction;
  const comments  = document.getElementById('modalComments').value.trim();
  const btn       = document.getElementById('modalConfirmBtn');
  const endpoint  = type === 'approve' ? '/approveLeave' : '/rejectLeave';

  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>Processing...';

  try {
    const res = await apiFetch(endpoint, 'POST', { leaveId, comments });

    if (!res.ok) {
      const errData = await safeJson(res);
      throw new Error(errData.error && errData.error.message
        ? errData.error.message
        : 'Action failed');
    }

    closeModal();

    const msg = type === 'approve'
      ? 'Leave request approved successfully.'
      : 'Leave request rejected.';
    showAlert('pageSuccess', msg, 'success');

    // Auto-hide success message after 4 seconds
    setTimeout(function () {
      clearAlert('pageSuccess');
    }, 4000);

    loadLeaves();

  } catch (err) {
    showAlert('pageError', err.message, 'error');
  } finally {
    btn.disabled  = false;
    btn.textContent = type === 'approve' ? 'Approve' : 'Reject';
  }
}

// ── Wire up button events ─────────────────────────────────────────
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('refreshBtn').addEventListener('click', loadLeaves);
document.getElementById('modalConfirmBtn').addEventListener('click', confirmAction);
document.getElementById('modalCancelBtn').addEventListener('click', closeModal);

// Close modal when clicking outside the white box
document.getElementById('modalBackdrop').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});

// ── Load data on page start ───────────────────────────────────────
loadLeaves();
