const test = require('node:test');
const assert = require('node:assert/strict');
const mot = require('../car-buying-assistant.user.js');

const TODAY = new Date('2026-11-03T12:00:00Z');

function motTest(date, result, miles, extra = {}) {
  return {
    completedDate: `${date}T10:00:00.000Z`,
    testResult: result,
    expiryDate: result === 'PASSED' ? extra.expiry || null : null,
    odometerValue: miles === null ? null : String(miles),
    odometerUnit: miles === null ? null : extra.unit || 'MI',
    odometerResultType: miles === null ? 'UNREADABLE' : 'READ',
    dataSource: 'DVSA',
    defects: extra.defects || [],
  };
}

function vehicle(tests, extra = {}) {
  return {
    registration: 'AB12CDE', make: 'FORD', model: 'FOCUS', primaryColour: 'Silver', fuelType: 'Petrol',
    engineSize: '1596', firstUsedDate: '2012-05-01', hasOutstandingRecall: 'No', motTests: tests, ...extra,
  };
}

test('normalisePlate strips spaces and rejects junk', () => {
  assert.equal(mot.normalisePlate(' ab12 cde '), 'AB12CDE');
  assert.equal(mot.normalisePlate('A1'), 'A1');
  assert.equal(mot.normalisePlate(''), '');
  assert.equal(mot.normalisePlate('ABCDEFGHIJ'), '');
});

test('findPlates spots current, prefix and suffix plates once each', () => {
  const text = 'Reg AB12 CDE, also ab12cde. Old one P123 ABC and ABC123D. Ring 07700 900123';
  assert.deepEqual(mot.findPlates(text), ['AB12CDE', 'P123ABC', 'ABC123D']);
});

test('findPlates ignores ordinary words and an empty listing', () => {
  assert.deepEqual(mot.findPlates('Lovely car, full service history, two keys'), []);
  assert.deepEqual(mot.findPlates(''), []);
  assert.deepEqual(mot.findPlates(undefined), []);
});

test('parseListingMileage prefers the Facebook "Driven" field', () => {
  assert.deepEqual(mot.parseListingMileage('Was 90,000 miles. Driven 85,000 miles'), { value: 85000, unit: 'MI' });
  assert.deepEqual(mot.parseListingMileage('only 45k miles'), { value: 45000, unit: 'MI' });
  assert.deepEqual(mot.parseListingMileage('Driven 120,000 km'), { value: 120000, unit: 'KM' });
  assert.deepEqual(mot.parseListingMileage('62.5k miles'), { value: 62500, unit: 'MI' });
  assert.equal(mot.parseListingMileage('no mileage here'), null);
});

test('isValidTokenUrl only accepts the Microsoft token endpoint', () => {
  assert.ok(mot.isValidTokenUrl('https://login.microsoftonline.com/a1b2c3d4-0000-1111-2222-333344445555/oauth2/v2.0/token'));
  assert.ok(!mot.isValidTokenUrl('http://login.microsoftonline.com/x/oauth2/v2.0/token'));
  assert.ok(!mot.isValidTokenUrl('https://login.microsoftonline.com.evil.example/x/oauth2/v2.0/token'));
  assert.ok(!mot.isValidTokenUrl('https://evil.example/oauth2/v2.0/token'));
  assert.ok(!mot.isValidTokenUrl(''));
});

test('missingCredentials names each blank field', () => {
  assert.deepEqual(mot.missingCredentials({}), ['token URL', 'client ID', 'client secret', 'API key']);
  assert.deepEqual(mot.missingCredentials({ tokenUrl: 'x', clientId: 'y', clientSecret: ' ', apiKey: 'z' }), ['client secret']);
});

test('tokenRequestBody is a client-credentials form with the DVSA scope', () => {
  const form = new URLSearchParams(mot.tokenRequestBody({ clientId: ' id ', clientSecret: 's&cret' }));
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), 'id');
  assert.equal(form.get('client_secret'), 's&cret');
  assert.equal(form.get('scope'), 'https://tapi.dvsa.gov.uk/.default');
});

test('vehicleUrl builds the registration endpoint and refuses bad plates', () => {
  assert.equal(mot.vehicleUrl('ab12 cde'), 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/AB12CDE');
  assert.throws(() => mot.vehicleUrl('../../x?'), /not a valid registration/);
});

test('errorMessage explains DVSA error codes and falls back on the status', () => {
  assert.match(mot.errorMessage(404, '{"errorCode":"MOTH-NF-01"}'), /No MOT or vehicle record/);
  assert.match(mot.errorMessage(429, '{"errorCode":"MOTH-RL-01"}'), /Daily DVSA allowance/);
  assert.match(mot.errorMessage(429, 'not json'), /Too many lookups/);
  assert.match(mot.errorMessage(403, '{"errorCode":"MOTH-FB-03"}'), /API key/);
  assert.equal(mot.errorMessage(500, '{"errorCode":"MOTH-UN-01","errorMessage":"boom"}'), 'DVSA lookup failed (HTTP 500, MOTH-UN-01): boom');
});

test('a clean history has no warnings and a sensible yearly mileage', () => {
  const summary = mot.summarise(vehicle([
    motTest('2023-05-01', 'PASSED', 30000, { expiry: '2024-05-14' }),
    motTest('2024-05-01', 'PASSED', 38000, { expiry: '2025-05-14' }),
    motTest('2025-05-01', 'PASSED', 46000, { expiry: '2026-05-14' }),
    motTest('2026-05-01', 'PASSED', 54000, { expiry: '2027-05-14' }),
  ]), TODAY, { value: 56000, unit: 'MI' });
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.status.state, 'valid');
  assert.equal(summary.status.expiry, '2027-05-14');
  assert.equal(summary.status.daysLeft, 192);
  assert.equal(summary.perYear, 7998);
  assert.equal(summary.title, 'FORD FOCUS');
  assert.equal(summary.tests[0].completedDate.slice(0, 10), '2026-05-01');
});

test('rollbacks, a lower listing mileage, expiry, recalls, dangerous defects and gaps are all flagged', () => {
  const summary = mot.summarise(vehicle([
    motTest('2021-03-01', 'PASSED', 70000, { expiry: '2022-03-14' }),
    motTest('2023-06-01', 'FAILED', 61000, { defects: [{ type: 'MAJOR', text: 'Brake pipe corroded', dangerous: true }] }),
    motTest('2023-06-02', 'PASSED', 61005, { expiry: '2024-06-14', defects: [{ type: 'ADVISORY', text: 'Tyre worn', dangerous: false }] }),
  ], { hasOutstandingRecall: 'Yes' }), TODAY, { value: 50000, unit: 'MI' });
  assert.equal(summary.status.state, 'expired');
  assert.equal(summary.failures, 1);
  assert.equal(summary.rollbacks.length, 1);
  assert.equal(summary.perYear, null);
  const text = summary.warnings.join('\n');
  assert.match(text, /MOT expired on 14 Jun 2024/);
  assert.match(text, /outstanding safety recall/);
  assert.match(text, /Mileage went down: 70,000 miles then 61,000 miles/);
  assert.match(text, /Listing says 50,000 miles, but the MOT on 2 Jun 2023 read 61,005 miles/);
  assert.match(text, /No MOT between 1 Mar 2021 and 1 Jun 2023/);
  assert.doesNotMatch(text, /dangerous defects/);
});

test('dangerous defects on the latest test are flagged', () => {
  const summary = mot.summarise(vehicle([
    motTest('2026-04-01', 'FAILED', 40000, { defects: [{ type: 'DANGEROUS', text: 'Tyre cord exposed', dangerous: true }] }),
  ]), TODAY);
  assert.deepEqual(mot.defectCounts(summary.tests[0]), { DANGEROUS: 1 });
  assert.match(summary.warnings.join('\n'), /dangerous defects/);
});

test('kilometre readings are converted and unreadable odometers are skipped', () => {
  const summary = mot.summarise(vehicle([
    motTest('2024-01-10', 'PASSED', 100000, { unit: 'KM', expiry: '2025-01-20' }),
    motTest('2025-01-10', 'PASSED', null, { expiry: '2026-01-20' }),
    motTest('2026-01-10', 'PASSED', 70000, { expiry: '2027-01-20' }),
  ]), TODAY);
  assert.deepEqual(summary.readings.map((reading) => reading.miles), [62137, 70000]);
  assert.deepEqual(summary.rollbacks, []);
});

test('a new car shows its first MOT due date', () => {
  const summary = mot.summarise({ registration: 'AB25CDE', make: 'KIA', motTestDueDate: '2028-03-01', hasOutstandingRecall: 'Unknown', motTests: [] }, TODAY);
  assert.equal(summary.status.state, 'first-due');
  assert.equal(summary.perYear, null);
  assert.deepEqual(summary.warnings, []);
});

test('a vehicle with no tests or due date has an unknown status', () => {
  const summary = mot.summarise({ registration: 'X1', motTests: [] }, TODAY);
  assert.equal(summary.status.state, 'unknown');
  assert.equal(summary.title, 'X1');
});

test('yearly mileage only counts readings after the last drop', () => {
  const summary = mot.summarise(vehicle([
    motTest('2021-03-01', 'PASSED', 70000, { expiry: '2022-03-14' }),
    motTest('2023-06-01', 'PASSED', 61000, { expiry: '2024-06-14' }),
    motTest('2026-06-01', 'PASSED', 76000, { expiry: '2027-06-14' }),
  ]), TODAY);
  assert.equal(summary.perYear, 4999);
});

const FULL_CREDENTIALS = {
  tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token', clientId: 'id', clientSecret: 'secret', apiKey: 'key',
};

test('planMotCheck opens gov.uk until every DVSA credential is saved', () => {
  assert.deepEqual(mot.planMotCheck('ab12 cde', {}), { action: 'govuk', plate: 'AB12CDE' });
  assert.deepEqual(mot.planMotCheck('ab12 cde', { ...FULL_CREDENTIALS, apiKey: ' ' }), { action: 'govuk', plate: 'AB12CDE' });
  assert.deepEqual(mot.planMotCheck('not a plate at all', {}), { action: 'govuk', plate: '' });
});

test('planMotCheck looks a plate up with the DVSA once access is saved', () => {
  assert.deepEqual(mot.planMotCheck('ab12 cde', FULL_CREDENTIALS), { action: 'dvsa', plate: 'AB12CDE' });
  assert.deepEqual(mot.planMotCheck('not a plate at all', FULL_CREDENTIALS), { action: 'invalid', plate: '' });
});
