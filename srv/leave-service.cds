using { com.leaveapp as db } from '../db/schema';

service LeaveService @(path: '/api') {

  // ─── Auth endpoints (no auth required) ──────────────────────────
  action register(
    email     : String,
    password  : String,
    firstName : String,
    lastName  : String,
    role      : String,
    managerId : String,
    department: String
  ) returns { success: Boolean; message: String; userId: String };

  action login(
    email    : String,
    password : String
  ) returns { success: Boolean; token: String; userId: String; role: String; name: String };

  // ─── Leave endpoints (auth required) ────────────────────────────
  //@requires: 'authenticated-user'
  entity LeaveRequests as projection on db.LeaveRequests
    actions {
      action submitLeave() returns { success: Boolean; wfInstanceId: String };
      action cancelLeave() returns { success: Boolean };
    };

  // ─── Manager endpoints ───────────────────────────────────────────
  //@requires: 'Manager'
  action approveLeave(leaveId: String, comments: String) returns { success: Boolean };

  //@requires: 'Manager'
  action rejectLeave(leaveId: String, comments: String)  returns { success: Boolean };

  // ─── Employee list (for manager dropdown during registration) ────
  @readonly
  @cds.redirection.target
  entity Users           as projection on db.Users excluding { passwordHash };

  @readonly
  entity HierarchyView   as projection on db.EmployeeHierarchyView;

  action workflowCallback(
    leaveId       : String,
    status        : String,
    comments      : String,
    decidedBy     : String,
    callbackSecret: String
  ) returns { success: Boolean; message: String };

}