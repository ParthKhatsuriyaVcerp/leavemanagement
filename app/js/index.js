// ── index.js — Login and Registration logic ───────────────────────

// ── Redirect if already logged in ────────────────────────────────
(function checkAlreadyLoggedIn() {
  const { token, role } = getSession();
  if (token) {
    window.location.href = role === 'MANAGER' ? 'manager.html' : 'employee.html';
  }
})();

// ── Toggle between login and register views ───────────────────────
function showRegister() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('registerView').classList.remove('hidden');
  loadManagers();
}

function showLogin() {
  document.getElementById('registerView').classList.add('hidden');
  document.getElementById('loginView').classList.remove('hidden');
  clearAlert('loginError');
}

document.getElementById('goToRegister').addEventListener('click', showRegister);
document.getElementById('goToLogin').addEventListener('click', showLogin);

// ── Show manager dropdown only for EMPLOYEE role ──────────────────
document.getElementById('regRole').addEventListener('change', function () {
  const group = document.getElementById('managerGroup');
  if (this.value === 'EMPLOYEE') {
    group.classList.remove('hidden');
  } else {
    group.classList.add('hidden');
  }
});

// ── Load managers into the dropdown ──────────────────────────────
async function loadManagers() {
  try {
    const res  = await fetch(API_BASE + "/Users?$filter=role eq 'MANAGER' and isActive eq true");
    if (!res.ok) return;
    const data = await safeJson(res);
    const list = data.value || [];

    const sel = document.getElementById('regManager');
    sel.innerHTML = '<option value="">— Select manager —</option>';
    list.forEach(mgr => {
      const opt  = document.createElement('option');
      opt.value  = mgr.ID;
      opt.text   = mgr.firstName + ' ' + mgr.lastName +
                   (mgr.department ? ' (' + mgr.department + ')' : '');
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('Could not load managers:', err);
  }
}

// ── LOGIN ─────────────────────────────────────────────────────────
async function doLogin() {
  clearAlert('loginError');

  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    return showAlert('loginError', 'Please enter your email and password.', 'error');
  }

  const btn     = document.getElementById('loginBtn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>Signing in...';

  try {
    const res  = await fetch(API_BASE + '/login', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ email, password })
    });

    const data = await safeJson(res);

    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Invalid email or password');
    }

    saveSession(data);

    window.location.href = data.role === 'MANAGER' ? 'manager.html' : 'employee.html';

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

  const firstName  = document.getElementById('regFirstName').value.trim();
  const lastName   = document.getElementById('regLastName').value.trim();
  const email      = document.getElementById('regEmail').value.trim();
  const password   = document.getElementById('regPassword').value;
  const department = document.getElementById('regDept').value.trim();
  const role       = document.getElementById('regRole').value;
  const managerId  = document.getElementById('regManager').value;

  // Validate
  if (!firstName || !lastName || !email || !password || !role) {
    return showAlert('regError', 'Please fill in all required fields.', 'error');
  }
  if (password.length < 8) {
    return showAlert('regError', 'Password must be at least 8 characters.', 'error');
  }
  if (role === 'EMPLOYEE' && !managerId) {
    return showAlert('regError', 'Please select your manager.', 'error');
  }

  const btn     = document.getElementById('regBtn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span>Creating account...';

  try {
    const res  = await fetch(API_BASE + '/register', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ firstName, lastName, email, password, department, role, managerId })
    });

    const data = await safeJson(res);

    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Registration failed. Please try again.');
    }

    showAlert('regSuccess', 'Account created! Redirecting to sign in...', 'success');
    setTimeout(() => showLogin(), 2000);

  } catch (err) {
    showAlert('regError', err.message, 'error');
  } finally {
    btn.disabled  = false;
    btn.innerHTML = 'Create account';
  }
}

// ── Attach button click events ────────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('regBtn').addEventListener('click', doRegister);

// ── Allow Enter key to submit ─────────────────────────────────────
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  const loginHidden = document.getElementById('loginView').classList.contains('hidden');
  if (!loginHidden) {
    doLogin();
  } else {
    doRegister();
  }
});
