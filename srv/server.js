const cds = require('@sap/cds');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'leave-app-secret-key-change-in-prod';

cds.on('bootstrap', (app) => {
    console.log("🔥 Custom server.js loaded");

    // ── Allow all OPTIONS requests (CORS preflight) ───────────────
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    // ── Public routes — NO auth needed ───────────────────────────
    const PUBLIC_ROUTES = [
        '/api/login',
        '/api/register',
        '/api/Users'      // needed for manager dropdown on register page
    ];

    // ── JWT middleware — runs on every /api request ───────────────
    app.use('/api', (req, res, next) => {
        // // Skip auth for public routes
        // const isPublic = PUBLIC_ROUTES.some(route =>
        //   req.path === route || req.path.startsWith(route + '?')
        // );
        // if (isPublic) return next();

        // // Skip auth for login/register action calls (they come as POST to /api)
        // if (req.path === '/' && req.method === 'POST') return next();

        // ── Detect CAP action calls (login/register) ───────────────
        if (req.method === 'POST' && req.path.startsWith('/')) {
            //const action = req.body && Object.keys(req.body)[0];

            if (req.path === '/login' || req.path === '/register') {
                return next(); // ✅ allow without token
            }
        }

        // ── Public GET routes (like Users list)
        if (req.method === 'GET' && req.path.startsWith('/Users')) {
            return next();
        }

        // Get token from Authorization header
        const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: { code: 401, message: 'No token provided. Please log in.' } });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            // Attach decoded user to request so your handlers can read it
            req.jwtUser = decoded;
            // Also attach to CDS request context
            req.user = { id: decoded.userId, roles: [decoded.role] };
            next();
        } catch (err) {
            return res.status(401).json({ error: { code: 401, message: 'Token expired or invalid. Please log in again.' } });
        }
    });

});

module.exports = cds.server;