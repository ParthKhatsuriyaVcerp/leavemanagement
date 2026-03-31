// index.js — Login and Registration logic

// ── Redirect if already logged in ────────────────────────────────
(function checkAlreadyLoggedIn() {
  var s = getSession();
  if (s.token) {
    window.location.href = s.approvalLevel > 0 ? 'approver.html' : 'employee.html';
  }
})();

// ── Toggle views ──────────────────────────────────────────────────
function showRegister() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('registerView').classList.remove('hidden');
  buildRoleCards();
  loadManagers();
}

function showLogin() {
  document.getElementById('registerView').classList.add('hidden');
  document.getElementById('loginView').classList.remove('hidden');
  clearAlert('loginError');
}

document.getElementById('goToRegister').addEventListener('click', showRegister);
document.getElementById('goToLogin').addEventListener('click', showLogin);

// ── Build role selection cards dynamically ────────────────────────
function buildRoleCards() {
  var container = document.getElementById('roleCards');
  container.innerHTML = '';

  ROLES.forEach(function(role) {
    // Skip ADMIN from self-registration
    if (role.code === 'ADMIN') return;

    var card = document.createElement('div');
    card.className   = 'role-card';
    card.setAttribute('data-code',  role.code);
    card.setAttribute('data-level', role.level);
    card.innerHTML   =
      '<div class="role-icon">' + role.icon + '</div>' +
      '<div class="role-name">'  + role.label + '</div>' +
      '<div class="role-level">Level ' + role.level + '</div>';

    card.addEventListener('click', function() {
      selectRole(role.code);
    });

    container.appendChild(card);
  });
}

// ── Handle role card selection ────────────────────────────────────
function selectRole(code) {
  // Deselect all cards
  document.querySelectorAll('.role-card').forEach(function(c) {
    c.classList.remove('selected');
  });

  // Select clicked card
  var selected = document.querySelector('.role-card[data-code="' + code + '"]');
  if (selected) selected.classList.add('selected');

  // Update hidden input
  document.getElementById('selectedRole').value = code;

  // Show role description
  var info    = getRoleInfo(code);
  var infoBox = document.getElementById('roleInfoBox');
  infoBox.innerHTML =
    '<strong>' + info.label + '</strong> — ' + info.description +
    ' (Approval Level: ' + info.level + ')';
  infoBox.classList.remove('hidden');

  // Show/hide manager dropdown
  var managerGroup = document.getElementById('managerGroup');
  if (info.needsManager) {
    managerGroup.classList.remove('hidden');
    filterManagersByLevel(info.level);
  } else {
    managerGroup.classList.add('hidden');
    document.getElementById('regManager').value = '';
  }
}

// ── Load managers list from backend ──────────────────────────────
var allManagers = [];

async function loadManagers() {
  try {
    var res  = await fetch(API_BASE + '/Users?$filter=isActive%20eq%20true&$orderby=approvalLevel%20desc');
    if (!res.ok) return;
    var data = await safeJson(res);
    allManagers = (data.value || []).filter(function(u) { return u.approvalLevel > 0; });
  } catch (e) {
    console.error('Could not load managers:', e);
  }
}

// Show only managers with higher approval level than selected role
function filterManagersByLevel(selectedLevel) {
  var sel  = document.getElementById('regManager');
  sel.innerHTML = '<option value="">— Select your manager —</option>';

  var filtered = allManagers.filter(function(u) {
    return u.approvalLevel === selectedLevel + 1 || u.approvalLevel > selectedLevel;
  });

  // If no exact next-level found, show all approvers
  if (filtered.length === 0) {
    filtered = allManagers;
  }

  filtered.forEach(function(mgr) {
    var opt   = document.createElement('option');
    opt.value = mgr.ID;
    opt.text  = mgr.firstName + ' ' + mgr.lastName +
                ' (' + levelLabel(mgr.approvalLevel) +
                (mgr.department ? ' — ' + mgr.department : '') + ')';
    sel.appendChild(opt);
  });
}

// ── LOGIN ─────────────────────────────────────────────────────────
async function doLogin() {
  clearAlert('loginError');

  var email    = document.getElementById('loginEmail').value.trim();
  var password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    return showAlert('loginError', 'Please enter your email and password.', 'error');
  }

  var btn     = document.getElementById('loginBtn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>Signing in...';

  try {
    var res  = await fetch(API_BASE + '/login', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ email: email, password: password })
    });

    var data = await safeJson(res);

    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Invalid email or password');
    }

    saveSession(data);

    // Route based on approvalLevel — any approver goes to approver dashboard
    if (data.approvalLevel > 0) {
      window.location.href = 'approver.html';
    } else {
      window.location.href = 'employee.html';
    }

  } catch (err) {
    showAlert('loginError', err.message, 'error');
  } finally {
    btn.disabled  = false;
    btn.innerHTML = 'Sign in';
  }
}

// ── REGISTER ──────────────────────────────────────────────────────
async function doRegister() {
  clearAlert('regError');
  clearAlert('regSuccess');

  var firstName  = document.getElementById('regFirstName').value.trim();
  var lastName   = document.getElementById('regLastName').value.trim();
  var email      = document.getElementById('regEmail').value.trim();
  var password   = document.getElementById('regPassword').value;
  var department = document.getElementById('regDept').value.trim();
  var roleCode   = document.getElementById('selectedRole').value;
  var managerId  = document.getElementById('regManager').value;

  // Validation
  if (!firstName || !lastName) return showAlert('regError', 'Please enter your full name.', 'error');
  if (!email)                   return showAlert('regError', 'Please enter your email address.', 'error');
  if (!password)                return showAlert('regError', 'Please enter a password.', 'error');
  if (password.length < 8)      return showAlert('regError', 'Password must be at least 8 characters.', 'error');
  if (!roleCode)                return showAlert('regError', 'Please select your role.', 'error');

  var roleInfo = getRoleInfo(roleCode);
  if (roleInfo.needsManager && !managerId) {
    return showAlert('regError', 'Please select your manager.', 'error');
  }

  var btn     = document.getElementById('regBtn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>Creating account...';

  try {
    var res  = await fetch(API_BASE + '/register', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        firstName    : firstName,
        lastName     : lastName,
        email        : email,
        password     : password,
        department   : department,
        roleCode     : roleCode,
        managerId    : managerId || null,
        approvalLevel: roleInfo.level
      })
    });

    var data = await safeJson(res);

    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Registration failed. Please try again.');
    }

    showAlert('regSuccess', 'Account created successfully! Redirecting to sign in...', 'success');
    setTimeout(function() { showLogin(); }, 2000);

  } catch (err) {
    showAlert('regError', err.message, 'error');
  } finally {
    btn.disabled  = false;
    btn.innerHTML = 'Create account';
  }
}

// ── Wire up buttons and Enter key ─────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('regBtn').addEventListener('click', doRegister);

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  var loginHidden = document.getElementById('loginView').classList.contains('hidden');
  if (!loginHidden) doLogin(); else doRegister();
});