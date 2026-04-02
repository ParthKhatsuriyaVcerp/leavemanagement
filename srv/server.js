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
const PUBLIC_PATHS = ['/login', '/register', '/Users', '/workflowCallback'];

function isPublicPath(path) {
  return PUBLIC_PATHS.some(p =>
    path === p ||
    path.startsWith(p + '?') ||
    path.startsWith(p + '(')
  );
}

// ── JWT verify helper (DEV) ─────────────────────────────────────
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-JWT-Token,Prefer');

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  const isDev = process.env.NODE_ENV !== 'production';

  // ============================================================
  // 🔧 DEVELOPMENT MODE (Custom JWT — BAS safe)
  // ============================================================
  if (isDev) {

    app.use('/api', (req, res, next) => {

      const resourcePath = req.path || '/';
      console.log(`[DEV Auth] ${req.method} ${req.path}`);

      // Public APIs
      if (isPublicPath(resourcePath)) {
        console.log('[DEV Auth] Public — allowed');
        return next();
      }

      // ── Extract token (X-JWT-Token preferred) ────────────────
      let token = req.headers['x-jwt-token'] || req.headers['X-JWT-Token'];

      if (!token) {
        const auth = req.headers['authorization'] || '';
        if (auth.startsWith('Bearer ')) {
          token = auth.slice(7);
        }
      }

      // ── Validate token ───────────────────────────────────────
      const decoded = verifyToken(token);

      if (!decoded) {
        console.log('[DEV Auth] BLOCKED — invalid token');
        return res.status(401).json({
          error: { code: '401', message: 'Unauthorized — please log in again' }
        });
      }

      // ✅ IMPORTANT: CAP expects req.user
      req.user = decoded;

      console.log('[DEV Auth] OK —', decoded.email, decoded.role);
      next();
    });

  } else {

    app.use('/api', (req, res, next) => {

      const resourcePath = req.path || '/';
      console.log(`[PROD Auth] ${req.method} ${req.path}`);

      // Public APIs
      if (isPublicPath(resourcePath)) {
        console.log('[PROD Auth] Public — allowed');
        return next();
      }

      // ✅ CAP already attaches req.user automatically
      if (!req.user) {
        console.log('[PROD Auth] BLOCKED — no user');
        return res.status(401).json({
          error: { code: '401', message: 'Unauthorized' }
        });
      }

      // ── Authenticate via XSUAA ───────────────────────────────
      // passport.authenticate('JWT', { session: false }, (err, user) => {

      //   if (err || !user) {
      //     console.log('[PROD Auth] BLOCKED — unauthorized');
      //     return res.status(401).json({
      //       error: { code: '401', message: 'Unauthorized' }
      //     });
      //   }

      //   // Attach XSUAA user
      //   req.user = user;

      //   console.log('[PROD Auth] OK —', user.id);
      //   next();
      // })(req, res, next);
    });
  }

});

module.exports = cds.server;