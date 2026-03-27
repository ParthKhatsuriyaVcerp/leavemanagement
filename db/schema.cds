namespace com.leaveapp;

using { cuid, managed } from '@sap/cds/common';

entity Users : cuid, managed {
  email        : String(100);
  passwordHash : String(256);
  firstName    : String(50);
  lastName     : String(50);
  role         : String(20) default 'EMPLOYEE';
  manager      : Association to Users;
  department   : String(100);
  isActive     : Boolean default true;
}

// ─── Leave Requests table ─────────────────────────────────────────
entity LeaveRequests : cuid, managed {
  employee     : Association to Users;
  leaveType    : String(50);
  startDate    : Date;
  endDate      : Date;
  totalDays    : Integer;
  reason       : String(500);
  status       : String(20) default 'PENDING';
  wfInstanceId : String(100);
  approvedBy   : Association to Users;
  approvedAt   : DateTime;
  rejectedBy   : Association to Users;
  rejectedAt   : DateTime;
  comments     : String(500);
}

// ─── View: Employee with manager info ────────────────────────────
view EmployeeHierarchyView as
  select from Users as emp {
    emp.ID,
    emp.firstName,
    emp.lastName,
    emp.email,
    emp.role,
    emp.department,
    emp.manager.firstName as managerFirstName,
    emp.manager.lastName  as managerLastName,
    emp.manager.email     as managerEmail
  }
  where emp.isActive = true;