const CODE_HEADERS = ['Code', 'Status', 'CreatedAt', 'RedeemedAt', 'RegistrationID'];
const REGISTRATION_HEADERS = [
  'RegistrationID', 'FullName', 'Phone', 'Email', 'RegistrationCode', 'TicketNumber', 'RegisteredAt', 'ParentAddress',
];
const SESSION_SECONDS = 3600;
const PAGE_SIZE = 50;

class PublicError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function doPost(event) {
  let response;
  try {
    const contents = event && event.postData && event.postData.contents;
    if (!contents || contents.length > 4096) fail_('BAD_REQUEST', 'Invalid request.');
    let body;
    try {
      body = JSON.parse(contents);
    } catch (_) {
      fail_('BAD_REQUEST', 'Invalid request.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail_('BAD_REQUEST', 'Invalid request.');
    response = { ok: true, data: dispatch_(body) };
  } catch (error) {
    if (!(error instanceof PublicError)) {
      // Service errors can include user data. Keep public and Cloud Logging messages generic.
      console.error('Registration service request failed.');
      error = new PublicError('TEMPORARY_ERROR', 'The registration service is temporarily unavailable. Please retry.');
    }
    response = { ok: false, error: { code: error.code, message: error.message } };
  }
  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

function dispatch_(body) {
  switch (body.action) {
    case 'health':
      withLock_(() => limit_('public', 75, 60));
      readTables_(settings_());
      return { service: 'gdo-code-registration', version: 2 };
    case 'verify': {
      const code = parseCode_(body.code);
      withLock_(() => limit_('public', 75, 60));
      const { codes } = readTables_(settings_(), false);
      const row = codes.find(entry => entry[0] === code);
      if (!row) fail_('INVALID_CODE', 'This registration link is invalid.');
      if (row[1] !== 'Unused') fail_('CODE_USED', 'This registration link has already been used.');
      return { code };
    }
    case 'redeem':
    case 'redeemWithAddress': {
      const details = parseRegistration_(body);
      return withLock_(() => {
        limit_('public', 75, 60);
        return redeem_(settings_(), details);
      });
    }
    case 'adminLogin':
      return withLock_(() => login_(body.password));
    case 'adminLogout':
      CacheService.getScriptCache().remove(sessionKey_(body.token));
      return {};
    case 'adminGenerate': {
      requireSession_(body.token);
      const requestKey = parseKey_(body.requestKey);
      if (!Number.isInteger(body.count) || body.count < 1 || body.count > 100) {
        fail_('INVALID_COUNT', 'Enter a batch size between 1 and 100.');
      }
      return withLock_(() => {
        requireSession_(body.token);
        limit_('admin', 30, 60);
        return generate_(settings_(), requestKey, body.count);
      });
    }
    case 'adminList':
      requireSession_(body.token);
      withLock_(() => limit_('admin', 30, 60));
      return dashboard_(settings_(), body);
    default:
      fail_('BAD_REQUEST', 'Unknown action.');
  }
}

function redeem_(settings, details) {
  const { codes, registrations } = readTables_(settings);
  const codeIndex = codes.findIndex(row => row[0] === details.code);
  if (codeIndex === -1) fail_('INVALID_CODE', 'This registration link is invalid.');
  const codeRow = codes[codeIndex];
  const registrationId = 'REG-' + digest_(details.code + ':' + details.requestKey);
  const previous = registrations.find(row => row[4] === details.code);

  if (codeRow[1] === 'Used' || previous) {
    if (codeRow[1] === 'Used' && codeRow[4] === registrationId && previous &&
        previous[0] === registrationId && previous[1] === details.fullName &&
        previous[2] === details.phone && (previous[3] || '') === details.email &&
        (previous[7] || '') === details.parentAddress) {
      return ticket_(previous);
    }
    fail_('CODE_USED', 'This registration link has already been used.');
  }
  if (codeRow[1] !== 'Unused') throw new Error('Invalid code status.');
  if (!details.parentAddress) fail_('INVALID_ADDRESS', 'Enter the parent’s address.');

  const highestNumber = registrations.reduce((highest, row) => {
    const match = /^GDO-(\d{6,})$/.exec(row[5] || '');
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  if (!Number.isSafeInteger(highestNumber + 1)) throw new Error('Ticket number limit reached.');
  const ticketNumber = 'GDO-' + String(highestNumber + 1).padStart(6, '0');
  const now = new Date().toISOString();
  const registration = [
    registrationId, details.fullName, details.phone, details.email, details.code, ticketNumber, now, details.parentAddress,
  ];
  const ids = sheetIds_(settings);
  Sheets.Spreadsheets.batchUpdate({
    requests: [
      { appendCells: { sheetId: ids.Registrations, rows: [cells_(registration)], fields: 'userEnteredValue' } },
      { updateCells: {
        start: { sheetId: ids.RegistrationCodes, rowIndex: codeIndex + 1, columnIndex: 1 },
        rows: [cells_(['Used', codeRow[2], now, registrationId])],
        fields: 'userEnteredValue',
      } },
    ],
  }, settings.spreadsheetId);
  return ticket_(registration);
}

function generate_(settings, requestKey, count) {
  const { codes } = readTables_(settings, false);
  const existing = new Set(codes.map(row => row[0]));
  const generated = Array.from({ length: count }, (_, index) => {
    const hex = sign_(settings.secret, 'code:' + requestKey + ':' + count + ':' + index).slice(0, 20);
    return hex.match(/.{4}/g).join('-').toUpperCase();
  });
  if (generated.every(code => existing.has(code))) return { codes: generated };
  if (new Set(generated).size !== count || generated.some(code => existing.has(code))) {
    fail_('CODE_COLLISION', 'A code collided with an existing code. Start a new batch.');
  }
  const now = new Date().toISOString();
  Sheets.Spreadsheets.batchUpdate({
    requests: [{ appendCells: {
      sheetId: sheetIds_(settings).RegistrationCodes,
      rows: generated.map(code => cells_([code, 'Unused', now, '', ''])),
      fields: 'userEnteredValue',
    } }],
  }, settings.spreadsheetId);
  return { codes: generated };
}

function dashboard_(settings, body) {
  const { codes, registrations } = readTables_(settings);
  const redeemed = codes.filter(row => row[1] === 'Used').length;
  const status = ['Used', 'Unused'].includes(body.status) ? body.status : 'All';
  const attendees = body.tab === 'attendees';
  const rows = attendees ? registrations : codes.filter(row => status === 'All' || row[1] === status);
  const requestedPage = Number.isSafeInteger(body.page) && body.page >= 1 ? body.page : 1;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const end = rows.length - (page - 1) * PAGE_SIZE;
  const items = rows.slice(Math.max(0, end - PAGE_SIZE), end).reverse();
  return {
    totals: { generated: codes.length, redeemed, remaining: codes.length - redeemed },
    page, pages,
    items: attendees ? items.map(row => ({
      fullName: row[1], phone: row[2], email: row[3] || '', code: row[4], ticketNumber: row[5], registeredAt: row[6],
      parentAddress: row[7] || '',
    })) : items.map(row => ({ code: row[0], status: row[1], createdAt: row[2], redeemedAt: row[3] || '' })),
  };
}

function login_(password) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) {
    fail_('INVALID_PASSWORD', 'Enter the admin password.');
  }
  limit_('login', 10, 600);
  const settings = settings_();
  if (!equal_(digest_(password), settings.passwordHash)) fail_('INVALID_PASSWORD', 'Incorrect admin password.');
  const token = sign_(settings.secret, 'session:' + Utilities.getUuid() + ':' + Date.now());
  CacheService.getScriptCache().put(sessionKey_(token), '1', SESSION_SECONDS);
  return { token };
}

function sessionKey_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    fail_('UNAUTHENTICATED', 'Sign in to use the admin dashboard.');
  }
  return 'admin-session:' + digest_(token);
}

function requireSession_(token) {
  if (!CacheService.getScriptCache().get(sessionKey_(token))) {
    fail_('UNAUTHENTICATED', 'Your admin session has ended. Sign in again.');
  }
}

function limit_(bucket, maximum, seconds) {
  const window = Math.floor(Date.now() / (seconds * 1000));
  const key = 'rate:' + bucket + ':' + window;
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get(key) || 0);
  if (count >= maximum) fail_('RATE_LIMITED', 'Too many requests. Please wait and try again.');
  cache.put(key, String(count + 1), seconds);
}

function withLock_(operation) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) fail_('BUSY', 'The registration service is busy. Please retry.');
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

function settings_() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  const { SPREADSHEET_ID, APP_SECRET, ADMIN_PASSWORD_SHA256 } = properties;
  if (!/^[\w-]+$/.test(SPREADSHEET_ID || '') || !/^[a-f0-9]{64}$/.test(APP_SECRET || '') ||
      !/^[a-f0-9]{64}$/.test(ADMIN_PASSWORD_SHA256 || '')) {
    throw new Error('Missing or invalid script properties.');
  }
  return { spreadsheetId: SPREADSHEET_ID, secret: APP_SECRET, passwordHash: ADMIN_PASSWORD_SHA256 };
}

function readTables_(settings, includeRegistrations = true) {
  const ranges = includeRegistrations ? ['RegistrationCodes!A:E', 'Registrations!A:H'] : ['RegistrationCodes!A:E'];
  const { valueRanges } = Sheets.Spreadsheets.Values.batchGet(settings.spreadsheetId, {
    ranges, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const codes = tableRows_(valueRanges[0].values, CODE_HEADERS);
  const registrations = includeRegistrations ? tableRows_(valueRanges[1].values, REGISTRATION_HEADERS) : [];
  return { codes, registrations };
}

function tableRows_(values, headers) {
  if (!values || JSON.stringify(values[0]) !== JSON.stringify(headers)) {
    throw new Error('Unexpected worksheet headers. Run setupSpreadsheet.');
  }
  return values.slice(1);
}

function sheetIds_(settings) {
  const cache = CacheService.getScriptCache();
  const key = 'sheet-ids:' + settings.spreadsheetId;
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  const { sheets } = Sheets.Spreadsheets.get(settings.spreadsheetId, { fields: 'sheets(properties(sheetId,title))' });
  const ids = Object.fromEntries(sheets.map(({ properties }) => [properties.title, properties.sheetId]));
  if (!Number.isInteger(ids.RegistrationCodes) || !Number.isInteger(ids.Registrations)) {
    throw new Error('Expected worksheets are missing.');
  }
  cache.put(key, JSON.stringify(ids), 3600);
  return ids;
}

function cells_(values) {
  // Explicit string values preserve leading zeroes and prevent spreadsheet formula injection.
  return { values: values.map(stringValue => ({ userEnteredValue: { stringValue } })) };
}

function setupSpreadsheet() {
  const settings = settings_();
  withLock_(() => {
    const book = SpreadsheetApp.openById(settings.spreadsheetId);
    const schemas = { RegistrationCodes: CODE_HEADERS, Registrations: REGISTRATION_HEADERS };
    Object.entries(schemas).forEach(([name, headers]) => {
      const sheet = book.getSheetByName(name) || book.insertSheet(name);
      const header = sheet.getRange(1, 1, 1, headers.length);
      if (sheet.getLastRow() === 0) {
        header.setValues([headers]).setFontWeight('bold');
        sheet.setFrozenRows(1);
        return;
      }
      const current = header.getValues()[0];
      if (name === 'Registrations' && current[7] === '' &&
          JSON.stringify(current.slice(0, 7)) === JSON.stringify(headers.slice(0, 7)) && sheet.getLastColumn() === 7) {
        sheet.getRange(1, 8).setValue(headers[7]).setFontWeight('bold');
      } else if (JSON.stringify(current) !== JSON.stringify(headers)) {
        throw new Error('Unexpected headers in ' + name + '. Setup did not overwrite existing data.');
      }
    });
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove('sheet-ids:' + settings.spreadsheetId);
    readTables_(settings);
    sheetIds_(settings);
  });
}

function parseCode_(value) {
  const raw = typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]/g, '') : '';
  if (!/^[0-9A-F]{20}$/.test(raw)) fail_('INVALID_CODE', 'This registration link is invalid.');
  return raw.match(/.{4}/g).join('-');
}

function parseKey_(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail_('BAD_REQUEST', 'Invalid request key.');
  return value;
}

function parseRegistration_(body) {
  const code = parseCode_(body.code);
  const requestKey = parseKey_(body.requestKey);
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim().replace(/\s+/g, ' ') : '';
  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const phone = rawPhone.replace(/[\s().-]/g, '');
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const parentAddress = typeof body.parentAddress === 'string' ? body.parentAddress.trim() : '';
  if (fullName.length > 100 || !/\p{L}/u.test(fullName) || /[\u0000-\u001f\u007f]/.test(fullName)) {
    fail_('INVALID_NAME', 'Enter a full name of up to 100 characters.');
  }
  if (rawPhone.length > 40 || !/^\+?\d{7,15}$/.test(phone)) {
    fail_('INVALID_PHONE', 'Enter a phone number with 7 to 15 digits.');
  }
  if ((body.email != null && typeof body.email !== 'string') ||
      (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
    fail_('INVALID_EMAIL', 'Enter a valid email address or leave it blank.');
  }
  if ((body.parentAddress != null && typeof body.parentAddress !== 'string') ||
      parentAddress.length > 250 || /[\u0000-\u001f\u007f]/.test(parentAddress)) {
    fail_('INVALID_ADDRESS', 'Enter a parent’s address of up to 250 characters.');
  }
  return { code, requestKey, fullName, phone, email, parentAddress };
}

function ticket_(row) {
  return { fullName: row[1], ticketNumber: row[5] };
}

function hex_(bytes) {
  return bytes.map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function digest_(value) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}

function sign_(secret, value) {
  return hex_(Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8));
}

function equal_(left, right) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function fail_(code, message) {
  throw new PublicError(code, message);
}
