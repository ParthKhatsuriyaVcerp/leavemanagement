const cds = require('@sap/cds');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const JWT_SECRET       = process.env.JWT_SECRET       || 'leave-app-secret-key-change-in-prod';
const CALLBACK_SECRET  = process.env.CALLBACK_SECRET  || 'LeaveApp2024SecureCallback99';

// Role to approval level mapping
const ROLE_LEVEL_MAP = {
  'EMPLOYEE'  : 0,
  'MANAGER'   : 1,
  'TEAMLEAD'  : 2,
  'PM'        : 3,
  'HR'        : 4,
  'ADMIN'     : 99
};

// Status after each level approves
const LEVEL_STATUS_MAP = {
  1: 'LEVEL1_APPROVED',
  2: 'LEVEL2_APPROVED',
  3: 'LEVEL3_APPROVED',
  4: 'FULLY_APPROVED'
};

// ── Read JWT user from request ────────────────────────────────────
function getJwtUser(req) {
  try {
    if (req._ && req._.req && req._.req.jwtUser) return req._.req.jwtUser;
    const raw    = req._ && req._.req;
    const headers = raw && raw.headers;
    const token   = (headers && headers['x-jwt-token']) ||
                    (() => {
                      const a = headers && headers['authorization'];
                      return a && a.startsWith('Bearer ') ? a.slice(7) : null;
                    })();
    return token ? jwt.verify(token, JWT_SECRET) : null;
  } catch { return null; }
}

// ── Find approver at a given level for a department ───────────────
async function findApproverAtLevel(db, employeeId, level) {
  const { Users } = db.entities;

  // Walk up the hierarchy to find who approves at this level
  // Level 1 = direct manager, Level 2 = manager's manager (if TL), etc.
  let currentUserId = employeeId;
  let stepsUp = 0;

  while (stepsUp < 10) { // safety limit
    const user = await SELECT.one.from(Users)
      .columns('ID','firstName','lastName','email','roleCode','approvalLevel','manager_ID')
      .where({ ID: currentUserId });

    if (!user) break;

    // Check if this user's manager can approve at the requested level
    if (!user.manager_ID) break;

    const manager = await SELECT.one.from(Users)
      .columns('ID','firstName','lastName','email','roleCode','approvalLevel')
      .where({ ID: user.manager_ID });

    if (!manager) break;

    if (manager.approvalLevel === level) {
      return manager;
    }

    // Keep going up
    currentUserId = manager.ID;
    stepsUp++;
  }

  // Fallback: find any active user with the right approval level in same dept
  const employee = await SELECT.one.from(Users).where({ ID: employeeId });
  const fallback = await SELECT.one.from(Users)
    .where({ approvalLevel: level, isActive: true, department: employee.department });

  return fallback || null;
}

// ── Determine total approval levels needed ────────────────────────
async function getTotalLevels(db, employeeId) {
  const { Users, ApprovalLevels } = db.entities;
  const employee = await SELECT.one.from(Users).where({ ID: employeeId });

  if (!employee) return 1;

  // Check if department has a custom approval config
  const config = await SELECT.one.from(ApprovalLevels)
    .where({ department: employee.department });

  if (config) return config.totalLevels;

  // Default: 2 levels (Manager + HR)
  return 2;
}

// ── SBPA token cache ──────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getSBPAToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const UAA = process.env.SBPA_UAA_URL;
  const CID = process.env.SBPA_CLIENT_ID;
  const CSC = process.env.SBPA_CLIENT_SECRET;
  if (!UAA) return null;

  const res  = await fetch(`${UAA}/oauth/token`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : `grant_type=client_credentials&client_id=${encodeURIComponent(CID)}&client_secret=${encodeURIComponent(CSC)}`
  });
  const data  = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── Trigger SBPA for a specific approval level ────────────────────
async function triggerWorkflowLevel(leave, approver, level, totalLevels, db) {
  const { Users } = db.entities;
  const employee = await SELECT.one.from(Users).where({ ID: leave.employee_ID });

  const SBPA_URL = process.env.SBPA_WORKFLOW_URL;
  if (!SBPA_URL) {
    console.warn(`[SBPA] No URL set — skipping level ${level} trigger`);
    return 'dev-wf-level' + level + '-' + Date.now();
  }

  const token = await getSBPAToken();
  const payload = {
    definitionId: process.env.SBPA_DEFINITION_ID,
    context: {
      leaveId        : leave.ID,
      employeeId     : employee.ID,
      employeeName   : `${employee.firstName} ${employee.lastName}`,
      employeeEmail  : employee.email,
      approverEmail  : approver.email,
      approverName   : `${approver.firstName} ${approver.lastName}`,
      approverRole   : approver.roleCode,
      approvalLevel  : level,
      totalLevels    : totalLevels,
      leaveType      : leave.leaveType,
      startDate      : leave.startDate,
      endDate        : leave.endDate,
      totalDays      : leave.totalDays,
      reason         : leave.reason || '',
      callbackUrl    : process.env.CALLBACK_URL + '/api/workflowCallback',
      callbackSecret : CALLBACK_SECRET
    }
  };

  const response = await fetch(SBPA_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body   : JSON.stringify(payload)
  });
  var responseText = await response.text();
  console.log('[SBPA] response status:', response.status);
  console.log('[SBPA] response body:', responseText);

  if (!response.ok) {
    throw new Error('SBPA returned HTTP ' + response.status + ' — ' + responseText);
  }
  var data = await responseText;
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
  const { Users, LeaveRequests, ApprovalSteps, ApprovalLevels } = this.entities;

  // ── REGISTER ──────────────────────────────────────────────────
  this.on('register', async (req) => {
    try {
      const { email, password, firstName, lastName, roleCode,
              managerId, department, approvalLevel } = req.data;

      if (!email || !password || !firstName || !lastName || !roleCode)
        return req.error(400, 'All fields are required');

      const validRoles = ['EMPLOYEE','MANAGER','TEAMLEAD','PM','HR','ADMIN'];
      if (!validRoles.includes(roleCode))
        return req.error(400, 'Invalid role');

      if (password.length < 8)
        return req.error(400, 'Password must be at least 8 characters');

      const existing = await SELECT.one.from(Users).where({ email });
      if (existing) return req.error(409, 'Email already registered');

      const newUser = {
        email,
        passwordHash  : await bcrypt.hash(password, 12),
        firstName,
        lastName,
        roleCode,
        approvalLevel : approvalLevel || ROLE_LEVEL_MAP[roleCode] || 0,
        department    : department || '',
        isActive      : true
      };
      if (managerId) newUser.manager_ID = managerId;

      const DBUsers = cds.entities['com.leaveapp.Users'];
      await INSERT.into(DBUsers).entries(newUser);
      return { success: true, message: 'Registration successful! You can now log in.' };
    } catch (err) {
      console.error('[register]', err.message);
      return req.error(500, 'Registration failed: ' + err.message);
    }
  });

  // ── LOGIN ─────────────────────────────────────────────────────
  this.on('login', async (req) => {
    try {
      const { email, password } = req.data;
      if (!email || !password) return req.error(400, 'Email and password required');

      const DBUsers = cds.entities['com.leaveapp.Users'];
      var user = await SELECT.one.from(DBUsers).where({ email: email, isActive: true });
      if (!user) return req.error(401, 'Invalid email or password');

      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return req.error(401, 'Invalid email or password');

      const token = jwt.sign(
        { userId: user.ID, email: user.email, roleCode: user.roleCode,
          approvalLevel: user.approvalLevel, name: `${user.firstName} ${user.lastName}` },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      return {
        success  : true,
        token,
        userId   : user.ID,
        roleCode : user.roleCode,
        approvalLevel: user.approvalLevel,
        name     : `${user.firstName} ${user.lastName}`
      };
    } catch (err) {
      console.error('[login]', err.message);
      return req.error(500, 'Login failed: ' + err.message);
    }
  });

  // ── SUBMIT LEAVE — starts the approval chain ──────────────────
  this.on('submitLeave', 'LeaveRequests', async (req) => {
    try {
      const leaveId = req.params[0];
      const db      = cds.db;

      const leave = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found');

      // Determine how many approval levels this needs
      const totalLevels = await getTotalLevels(db, leave.employee_ID);

      // Find level 1 approver (direct manager)
      const level1Approver = await findApproverAtLevel(db, leave.employee_ID, 1);
      if (!level1Approver) return req.error(400, 'No manager found to approve this request');

      // Create approval step records for all levels
      const { Users } = db.entities;
      const employee = await SELECT.one.from(Users).where({ ID: leave.employee_ID });

      for (let lvl = 1; lvl <= totalLevels; lvl++) {
        const approver = await findApproverAtLevel(db, leave.employee_ID, lvl);
        await INSERT.into(ApprovalSteps).entries({
          leaveRequest_ID: leaveId,
          level          : lvl,
          approverRole   : approver ? approver.roleCode : 'UNKNOWN',
          approverEmail  : approver ? approver.email    : '',
          approverName   : approver ? `${approver.firstName} ${approver.lastName}` : '',
          status         : lvl === 1 ? 'PENDING' : 'WAITING'
        });
      }

      // Update leave with total levels and current level
      await UPDATE(LeaveRequests)
        .set({ totalLevels, currentLevel: 1, status: 'PENDING' })
        .where({ ID: leaveId });

      // Trigger SBPA for level 1
      const leaveUpdated = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      const wfId = await triggerWorkflowLevel(leaveUpdated, level1Approver, 1, totalLevels, db);

      await UPDATE(LeaveRequests).set({ wfInstanceId: wfId }).where({ ID: leaveId });

      return { success: true, wfInstanceId: wfId };

    } catch (err) {
      console.error('[submitLeave]', err.message);
      return req.error(500, err.message);
    }
  });

  // ── WORKFLOW CALLBACK — called by SBPA after each level decision
  this.on('workflowCallback', async (req) => {
    try {
      const { leaveId, status, comments, decidedBy, approvalLevel, callbackSecret } = req.data;

      // Security: validate secret
      if (callbackSecret !== CALLBACK_SECRET) {
        console.warn('[callback] Invalid secret — blocked');
        return req.error(403, 'Forbidden');
      }

      if (!['APPROVED','REJECTED'].includes(status)) {
        return req.error(400, 'Status must be APPROVED or REJECTED');
      }

      const db    = cds.db;
      const leave = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
      if (!leave) return req.error(404, 'Leave request not found: ' + leaveId);

      const level = approvalLevel || leave.currentLevel;

      // Update the approval step for this level
      await UPDATE(ApprovalSteps)
        .set({ status, comments: comments || '', decidedAt: new Date().toISOString() })
        .where({ leaveRequest_ID: leaveId, level });

      if (status === 'REJECTED') {
        // ── REJECTED: stop the chain immediately ──────────────────
        await UPDATE(LeaveRequests)
          .set({
            status    : 'REJECTED',
            comments  : comments || '',
            rejectedAt: new Date().toISOString()
          })
          .where({ ID: leaveId });

        // Mark all remaining levels as SKIPPED
        await UPDATE(ApprovalSteps)
          .set({ status: 'SKIPPED' })
          .where({ leaveRequest_ID: leaveId, status: 'WAITING' });

        console.log(`[callback] Leave ${leaveId} REJECTED at level ${level} by ${decidedBy}`);

      } else {
        // ── APPROVED at this level: check if more levels remain ───
        const nextLevel  = level + 1;
        const totalLevels = leave.totalLevels;

        if (nextLevel > totalLevels) {
          // ── All levels approved — FULLY APPROVED ──────────────
          await UPDATE(LeaveRequests)
            .set({ status: 'FULLY_APPROVED', currentLevel: level })
            .where({ ID: leaveId });

          console.log(`[callback] Leave ${leaveId} FULLY APPROVED after level ${level}`);

        } else {
          // ── More levels remain — trigger next level ────────────
          const levelStatus = LEVEL_STATUS_MAP[level] || `LEVEL${level}_APPROVED`;

      await UPDATE(LeaveRequests)
            .set({ status: levelStatus, currentLevel: nextLevel })
        .where({ ID: leaveId });

          // Find next approver and trigger SBPA for them
          const nextApprover = await findApproverAtLevel(db, leave.employee_ID, nextLevel);

          if (nextApprover) {
            await UPDATE(ApprovalSteps)
              .set({ status: 'PENDING' })
              .where({ leaveRequest_ID: leaveId, level: nextLevel });

            const leaveUpdated = await SELECT.one.from(LeaveRequests).where({ ID: leaveId });
            const wfId = await triggerWorkflowLevel(leaveUpdated, nextApprover, nextLevel, totalLevels, db);

            await UPDATE(LeaveRequests).set({ wfInstanceId: wfId }).where({ ID: leaveId });
            console.log(`[callback] Leave ${leaveId} passed to level ${nextLevel} approver: ${nextApprover.email}`);

          } else {
            // No approver found for next level — auto-approve remaining
            console.warn(`[callback] No approver for level ${nextLevel} — auto-completing`);
            await UPDATE(LeaveRequests)
              .set({ status: 'FULLY_APPROVED' })
              .where({ ID: leaveId });
          }
        }
      }

      return { success: true, message: `Level ${level} ${status} processed` };

    } catch (err) {
      console.error('[callback]', err.message);
      return req.error(500, 'Callback failed: ' + err.message);
    }
  });

  // ── CANCEL LEAVE ──────────────────────────────────────────────
  this.on('cancelLeave', 'LeaveRequests', async (req) => {
    try {
      const leaveId = req.params[0];
      await UPDATE(LeaveRequests).set({ status: 'CANCELLED' }).where({ ID: leaveId });
      await UPDATE(ApprovalSteps).set({ status: 'SKIPPED' }).where({ leaveRequest_ID: leaveId, status: 'PENDING' });
      return { success: true };
    } catch (err) {
      return req.error(500, err.message);
    }
  });

  // ── FILTER: users see only their relevant leaves ───────────────
  this.before('READ', 'LeaveRequests', async (req) => {
    const decoded = getJwtUser(req);
    if (!decoded) return req.error(401, 'Unauthorized');

    const DBUsers = cds.entities['com.leaveapp.Users'];
    var currentUser = await SELECT.one.from(DBUsers).where({ ID: decoded.userId });
    if (!currentUser) return req.error(401, 'User not found');

    if (currentUser.approvalLevel === 0) {
      // Employee — sees only their own
      req.query.where({ employee_ID: currentUser.ID });

    } else {
      // Approver — sees leaves currently at their approval level
      // plus leaves from people they directly manage
      const team = await SELECT.from(Users)
        .columns('ID')
        .where({ manager_ID: currentUser.ID });

      const teamIds = team.map(u => u.ID);

      if (teamIds.length === 0) {
        // No direct reports — show leaves pending at their level
        req.query.where({ currentLevel: currentUser.approvalLevel });
      } else {
        req.query.where({
          or: [
            { employee_ID: { in: teamIds } },
            { currentLevel: currentUser.approvalLevel }
          ]
        });
      }
    }
  });

});