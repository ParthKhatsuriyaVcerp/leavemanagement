namespace com.leaveapp;
using { cuid, managed } from '@sap/cds/common';

// ── Users — supports multi-level hierarchy ────────────────────────
entity Users : cuid, managed {
  email         : String(100) not null;
  passwordHash  : String(256) not null;
  firstName     : String(50)  not null;
  lastName      : String(50)  not null;

  // roleCode maps to XSUAA role: EMPLOYEE, MANAGER, TEAMLEAD, PM, HR, ADMIN
  roleCode      : String(20)  not null default 'EMPLOYEE';

  // approvalLevel: which level this person approves at
  // 0 = Employee (cannot approve)
  // 1 = Manager  (approves level 1)
  // 2 = Team Lead (approves level 2)
  // 3 = Project Manager (approves level 3)
  // 4 = HR (approves level 4)
  approvalLevel : Integer     not null default 0;

  manager       : Association to Users;   // direct manager (level 1)
  department    : String(100);
  isActive      : Boolean     default true;
}

// ── Defines how many approval levels a department needs ──────────
entity ApprovalLevels : cuid {
  department    : String(100) not null;
  totalLevels   : Integer     not null default 2;
  level1Role    : String(20)  default 'MANAGER';
  level2Role    : String(20)  default 'TEAMLEAD';
  level3Role    : String(20)  default 'PM';
  level4Role    : String(20)  default 'HR';
}

// ── Leave Requests ────────────────────────────────────────────────
entity LeaveRequests : cuid, managed {
  employee      : Association to Users not null;
  leaveType     : String(50)  not null;
  startDate     : Date        not null;
  endDate       : Date        not null;
  totalDays     : Integer;
  reason        : String(500);

  // Overall status
  status        : String(20)  not null default 'PENDING';
  // PENDING | LEVEL1_APPROVED | LEVEL2_APPROVED | LEVEL3_APPROVED | FULLY_APPROVED | REJECTED | CANCELLED

  // Current approval level waiting for decision
  currentLevel  : Integer     not null default 1;

  // Total levels needed for this request
  totalLevels   : Integer     not null default 1;

  wfInstanceId  : String(100);
  comments      : String(500);
  rejectedBy    : Association to Users;
  rejectedAt    : DateTime;
}

// ─── View: Employee with manager info ────────────────────────────
view EmployeeHierarchyView as
  select from Users as emp {
    emp.ID,
    emp.firstName,
    emp.lastName,
    emp.email,
    emp.roleCode,
    emp.department,
    emp.manager.firstName as managerFirstName,
    emp.manager.lastName  as managerLastName,
    emp.manager.email     as managerEmail
  }
  where emp.isActive = true;

  // ── Approval Steps — one row per level per leave request ──────────
entity ApprovalSteps : cuid, managed {
  leaveRequest  : Association to LeaveRequests not null;
  level         : Integer     not null;
  approverRole  : String(20)  not null;
  approverEmail : String(100);
  approverName  : String(100);
  status        : String(20)  not null default 'PENDING';
  // PENDING | APPROVED | REJECTED | SKIPPED
  comments      : String(500);
  decidedAt     : DateTime;
}