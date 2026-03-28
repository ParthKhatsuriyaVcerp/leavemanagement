const cds = require('@sap/cds');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'leave-app-secret-key-change-in-prod';

// ── Read JWT user attached by server.js middleware ────────────────
function getJwtUser(req) {
  try {
    // Primary: server.js middleware attaches jwtUser to raw Express request
    if (req._ && req._.req && req._.req.jwtUser) {
      return req._.req.jwtUser;
    }

    // Fallback 1: decode from X-JWT-Token header
    var rawReq = req._ && req._.req;
    var headers = rawReq && rawReq.headers;

    var token = headers && (
      headers['x-jwt-token'] ||
      headers['X-JWT-Token']
    );

    // Fallback 2: Authorization header
    if (!token && headers && headers['authorization']) {
      var auth = headers['authorization'];
      if (auth.startsWith('Bearer ')) token = auth.slice(7);
    }

    if (token) return jwt.verify(token, JWT_SECRET);
    return null;
  } catch (e) {
    console.warn('[getJwtUser] failed:', e.message);
    return null;
  }
}

// ── SBPA token cache ──────────────────────────────────────────────
var cachedToken = null;
var tokenExpiry = 0;

async function getSBPAToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  var UAA_URL = process.env.SBPA_UAA_URL;
  var CLIENT_ID = process.env.SBPA_CLIENT_ID;
  var CLIENT_SECRET = process.env.SBPA_CLIENT_SECRET;

  if (!UAA_URL) {
    console.warn('[SBPA] Credentials not set');
    return null;
  }

  var res = await fetch(UAA_URL + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials' +
      '&client_id=' + encodeURIComponent(CLIENT_ID) +
      '&client_secret=' + encodeURIComponent(CLIENT_SECRET)
  });
  var data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── Trigger SBPA workflow ─────────────────────────────────────────
async function triggerWorkflow(leave, db) {
  var Users = db.entities['com.leaveapp.Users'];

  var employee = await SELECT.one.from(Users).where({ ID: leave.employee_ID });
  if (!employee) throw new Error('Employee not found');

  var manager = await SELECT.one.from(Users).where({ ID: employee.manager_ID });
  if (!manager) throw new Error('Manager not found for this employee');

  var totalDays = Math.ceil(
    (new Date(leave.endDate) - new Date(leave.startDate)) / 86400000
  ) + 1;

  var SBPA_URL = process.env.SBPA_WORKFLOW_URL;
  if (!SBPA_URL) {
    console.warn('[SBPA] No URL set — dev mode');
    return 'dev-wf-' + Date.now();
  }

  var token = await getSBPAToken();
  var payload = {
    definitionId: process.env.SBPA_DEFINITION_ID,
    context: {
      leaveId: leave.ID,
      employeeId: employee.ID,
      employeeName: employee.firstName + ' ' + employee.lastName,
      employeeEmail: employee.email,
      managerId: manager.ID,
      managerEmail: manager.email,
      leaveType: leave.leaveType,
      startDate: leave.startDate,
      endDate: leave.endDate,
      totalDays: totalDays,
      reason: leave.reason || ''
    }
  };

  var response = await fetch(SBPA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error('SBPA error ' + response.status);
  var data = await response.json();
  return data.id;
}

// ── CAP Service Implementation ────────────────────────────────────
module.exports = cds.service.impl(async function () {
  var Users = this.entities.Users;
  var LeaveRequests = this.entities.LeaveRequests;

  // ── REGISTER ────────────────────────────────────────────────────
  this.on('register', async function (req) {
    try {
      var d = req.data;

      if (!d.email || !d.password || !d.firstName || !d.lastName || !d.role) {
        return req.error(400, 'All fields are required');
      }
      if (!['EMPLOYEE', 'MANAGER'].includes(d.role)) {
        return req.error(400, 'Role must be EMPLOYEE or MANAGER');
      }
      if (d.role === 'EMPLOYEE' && !d.managerId) {
        return req.error(400, 'Employee must select a manager');
      }
      if (d.password.length < 8) {
        return req.error(400, 'Password must be at least 8 characters');
      }

      var existing = await SELECT.one.from(Users).where({ email: d.email });
      if (existing) return req.error(409, 'This email is already registered');

      var newUser = {
        email: d.email,
        passwordHash: await bcrypt.hash(d.password, 12),
        firstName: d.firstName,
        lastName: d.lastName,
        role: d.role,
        department: d.department || '',
        isActive: true
      };
      if (d.role === 'EMPLOYEE' && d.managerId) newUser.manager_ID = d.managerId;

      const DBUsers = cds.entities['com.leaveapp.Users'];
      await INSERT.into(DBUsers).entries(newUser);
      return { success: true, message: 'Registration successful! You can now log in.' };

    } catch (err) {
      console.error('[register]', err.message);
      return req.error(500, 'Registration failed: ' + err.message);
    }
  });

  // ── LOGIN ────────────────────────────────────────────────────────
  this.on('login', async function (req) {
    try {
      var email = req.data.email;
      var password = req.data.password;

      if (!email || !password) return req.error(400, 'Email and password required');
      const DBUsers = cds.entities["com.leaveapp.Users"];
      const user = await SELECT.one.from(DBUsers).where({ email, isActive: true });
      if (!user) return req.error(401, 'Invalid email or password');

      var ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return req.error(401, 'Invalid email or password');

      var token = jwt.sign(
        {
          userId: user.ID,
          email: user.email,
          role: user.role,
          name: user.firstName + ' ' + user.lastName
        },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      return {
        success: true,
        token: token,
        userId: user.ID,
        role: user.role,
        name: user.firstName + ' ' + user.lastName
      };

    } catch (err) {
      console.error('[login]', err.message);
      return req.error(500, 'Login failed: ' + err.message);
    }
  });

  // ── APPROVE LEAVE ────────────────────────────────────────────────
  this.on('approveLeave', async function (req) {
    try {
      var leaveId = req.data.leaveId;
      var comments = req.data.comments;
      var leave = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found');

      await UPDATE(LeaveRequests)
        .set({ status: 'APPROVED', comments: comments || '', approvedAt: new Date().toISOString() })
        .where({ ID: leaveId });

      return { success: true };
    } catch (err) {
      return req.error(500, err.message);
    }
  });

  // ── REJECT LEAVE ─────────────────────────────────────────────────
  this.on('rejectLeave', async function (req) {
    try {
      var leaveId = req.data.leaveId;
      var comments = req.data.comments;
      var leave = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found');

      await UPDATE(LeaveRequests)
        .set({ status: 'REJECTED', comments: comments || '', rejectedAt: new Date().toISOString() })
        .where({ ID: leaveId });

      return { success: true };
    } catch (err) {
      return req.error(500, err.message);
    }
  });

  // ── SUBMIT LEAVE ─────────────────────────────────────────────────
  this.on('submitLeave', 'LeaveRequests', async function (req) {
    try {
      var leaveId = req.params[0];
      var leave = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found');

      var wfInstanceId = await triggerWorkflow(leave, cds.db);
      await UPDATE(LeaveRequests).set({ wfInstanceId: wfInstanceId }).where({ ID: leaveId });
      return { success: true, wfInstanceId: wfInstanceId };
    } catch (err) {
      console.error('[submitLeave]', err.message);
      return req.error(500, err.message);
    }
  });

  // ── CANCEL LEAVE ─────────────────────────────────────────────────
  this.on('cancelLeave', 'LeaveRequests', async function (req) {
    try {
      var leaveId = req.params[0];
      await UPDATE(LeaveRequests).set({ status: 'CANCELLED' }).where({ ID: leaveId });
      return { success: true };
    } catch (err) {
      return req.error(500, err.message);
    }
  });

  // ── FILTER: Employee sees own, Manager sees team ──────────────────
  this.before('READ', 'LeaveRequests', async function (req) {
    var decoded = getJwtUser(req);
    if (!decoded) return req.error(401, 'Unauthorized');

    var currentUser = await SELECT.one.from(Users).where({ ID: decoded.userId });
    if (!currentUser) return req.error(401, 'User not found');

    if (currentUser.role === 'EMPLOYEE') {
      req.query.where({ employee_ID: currentUser.ID });

    } else if (currentUser.role === 'MANAGER') {
      var team = await SELECT.from(Users).columns('ID').where({ manager_ID: currentUser.ID });
      var ids = team.map(function (u) { return u.ID; });

      if (ids.length === 0) {
        req.query.where({ ID: null });
      } else {
        req.query.where({ employee_ID: { in: ids } });
      }
    }
  });

});