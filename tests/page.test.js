const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function jsdomIsInstalled() {
  try {
    require.resolve('jsdom');
    return true;
  } catch {
    return false;
  }
}

const SKIP = jsdomIsInstalled() ? false : 'jsdom is not installed: run `npm install` to run the Marketplace page tests';
const marketplace = SKIP ? null : require('./marketplace-page.js');

const SCRIPT_PATH = path.join(__dirname, '..', 'car-buying-assistant.user.js');
const TOKEN_URL = 'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token';
const DVSA_CREDENTIALS = JSON.stringify({ tokenUrl: TOKEN_URL, clientId: 'test-client', clientSecret: 'test-secret', apiKey: 'test-key' });
const SETTLE_MS = 1500;

const LISTING_A = '<h1>2012 Ford Focus</h1><span>Driven 95,000 miles</span><p>Reg AB12 CDE, lovely car</p>';
const LISTING_B = '<h1>2016 Vauxhall Astra</h1><span>Driven 20,000 miles</span><p>Reg XY16 ZZZ, one owner</p>';
const LISTING_WITH_TWO_PLATES = '<h1>Two cars</h1><p>Either AB12 CDE or XY16 ZZZ</p>';

function open(options) {
  return marketplace.openMarketplace({ scriptPath: SCRIPT_PATH, ...options });
}

function chipPlates(page) {
  return [...page.document.querySelectorAll('#cba-mot-detected button')].map((button) => button.textContent);
}

function clickChip(page, plate) {
  const chip = [...page.document.querySelectorAll('#cba-mot-detected button')].find((button) => button.textContent === plate);
  assert.ok(chip, `no chip for ${plate}; chips are ${JSON.stringify(chipPlates(page))}`);
  chip.click();
}

function motResultText(page) {
  return page.document.getElementById('cba-mot-result').textContent;
}

function vehicleRecord(registration, make, lastMiles) {
  return {
    registration, make, model: 'FOCUS', primaryColour: 'Silver', fuelType: 'Petrol', firstUsedDate: '2016-03-01',
    hasOutstandingRecall: 'No',
    motTests: [{
      completedDate: '2026-05-01T10:00:00.000Z', testResult: 'PASSED', expiryDate: '2027-04-30',
      odometerValue: String(lastMiles), odometerUnit: 'MI', odometerResultType: 'READ', defects: [],
    }],
  };
}

async function answerToken(page) {
  const [tokenRequest] = page.pendingRequests('login.microsoftonline.com');
  assert.ok(tokenRequest, 'expected a token request');
  await page.respond(tokenRequest, 200, { access_token: 'test-token', expires_in: 3600 });
}

function pendingVehicleRequest(page, plate) {
  const [request] = page.pendingRequests(`/registration/${plate}`);
  assert.ok(request, `expected a pending DVSA request for ${plate}`);
  return request;
}

test('plate chips and listing mileage follow the listing when Facebook swaps the content in after the URL changes', { skip: SKIP }, async () => {
  const page = open({ path: '/marketplace/item/111/', mainHtml: LISTING_A, stored: { cba_dvsa_credentials: DVSA_CREDENTIALS } });
  await page.advance(SETTLE_MS);
  assert.deepEqual(chipPlates(page), ['AB12CDE']);

  page.navigate('/marketplace/item/222/');
  await page.advance(SETTLE_MS);
  page.setMain(LISTING_B);
  await page.advance(6000);
  assert.deepEqual(chipPlates(page), ['XY16ZZZ']);

  clickChip(page, 'XY16ZZZ');
  await answerToken(page);
  await page.respond(pendingVehicleRequest(page, 'XY16ZZZ'), 200, vehicleRecord('XY16ZZZ', 'VAUXHALL', 30000));
  assert.match(motResultText(page), /Listing says 20,000 miles/);
  page.close();
});

test('a lookup answered after leaving the listing is not shown on the next listing', { skip: SKIP }, async () => {
  const page = open({ path: '/marketplace/item/111/', mainHtml: LISTING_A, stored: { cba_dvsa_credentials: DVSA_CREDENTIALS } });
  await page.advance(SETTLE_MS);
  clickChip(page, 'AB12CDE');
  await answerToken(page);
  const slowRequest = pendingVehicleRequest(page, 'AB12CDE');

  page.navigate('/marketplace/item/222/', LISTING_B);
  await page.advance(SETTLE_MS);
  await page.respond(slowRequest, 200, vehicleRecord('AB12CDE', 'FORD', 61005));

  assert.doesNotMatch(motResultText(page), /AB12CDE|FORD/);
  page.close();
});

test('a slow answer for an earlier plate never overwrites the answer for the plate asked for last', { skip: SKIP }, async () => {
  const page = open({ path: '/marketplace/item/111/', mainHtml: LISTING_WITH_TWO_PLATES, stored: { cba_dvsa_credentials: DVSA_CREDENTIALS } });
  await page.advance(SETTLE_MS);
  clickChip(page, 'AB12CDE');
  await answerToken(page);
  const slowRequest = pendingVehicleRequest(page, 'AB12CDE');

  clickChip(page, 'XY16ZZZ');
  await page.flush();
  await page.respond(pendingVehicleRequest(page, 'XY16ZZZ'), 200, vehicleRecord('XY16ZZZ', 'FASTCAR', 30000));
  await page.respond(slowRequest, 200, vehicleRecord('AB12CDE', 'SLOWCAR', 61005));
  await page.advance(1800);

  assert.match(motResultText(page), /FASTCAR FOCUS \(XY16ZZZ\)/);
  assert.doesNotMatch(motResultText(page), /SLOWCAR/);
  page.close();
});

const FLAGGED_LISTING = '<h1>Car for sale</h1><span>Car for sale, no test drives, cash only on collection, or offers</span>';
const SEARCH_GRID = '<a href="/marketplace/item/444/"><span>£4,500</span><span>VW Golf</span></a>';

function collapseStyles(page) {
  const main = page.main();
  return { maxHeight: main.style.maxHeight, overflow: main.style.overflow };
}

test('a collapsed listing is restored when leaving it, and Expand works on the next flagged listing', { skip: SKIP }, async () => {
  const page = open({ path: '/marketplace/item/111/', mainHtml: FLAGGED_LISTING });
  await page.advance(SETTLE_MS);
  assert.deepEqual(collapseStyles(page), { maxHeight: '140px', overflow: 'hidden' });

  page.navigate('/marketplace/category/vehicles/', SEARCH_GRID);
  await page.advance(SETTLE_MS);
  assert.deepEqual(collapseStyles(page), { maxHeight: '', overflow: '' });
  assert.equal(page.document.getElementById('cba-flag-banner'), null);

  page.navigate('/marketplace/item/333/', FLAGGED_LISTING);
  await page.advance(SETTLE_MS);
  assert.deepEqual(collapseStyles(page), { maxHeight: '140px', overflow: 'hidden' });
  page.document.getElementById('cba-expand-btn').click();
  assert.deepEqual(collapseStyles(page), { maxHeight: '', overflow: '' });
  page.close();
});

const ORDINARY_ADVERT = '<h1>2015 Ford Focus 1.6 Zetec</h1><span>£4,500</span><div><span>Driven 85,000 miles</span></div>'
  + '<div><span>Lovely car, FSH, 12 months M.O.T, two keys, cambelt done</span></div>';

function noMotAdvert(priceText) {
  return `<h1>2015 Ford Focus</h1><span>${priceText}</span><div><span>Driven 85,000 miles</span></div>`
    + '<div><span>Lovely car with full service history, two keys and a new clutch</span></div>';
}

function bannerText(page) {
  const banner = page.document.getElementById('cba-flag-banner');
  return banner ? banner.textContent : '';
}

test('an ordinary advert with FSH, M.O.T and a Driven field is not collapsed', { skip: SKIP }, async () => {
  const page = open({ path: '/marketplace/item/111/', mainHtml: ORDINARY_ADVERT });
  await page.advance(SETTLE_MS);
  assert.equal(bannerText(page), '');
  assert.deepEqual(collapseStyles(page), { maxHeight: '', overflow: '' });
  page.close();
});

test('UK "ono" and "ovno" next to the price count as no firm price', { skip: SKIP }, async () => {
  for (const priceText of ['£4,500 ono', '£4,500 ovno']) {
    const page = open({ path: '/marketplace/item/111/', mainHtml: noMotAdvert(priceText) });
    await page.advance(SETTLE_MS);
    assert.match(bannerText(page), /No firm price/, priceText);
    assert.match(bannerText(page), /No MOT mentioned/, priceText);
    assert.doesNotMatch(bannerText(page), /No mileage mentioned|No service history mentioned/, priceText);
    page.close();
  }
});

test('a listing expanded by the user stays expanded when its text changes', { skip: SKIP }, async () => {
  const page = open({ path: '/marketplace/item/111/', mainHtml: FLAGGED_LISTING });
  await page.advance(SETTLE_MS);
  page.document.getElementById('cba-expand-btn').click();
  page.setMain(`${FLAGGED_LISTING}<span>Seller replied: still available</span>`);
  await page.advance(SETTLE_MS);
  assert.equal(bannerText(page), '');
  assert.deepEqual(collapseStyles(page), { maxHeight: '', overflow: '' });
  page.close();
});
