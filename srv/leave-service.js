const cds     = require('@sap/cds');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'leave-app-secret-key-change-in-prod';

// ── SBPA Token cache ──────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getSBPAToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const UAA_URL       = process.env.SBPA_UAA_URL;
  const CLIENT_ID     = process.env.SBPA_CLIENT_ID;
  const CLIENT_SECRET = process.env.SBPA_CLIENT_SECRET;

  if (!UAA_URL || !CLIENT_ID || !CLIENT_SECRET) {
    console.warn('SBPA credentials not set — skipping token fetch');
    return null;
  }

  const response = await fetch(`${UAA_URL}/oauth/token`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}`
  });

  const data  = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── Decode JWT from request — works in BAS dev environment ────────
function decodeUserFromRequest(req) {
  try {
    // Primary: from our Express middleware in server.js
    if (req._ && req._.req && req._.req.jwtUser) {
      return req._.req.jwtUser;
    }
    // Fallback: decode manually from header
    const raw    = req._ && req._.req;
    const header = (raw && raw.headers && raw.headers.authorization) || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// ── SBPA Workflow trigger ─────────────────────────────────────────
async function triggerWorkflow(leave, db) {
  const { Users } = db.entities;

  const employee = await SELECT.one.from(Users).where({ ID: leave.employee_ID });
  if (!employee) throw new Error('Employee not found');

  const manager = await SELECT.one.from(Users).where({ ID: employee.manager_ID });
  if (!manager) throw new Error('Manager not found for this employee');

  const start     = new Date(leave.startDate);
  const end       = new Date(leave.endDate);
  const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

  const SBPA_URL           = process.env.SBPA_WORKFLOW_URL;
  const SBPA_DEFINITION_ID = process.env.SBPA_DEFINITION_ID;

  if (!SBPA_URL) {
    console.warn('SBPA_WORKFLOW_URL not set — dev mode, skipping workflow');
    return 'dev-wf-' + Date.now();
  }

  const token   = await getSBPAToken();
  const payload = {
    definitionId: SBPA_DEFINITION_ID,
    context: {
      leaveId      : leave.ID,
      employeeId   : employee.ID,
      employeeName : `${employee.firstName} ${employee.lastName}`,
      employeeEmail: employee.email,
      managerId    : manager.ID,
      managerEmail : manager.email,
      leaveType    : leave.leaveType,
      startDate    : leave.startDate,
      endDate      : leave.endDate,
      totalDays,
      reason       : leave.reason || ''
    }
  };

  const response = await fetch(SBPA_URL, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SBPA error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data.id;
}

// ── Main service ──────────────────────────────────────────────────
module.exports = cds.service.impl(async function () {
  const { Users, LeaveRequests } = this.entities;

  // ── REGISTER ──────────────────────────────────────────────────
  this.on('register', async (req) => {
    try {
      const { email, password, firstName, lastName, role, managerId, department } = req.data;

      if (!email || !password || !firstName || !lastName || !role) {
        return req.error(400, 'All fields are required');
      }
      if (!['EMPLOYEE', 'MANAGER'].includes(role)) {
        return req.error(400, 'Role must be EMPLOYEE or MANAGER');
      }
      if (role === 'EMPLOYEE' && !managerId) {
        return req.error(400, 'Employee must select a manager');
      }
      if (password.length < 8) {
        return req.error(400, 'Password must be at least 8 characters');
      }

      const existing = await SELECT.one.from(Users).where({ email });
      if (existing) return req.error(409, 'This email is already registered');

      const passwordHash = await bcrypt.hash(password, 12);

      const newUser = {
        email,
        passwordHash,
        firstName,
        lastName,
        role,
        department : department || '',
        isActive   : true
      };

      if (role === 'EMPLOYEE' && managerId) {
        newUser.manager_ID = managerId;
      }

      const DBUsers = cds.entities['com.leaveapp.Users'];
      await INSERT.into(DBUsers).entries(newUser);

      return { success: true, message: 'Registration successful! You can now log in.' };

    } catch (err) {
      console.error('Register error:', err);
      return req.error(500, 'Registration failed: ' + err.message);
    }
  });

  // ── LOGIN ──────────────────────────────────────────────────────
  this.on('login', async (req) => {
    try {
      const { email, password } = req.data;

      if (!email || !password) return req.error(400, 'Email and password are required');

      const DBUsers = cds.entities["com.leaveapp.Users"];
      const user = await SELECT.one.from(DBUsers).where({ email, isActive: true });
      if (!user) return req.error(401, 'Invalid email or password');

      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) return req.error(401, 'Invalid email or password');

      const token = jwt.sign(
        {
          userId: user.ID,
          email : user.email,
          role  : user.role,
          name  : `${user.firstName} ${user.lastName}`
        },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      return {
        success: true,
        token,
        userId : user.ID,
        role   : user.role,
        name   : `${user.firstName} ${user.lastName}`
      };

    } catch (err) {
      console.error('Login error:', err);
      return req.error(500, 'Login failed: ' + err.message);
    }
  });

  // ── APPROVE LEAVE ──────────────────────────────────────────────
  this.on('approveLeave', async (req) => {
    try {
      const { leaveId, comments } = req.data;
      const leave = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found');

      await UPDATE(LeaveRequests)
        .set({ status: 'APPROVED', comments: comments || '', approvedAt: new Date().toISOString() })
        .where({ ID: leaveId });

      return { success: true };
    } catch (err) {
      return req.error(500, err.message);
    }
  });

  // ── REJECT LEAVE ───────────────────────────────────────────────
  this.on('rejectLeave', async (req) => {
    try {
      const { leaveId, comments } = req.data;
      const leave = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found');

      await UPDATE(LeaveRequests)
        .set({ status: 'REJECTED', comments: comments || '', rejectedAt: new Date().toISOString() })
        .where({ ID: leaveId });

      return { success: true };
    } catch (err) {
      return req.error(500, err.message);
    }
  });

  // ── SUBMIT LEAVE ───────────────────────────────────────────────
  this.on('submitLeave', 'LeaveRequests', async (req) => {
    try {
      const leaveId = req.params[0];
      const leave   = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found');

      const wfInstanceId = await triggerWorkflow(leave, cds.db);
      await UPDATE(LeaveRequests).set({ wfInstanceId }).where({ ID: leaveId });

      return { success: true, wfInstanceId };
    } catch (err) {
      console.error('Submit leave error:', err);
      return req.error(500, err.message);
    }
  });

  // ── CANCEL LEAVE ───────────────────────────────────────────────
  this.on('cancelLeave', 'LeaveRequests', async (req) => {
    try {
      const leaveId = req.params[0];
      await UPDATE(LeaveRequests).set({ status: 'CANCELLED' }).where({ ID: leaveId });
      return { success: true };
    } catch (err) {
      return req.error(500, err.message);
    }
  });

  // ── FILTER LeaveRequests by role ───────────────────────────────
  // This runs BEFORE every READ on LeaveRequests
  // Employee → sees only their own
  // Manager  → sees only their team's
  this.before('READ', 'LeaveRequests', async (req) => {
    const decoded = decodeUserFromRequest(req);

    // If no valid token — reject with 401
    if (!decoded) {
      return req.error(401, 'Unauthorized — please log in again');
    }

    const currentUser = await SELECT.one.from(Users).where({ ID: decoded.userId });
    if (!currentUser) return req.error(401, 'User not found');

    if (currentUser.role === 'EMPLOYEE') {
      // Employee sees only their own requests
      req.query.where({ employee_ID: currentUser.ID });

    } else if (currentUser.role === 'MANAGER') {
      // Manager sees requests from their direct reports
      const subordinates = await SELECT.from(Users)
        .columns('ID')
        .where({ manager_ID: currentUser.ID });

      const ids = subordinates.map(s => s.ID);

      if (ids.length === 0) {
        // Manager has no team yet — return empty result safely
        req.query.where('1 = 2');
      } else {
        req.query.where({ employee_ID: { in: ids } });
      }
    }
  });

});