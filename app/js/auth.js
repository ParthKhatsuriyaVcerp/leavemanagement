// auth.js — Shared utilities for all pages

var API_BASE = '/api';
// For BTP deployment change to full URL:
// var API_BASE = 'https://your-cap-app.cfapps.eu10.hana.ondemand.com/api';

// ── Role definitions — single source of truth ─────────────────────
var ROLES = [
  {
    code: 'EMPLOYEE',
    label: 'Employee',
    icon: '👤',
    level: 0,
    description: 'Can submit leave requests',
    needsManager: true
  },
  {
    code: 'MANAGER',
    label: 'Manager',
    icon: '👔',
    level: 1,
    description: 'Approves employee leaves (Level 1)',
    needsManager: true
  },
  {
    code: 'TEAMLEAD',
    label: 'Team Lead',
    icon: '🧑‍💻',
    level: 2,
    description: 'Approves after manager (Level 2)',
    needsManager: true
  },
  {
    code: 'PM',
    label: 'Project Manager',
    icon: '📋',
    level: 3,
    description: 'Approves after TL (Level 3)',
    needsManager: false
  },
  {
    code: 'HR',
    label: 'HR',
    icon: '🏢',
    level: 4,
    description: 'Final approval authority (Level 4)',
    needsManager: false
  },
  {
    code: 'ADMIN',
    label: 'Admin',
    icon: '⚙️',
    level: 99,
    description: 'Full system access',
    needsManager: false
  }
];

// Get role info by code
function getRoleInfo(code) {
  for (var i = 0; i < ROLES.length; i++) {
    if (ROLES[i].code === code) return ROLES[i];
  }
  return { code: code, label: code, icon: '👤', level: 0, needsManager: false };
}

// ── Session helpers ───────────────────────────────────────────────
function getSession() {
  return {
    token: localStorage.getItem('lm_token') || '',
    userId: localStorage.getItem('lm_userId') || '',
    role: localStorage.getItem('lm_role') || '',
    approvalLevel: parseInt(localStorage.getItem('lm_approvalLevel') || '0'),
    name: localStorage.getItem('lm_name') || ''
  };
}

function saveSession(data) {
  localStorage.setItem('lm_token', data.token || '');
  localStorage.setItem('lm_userId', data.userId || '');
  localStorage.setItem('lm_role', data.roleCode || data.role || '');
  localStorage.setItem('lm_approvalLevel', data.approvalLevel != null ? data.approvalLevel : '0');
  localStorage.setItem('lm_name', data.name || '');
}

function logout() {
  localStorage.clear();
  window.location.href = 'index.html';
}

// ── Fetch with X-JWT-Token header (BAS-safe) ──────────────────────
async function apiFetch(path, method, body) {
  method = method || 'GET';
  body = (body !== undefined) ? body : null;

  var session = getSession();

  // Redirect to login if no token on protected routes
  if (!session.token && path !== '/login' && path !== '/register') {
    window.location.href = 'index.html';
    return new Response('{}', { status: 401 });
  }

  var headers = { 'Content-Type': 'application/json' };
  if (session.token) headers['X-JWT-Token'] = session.token;

  var opts = { method: method, headers: headers };
  if (body !== null) opts.body = JSON.stringify(body);

  var res = await fetch(API_BASE + path, opts);

  // Auto logout on session expiry for GET requests
  if (res.status === 401 && method === 'GET') {
    console.warn('[apiFetch] 401 — session expired');
    logout();
  }

  return res;
}

// Special fetch that returns the created entity body
// Uses "Prefer: return=representation" so CAP returns 201 + body
async function apiCreate(path, body) {
  var session = getSession();
  var headers = {
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    'X-JWT-Token': session.token || ''
  };
  if (session.token) headers['X-JWT-Token'] = session.token;

  return fetch(API_BASE + path, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  });
}

// ── Safe JSON parse ───────────────────────────────────────────────
async function safeJson(res) {
  try {
    var text = await res.text();
    if (!text || text.trim() === '') return {};
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

// ── Alert helpers ─────────────────────────────────────────────────
function showAlert(id, msg, type) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'alert alert-' + type + ' show';
}

function clearAlert(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  el.className = 'alert';
}

// ── Date helpers ──────────────────────────────────────────────────
function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function calcDays(s, e) {
  return Math.ceil((new Date(e) - new Date(s)) / 86400000) + 1;
}

// ── Status display helper ─────────────────────────────────────────
function statusBadge(status) {
  var map = {
    'PENDING': 'Pending',
    'LEVEL1_APPROVED': 'Manager Approved',
    'LEVEL2_APPROVED': 'TL Approved',
    'LEVEL3_APPROVED': 'PM Approved',
    'FULLY_APPROVED': 'Fully Approved',
    'REJECTED': 'Rejected',
    'CANCELLED': 'Cancelled'
  };
  var label = map[status] || status;
  return '<span class="status status-' + status + '">' + label + '</span>';
}

// ── Approval level label ──────────────────────────────────────────
function levelLabel(level) {
  var map = { 0: 'Employee', 1: 'Manager', 2: 'Team Lead', 3: 'Project Manager', 4: 'HR', 99: 'Admin' };
  return map[level] || 'Level ' + level;
}