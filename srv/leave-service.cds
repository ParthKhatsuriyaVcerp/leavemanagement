using { com.leaveapp as db } from '../db/schema';

service LeaveService @(path: '/api') {

  // ── Public actions — no auth needed ─────────────────────────
  action register(
    email      : String,
    password   : String,
    firstName  : String,
    lastName   : String,
    roleCode   : String,
    managerId  : String,
    department : String,
    approvalLevel: Integer
  ) returns { success: Boolean; message: String };

  action login(
    email    : String,
    password : String
  ) returns { success: Boolean; token: String; userId: String; roleCode: String; name: String };

  // ── Callback from SBPA — no user token, uses secret ─────────
  action workflowCallback(
    leaveId       : String,
    status        : String,
    comments      : String,
    decidedBy     : String,
    approvalLevel : Integer,
    callbackSecret: String
  ) returns { success: Boolean; message: String };

  // ── Authenticated actions ─────────────────────────────────────
  @requires: 'authenticated-user'
  entity LeaveRequests as projection on db.LeaveRequests
    actions {
      action submitLeave() returns { success: Boolean; wfInstanceId: String };
      action cancelLeave() returns { success: Boolean };
    };

  @requires: 'authenticated-user'
  action approveLeave(leaveId: String, comments: String) returns { success: Boolean };

  @requires: 'authenticated-user'
  action rejectLeave(leaveId: String, comments: String)  returns { success: Boolean };

  @readonly
  @cds.redirection.target
  entity Users           as projection on db.Users excluding { passwordHash };

  @readonly
  entity ApprovalLevels as projection on db.ApprovalLevels;
}