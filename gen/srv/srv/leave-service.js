let cachedToken = null;
let tokenExpiry = 0;

async function getSBPAToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const UAA_URL      = process.env.SBPA_UAA_URL;       // the uaa.url from service key
  const CLIENT_ID    = process.env.SBPA_CLIENT_ID;     // uaa.clientid
  const CLIENT_SECRET= process.env.SBPA_CLIENT_SECRET; // uaa.clientsecret

  const response = await fetch(`${UAA_URL}/oauth/token`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
  });

  const data   = await response.json();
  cachedToken  = data.access_token;
  tokenExpiry  = Date.now() + (data.expires_in - 60) * 1000; // refresh 1 min early
  return cachedToken;
}

async function triggerWorkflow(leave, db) {
  const { Users } = db.entities;

  // Get employee details
  const employee = await SELECT.one.from(Users).where({ ID: leave.employee_ID });
  if (!employee) throw new Error('Employee not found');

  // Get manager details
  const manager = await SELECT.one.from(Users).where({ ID: employee.manager_ID });
  if (!manager) throw new Error('Manager not found for this employee');

  // Calculate total days
  const start     = new Date(leave.startDate);
  const end       = new Date(leave.endDate);
  const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

  const SBPA_URL           = process.env.SBPA_WORKFLOW_URL;
  const SBPA_TOKEN         = await getSBPAToken(); //process.env.SBPA_TOKEN;
  const SBPA_DEFINITION_ID = process.env.SBPA_DEFINITION_ID;

  if (!SBPA_URL) {
    console.warn('SBPA_WORKFLOW_URL not set — skipping workflow trigger in dev mode');
    return 'dev-wf-' + Date.now();
  }

  const payload = {
    definitionId: SBPA_DEFINITION_ID,
    context: {
      leaveId      : leave.ID,
      employeeId   : employee.ID,
      employeeName : `${employee.firstName} ${employee.lastName}`,
      employeeEmail: employee.email,
      managerId    : manager.ID,
      managerEmail : manager.email,            // ← this is what your form recipient uses
      leaveType    : leave.leaveType,
      startDate    : leave.startDate,
      endDate      : leave.endDate,
      totalDays    : totalDays,
      reason       : leave.reason || ''
    }
  };

  const response = await fetch(SBPA_URL, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${SBPA_TOKEN}`
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