const cds = require('@sap/cds');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'leave-app-secret-key-change-in-prod';

// ── Prevent any unhandled rejection from crashing the process ────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] caught — server will NOT crash:', reason && reason.message || reason);
});

// ── Read JWT user attached by server.js middleware ────────────────
function getJwtUser(req) {
  try {
    if (req._ && req._.req && req._.req.jwtUser) return req._.req.jwtUser;
    var rawReq = req._ && req._.req;
    var headers = rawReq && rawReq.headers;
    var token = headers && (headers['x-jwt-token'] || headers['X-JWT-Token']);
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
  if (!UAA_URL) { console.warn('[SBPA] Credentials not set'); return null; }
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
// Uses cds.run() with plain SQL strings — avoids entity-ref issues
async function triggerWorkflow(leave) {
  // Fetch employee using raw SQL to avoid cds.entities binding issues
  var empRows = await cds.run(
    `SELECT ID, firstName, lastName, email, manager_ID FROM com_leaveapp_Users WHERE ID = ?`,
    [leave.employee_ID]
  );
  var employee = empRows && empRows[0];
  if (!employee) throw new Error('Employee not found (ID: ' + leave.employee_ID + ')');

  var mgrRows = await cds.run(
    `SELECT ID, email FROM com_leaveapp_Users WHERE ID = ?`,
    [employee.manager_ID]
  );
  var manager = mgrRows && mgrRows[0];
  if (!manager) throw new Error('Manager not found for employee ' + leave.employee_ID);

  var totalDays = Math.ceil(
    (new Date(leave.endDate) - new Date(leave.startDate)) / 86400000
  ) + 1;

  var SBPA_URL = process.env.SBPA_WORKFLOW_URL;
  if (!SBPA_URL) {
    console.warn('[SBPA] No SBPA_WORKFLOW_URL set — returning dev stub ID');
    return 'dev-wf-' + Date.now();
  }

  var token = await getSBPAToken();
  var payload = {
    definitionId: process.env.SBPA_DEFINITION_ID,
    context: {
      leaveid: leave.ID,
      employeeid: employee.ID,
      employeename: employee.firstName + ' ' + employee.lastName,
      employeeemail: employee.email,
      managerid: manager.ID,
      manageremail: manager.email,
      leavetype: leave.leaveType,
      startdate: leave.startDate,
      enddate: leave.endDate,
      totaldays: totalDays,
      reason: leave.reason || ''
    }
  };

  console.log('[SBPA] POSTing to:', SBPA_URL);
  console.log('[SBPA] payload:', JSON.stringify(payload, null, 2));

  var response = await fetch(SBPA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(payload)
  });
  var responseText = await response.text();
  console.log('[SBPA] response status:', response.status);
  console.log('[SBPA] response body:', responseText);

  if (!response.ok) {
    throw new Error('SBPA returned HTTP ' + response.status + ' — ' + responseText);
  }
  var data = JSON.parse(responseText);
  return data.id;
}

// ── Helper: get DB table name for LeaveRequests ───────────────────
// CAP sqlite table name = <ServiceName>_<EntityName>
// In BAS/CAP the resolved name is com_leaveapp_LeaveRequests
async function getLeaveById(leaveId) {
  var rows = await cds.run(
    `SELECT * FROM com_leaveapp_LeaveRequests WHERE ID = ?`,
    [leaveId]
  );
  return rows && rows[0];
}

// ── CAP Service Implementation ────────────────────────────────────
module.exports = cds.service.impl(async function () {
  var srv = this;
  var Users = srv.entities.Users;
  var LeaveRequests = srv.entities.LeaveRequests;

  // ── REGISTER ────────────────────────────────────────────────────
  srv.on('register', async function (req) {
    try {
      var d = req.data;
      if (!d.email || !d.password || !d.firstName || !d.lastName || !d.role)
        return req.error(400, 'All fields are required');
      if (!['EMPLOYEE', 'MANAGER'].includes(d.role))
        return req.error(400, 'Role must be EMPLOYEE or MANAGER');
      if (d.role === 'EMPLOYEE' && !d.managerId)
        return req.error(400, 'Employee must select a manager');
      if (d.password.length < 8)
        return req.error(400, 'Password must be at least 8 characters');

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
  srv.on('login', async function (req) {
    try {
      var email = req.data.email;
      var password = req.data.password;
      if (!email || !password) return req.error(400, 'Email and password required');

      const DBUsers = cds.entities['com.leaveapp.Users'];
      var user = await SELECT.one.from(DBUsers).where({ email: email, isActive: true });
      if (!user) return req.error(401, 'Invalid email or password');

      var ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return req.error(401, 'Invalid email or password');

      var token = jwt.sign(
        { userId: user.ID, email: user.email, role: user.role, name: user.firstName + ' ' + user.lastName },
        JWT_SECRET,
        { expiresIn: '8h' }
      );
      return { success: true, token, userId: user.ID, role: user.role, name: user.firstName + ' ' + user.lastName };
    } catch (err) {
      console.error('[login]', err.message);
      return req.error(500, 'Login failed: ' + err.message);
    }
  });

  // ── APPROVE LEAVE ────────────────────────────────────────────────
  srv.on('approveLeave', async function (req) {
    try {
      var leaveId = req.data.leaveId;
      var comments = req.data.comments;
      const DBLeaveRequests = cds.entities['com.leaveapp.LeaveRequests'];
      var leave = await SELECT.one.from(DBLeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found');
      await UPDATE(DBLeaveRequests)
        .set({ status: 'APPROVED', comments: comments || '', approvedAt: new Date().toISOString() })
        .where({ ID: leaveId });
      return { success: true };
    } catch (err) {
      return req.error(500, err.message);
    }
  });

  // ── REJECT LEAVE ─────────────────────────────────────────────────
  srv.on('rejectLeave', async function (req) {
    try {
      var leaveId = req.data.leaveId;
      var comments = req.data.comments;
      const DBLeaveRequests = cds.entities['com.leaveapp.LeaveRequests'];
      var leave = await SELECT.one.from(DBLeaveRequests).where({ ID: leaveId });
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
  srv.on('submitLeave', 'LeaveRequests', async function (req) {
    try {
      // req.params[0] is an object { ID: 'uuid' } for bound actions
      var param = req.params[0];
      var leaveId = (param && typeof param === 'object') ? param.ID : param;
      if (!leaveId) { req.error(400, 'Leave ID missing'); return; }

      // Use raw SQL via cds.run() — avoids entity-ref binding issues
      // that cause "Cannot read properties of undefined (reading 'raw')"
      var leave = await getLeaveById(leaveId);
      if (!leave) { req.error(404, 'Leave request not found'); return; }

      var wfInstanceId = await triggerWorkflow(leave);

      await cds.run(
        `UPDATE com_leaveapp_LeaveRequests SET wfInstanceId = ? WHERE ID = ?`,
        [wfInstanceId, leaveId]
      );

      return { success: true, wfInstanceId: wfInstanceId };
    } catch (err) {
      console.error('[submitLeave] ERROR:', err.message);
      req.error(500, 'submitLeave failed: ' + err.message);
    }
  });

  // ── CANCEL LEAVE ─────────────────────────────────────────────────
  srv.on('cancelLeave', 'LeaveRequests', async function (req) {
    try {
      var param = req.params[0];
      var leaveId = (param && typeof param === 'object') ? param.ID : param;
      if (!leaveId) { req.error(400, 'Leave ID missing'); return; }

      await cds.run(
        `UPDATE com_leaveapp_LeaveRequests SET status = 'CANCELLED' WHERE ID = ?`,
        [leaveId]
      );
      return { success: true };
    } catch (err) {
      console.error('[cancelLeave] ERROR:', err.message);
      req.error(500, 'cancelLeave failed: ' + err.message);
    }
  });

  // ── WORKFLOW CALLBACK — called by SBPA after manager decides ──────
  // SBPA sends this after approve/reject in My Inbox
  this.on('workflowCallback', async function (req) {
    try {
      // 🔓 BYPASS AUTH FOR WORKFLOW
      if (!req.headers.authorization) {
        console.log("⚠️ Workflow call without JWT");
      }
      var leaveId = req.data.leaveId;
      var status = req.data.status;        // 'APPROVED' or 'REJECTED'
      var comments = req.data.comments || '';
      var decidedBy = req.data.decidedBy || '';
      var callbackSecret = req.data.callbackSecret;

      // ── Security check ──────────────────────────────────────────
      // SBPA sends a secret we configured — reject if wrong
      var expectedSecret = process.env.CALLBACK_SECRET || 'my-callback-secret-2024';
      if (callbackSecret !== expectedSecret) {
        console.warn('[callback] Invalid secret received — request blocked');
        return req.error(403, 'Forbidden — invalid callback secret');
      }

      // ── Validate status value ───────────────────────────────────
      if (!['APPROVED', 'REJECTED'].includes(status)) {
        return req.error(400, 'Status must be APPROVED or REJECTED');
      }

      // ── Find the leave request ──────────────────────────────────
      var leave = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) {
        return req.error(404, 'Leave request not found: ' + leaveId);
      }

      // ── Update the record in HANA ───────────────────────────────
      var updateData = {
        status: status,
        comments: comments
      };

      if (status === 'APPROVED') {
        updateData.approvedAt = new Date().toISOString();
      } else {
        updateData.rejectedAt = new Date().toISOString();
      }

      await UPDATE(LeaveRequests)
        .set(updateData)
        .where({ ID: leaveId });

      console.log('[callback] Leave', leaveId, 'updated to', status, 'by', decidedBy);

      return {
        success: true,
        message: 'Leave request ' + leaveId + ' updated to ' + status
      };

    } catch (err) {
      console.error('[callback] Error:', err.message);
      return req.error(500, 'Callback failed: ' + err.message);
    }
  });

  // ── FILTER: Employee sees own, Manager sees team ──────────────────
  srv.before('READ', 'LeaveRequests', async function (req) {
    var decoded = getJwtUser(req);
    if (!decoded) return req.error(401, 'Unauthorized');

    const DBUsers = cds.entities['com.leaveapp.Users'];
    var currentUser = await SELECT.one.from(DBUsers).where({ ID: decoded.userId });
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