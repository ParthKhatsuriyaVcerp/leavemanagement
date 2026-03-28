/**
 * server.js — Custom Express bootstrap for CAP
 *
 * WHY X-JWT-Token instead of Authorization:
 * SAP BAS runs a reverse proxy that intercepts ALL requests to port 4004.
 * If it sees an Authorization header with a non-SAP token, it returns 401
 * BEFORE the request ever reaches your CAP server.
 * Custom headers like X-JWT-Token pass through the BAS proxy untouched.
 */
const cds = require('@sap/cds');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'leave-app-secret-key-change-in-prod';

// Paths that anyone can call without a token
const PUBLIC_PATHS = ['/login', '/register', '/Users'];

function isPublicPath(path) {
  return PUBLIC_PATHS.some(p =>
    path === p ||
    path.startsWith(p + '?') ||
    path.startsWith(p + '(')
  );
}

function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    console.log('[Auth] Token invalid:', e.message);
    return null;
  }
}

cds.on('bootstrap', (app) => {

  // ── CORS — allow all origins and our custom header ─────────────
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-JWT-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // ── Auth middleware — runs before CAP handles any /api request ──
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();

    const resourcePath = req.path.slice(4) || '/';
    console.log(`[Auth] ${req.method} ${req.path}`);

    // Public paths — no token needed
    if (isPublicPath(resourcePath)) {
      console.log('[Auth] Public — allowed');
      return next();
    }

    // Try X-JWT-Token first (BAS-safe), then Authorization as fallback
    let token = req.headers['x-jwt-token'] || req.headers['X-JWT-Token'];

    if (!token) {
      const auth = req.headers['authorization'] || '';
      if (auth.startsWith('Bearer ')) token = auth.slice(7);
    }

    const decoded = verifyToken(token);

    if (!decoded) {
      console.log('[Auth] BLOCKED — no valid token for', req.path);
      return res.status(401).json({
        error: { code: '401', message: 'Unauthorized — please log in again' }
      });
    }

    req.jwtUser = decoded;
    console.log('[Auth] OK —', decoded.email, decoded.role);
    next();
  });

});

module.exports = cds.server;