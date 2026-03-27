const API_BASE = '/api';

function getSession() {
  return {
    token  : localStorage.getItem('lm_token'),
    userId : localStorage.getItem('lm_userId'),
    role   : localStorage.getItem('lm_role'),
    name   : localStorage.getItem('lm_name'),
  };
}

function saveSession(data) {
  localStorage.setItem('lm_token',  data.token);
  localStorage.setItem('lm_userId', data.userId);
  localStorage.setItem('lm_role',   data.role);
  localStorage.setItem('lm_name',   data.name);
}

function logout() {
  localStorage.clear();
  window.location.href = 'index.html';
}

async function apiFetch(path, method = 'GET', body = null) {
  const { token } = getSession();

  // Check if token exists before making any request
  if (!token) {
    window.location.href = 'index.html';
    return new Response('{}', { status: 401 });
  }

  const opts = {
    method,
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': 'Bearer ' + token
    }
  };

  if (body !== null) opts.body = JSON.stringify(body);

  const res = await fetch(API_BASE + path, opts);

  // Only logout on 401 for data endpoints, not for actions
  if (res.status === 401 && method === 'GET') {
    console.warn('Session expired — logging out');
    logout();
    return res;
  }

  return res;
}

async function safeJson(res) {
  try {
    const text = await res.text();
    if (!text || text.trim() === '') return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function showAlert(elementId, message, type) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.className   = 'alert alert-' + type + ' show';
}

function clearAlert(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.className   = 'alert';
  el.textContent = '';
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function calcDays(startStr, endStr) {
  const s = new Date(startStr);
  const e = new Date(endStr);
  return Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1;
}