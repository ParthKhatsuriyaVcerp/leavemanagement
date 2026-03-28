/**
 * auth.js — Shared utilities for all pages
 *
 * KEY CHANGE: We send the JWT in "X-JWT-Token" header instead of
 * "Authorization: Bearer" because SAP BAS proxy blocks Authorization
 * headers with non-SAP tokens, returning 401 before your server sees them.
 */

const API_BASE = '/api';
// For BTP deployment change to your full URL:
// const API_BASE = 'https://your-cap-app.cfapps.eu10.hana.ondemand.com/api';

// ── Session helpers ───────────────────────────────────────────────
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

// ── Central fetch function ────────────────────────────────────────
// Sends token in X-JWT-Token header — safe through SAP BAS proxy
async function apiFetch(path, method, body) {
  method = method || 'GET';
  body   = body   || null;

  const { token } = getSession();

  if (!token && path !== '/login' && path !== '/register') {
    window.location.href = 'index.html';
    return new Response('{}', { status: 401 });
  }

  var headers = {
    'Content-Type': 'application/json'
  };

  // Use X-JWT-Token — BAS proxy does NOT block custom headers
  if (token) {
    headers['X-JWT-Token'] = token;
  }

  var opts = { method: method, headers: headers };
  if (body !== null) opts.body = JSON.stringify(body);

  var res = await fetch(API_BASE + path, opts);

  // If token expired, redirect to login
  if (res.status === 401 && method === 'GET') {
    console.warn('[apiFetch] 401 on GET — session expired, logging out');
    logout();
    return res;
  }

  return res;
}

// ── Safe JSON parse — never throws even on empty response ─────────
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
function showAlert(elementId, message, type) {
  var el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.className   = 'alert alert-' + type + ' show';
}

function clearAlert(elementId) {
  var el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = '';
  el.className   = 'alert';
}

// ── Date and calculation helpers ──────────────────────────────────
function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function calcDays(startStr, endStr) {
  var s = new Date(startStr);
  var e = new Date(endStr);
  return Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1;
}