// Browser end-to-end checks for the tutorial: logs in through the configured
// IdP (mock or Keycloak) with the Angular SPA and the Next.js BFF, verifies the
// role-based pages and optionally writes the screenshots used by the docs.
//
//   IDP=mock|keycloak   which IdP is deployed (default: mock)
//   BASE_DOMAIN         default 127.0.0.1.nip.io      SCHEME  default http
//   SHOTS_DIR           write PNGs there (default: none)
//   HEADFUL=1           watch the browser
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const IDP = process.env.IDP ?? 'mock';
const SCHEME = process.env.SCHEME ?? 'http';
const DOMAIN = process.env.BASE_DOMAIN ?? '127.0.0.1.nip.io';
const SHOTS = process.env.SHOTS_DIR;
const url = (label, path = '') => `${SCHEME}://${label}.${DOMAIN}${path}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
const shot = async (page, name, fullPage = false) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage }); };
const text = async (page) => (await page.innerText('body')).replace(/\s+/g, ' ');

// Complete the login page of whichever IdP the browser landed on.
async function loginAt(page, user, shotName) {
  await page.waitForLoadState('networkidle');
  const at = page.url();
  if (at.includes('/realms/')) {                           // Keycloak
    if (shotName) await shot(page, shotName, true);
    await page.fill('#username', user);
    await page.fill('#password', user);
    await page.click('#kc-login');
  } else if (at.includes('/authorize')) {                  // mock IdP
    if (shotName) await shot(page, shotName, true);
    await page.click(`button:has-text("Sign in as ${user}")`);
  } else {
    throw new Error(`not on an IdP login page: ${at}`);
  }
  await page.waitForLoadState('networkidle');
}

const browser = await chromium.launch({ headless: !process.env.HEADFUL });
const errors = [];
const newPage = async (ctx) => {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${page.url()} ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${page.url()} ${m.text()}`); });
  return page;
};

// ---- Angular SPA as alice ------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light', ignoreHTTPSErrors: true });
  const page = await newPage(ctx);
  await page.goto(url('angular'), { waitUntil: 'networkidle' });
  check((await text(page)).includes('not signed in'), 'Angular: anonymous home');
  await page.click('button:has-text("Login")');
  await loginAt(page, 'alice', IDP === 'keycloak' ? 'keycloak-login' : 'mock-idp-login');
  await page.waitForURL(url('angular') + '/**');
  await page.waitForTimeout(500);
  const home = await text(page);
  check(home.includes('Alice Admin') && home.includes('admin'), 'Angular: signed in as alice with roles');
  await shot(page, 'angular-home-signed-in');

  await page.goto(url('angular', '/profile'), { waitUntil: 'networkidle' });
  const profile = await text(page);
  check(profile.includes('nonce') && profile.includes('k8sgateway-api'), 'Angular: profile shows ID token claims and access token audience');
  await shot(page, IDP === 'keycloak' ? 'keycloak-angular-profile' : 'angular-profile', true);

  await page.goto(url('angular', '/orders'), { waitUntil: 'networkidle' });
  await page.waitForSelector('text=ord-1');
  check((await text(page)).includes('ord-1'), 'Angular: orders loaded from the REST API with the bearer token');
  await shot(page, 'angular-orders');

  await page.goto(url('angular', '/admin'), { waitUntil: 'networkidle' });
  await page.waitForSelector('text=All orders');
  check((await text(page)).includes('ord-2'), 'Angular: admin page lists all orders (role admin)');

  await page.goto(url('angular', '/graphql'), { waitUntil: 'networkidle' });
  await page.click('button:has-text("me")');
  await page.waitForTimeout(800);
  check((await text(page)).includes('preferredUsername'), 'Angular: GraphQL me query with the bearer token');
  await shot(page, 'angular-graphql');

  await page.goto(url('angular'), { waitUntil: 'networkidle' });
  await page.click('button:has-text("Logout")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  check(page.url().startsWith(url('angular')) && (await text(page)).includes('not signed in'), 'Angular: RP-initiated logout returns to the app signed out');
  await ctx.close();
}

// ---- Next.js BFF as alice ------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light', ignoreHTTPSErrors: true });
  const page = await newPage(ctx);
  await page.goto(url('next'), { waitUntil: 'networkidle' });
  await shot(page, 'nextjs-home');
  const session = await (await ctx.request.get(url('next', '/api/auth/session'))).json();
  check(session.authenticated === false, 'Next.js: /api/auth/session anonymous');
  await page.click('a:has-text("Login"), button:has-text("Login")');
  await loginAt(page, 'alice');
  await page.waitForURL(url('next') + '/**');
  const dash = await text(page);
  check(dash.includes('Alice Admin') && dash.includes('HTTP 200'), 'Next.js: dashboard rendered server-side with /api/me result');
  await shot(page, 'nextjs-dashboard', true);
  const s2 = await (await ctx.request.get(url('next', '/api/auth/session'))).json();
  check(s2.authenticated === true && !JSON.stringify(s2).includes('eyJ'), 'Next.js: session endpoint exposes claims but no tokens');
  const cookies = await ctx.cookies(url('next'));
  const sess = cookies.find((c) => c.name.includes('session'));
  check(!!sess && sess.httpOnly, 'Next.js: session cookie is HttpOnly');

  await page.goto(url('next', '/orders'), { waitUntil: 'networkidle' });
  await page.waitForSelector('text=ord-1');
  check((await text(page)).includes('ord-1'), 'Next.js: orders via /api/bff/orders relay');
  await page.goto(url('next', '/admin'), { waitUntil: 'networkidle' });
  check((await text(page)).includes('HTTP 200'), 'Next.js: admin stats (role admin)');
  await page.goto(url('next', '/profile'), { waitUntil: 'networkidle' });
  check((await text(page)).includes('k8sgateway-api'), 'Next.js: profile decodes the access token server-side');
  await shot(page, 'nextjs-profile', true);
  await page.click('a:has-text("Logout"), button:has-text("Logout")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  const s3 = await (await ctx.request.get(url('next', '/api/auth/session'))).json();
  check(s3.authenticated === false, 'Next.js: logout clears the session');
  await ctx.close();
}

// ---- Next.js as bob: role check -------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light', ignoreHTTPSErrors: true });
  const page = await newPage(ctx);
  await page.goto(url('next', '/admin'), { waitUntil: 'networkidle' });   // proxy.ts redirects to login
  await loginAt(page, 'bob');
  await page.waitForURL(url('next') + '/**');
  const admin = await text(page);
  check(page.url().startsWith(url('next', '/admin')) && /403|forbidden|not allowed/i.test(admin), 'Next.js: bob is denied on /admin (403)');
  await shot(page, 'nextjs-admin-forbidden');
  await ctx.close();
}

// ---- IdP pages for the docs --------------------------------------------------------
if (SHOTS && IDP === 'mock') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  const page = await newPage(ctx);
  await page.goto(url('idp'), { waitUntil: 'networkidle' });
  await shot(page, 'mock-idp-dashboard', true);
  await ctx.close();
}

await browser.close();
// Expected 401/403 responses (e.g. bob on /admin) are logged by the browser as resource errors - not bugs.
const realErrors = errors.filter((e) => !/favicon|status of (401|403)/.test(e));
check(realErrors.length === 0, `no browser console/page errors${realErrors.length ? ': ' + realErrors.join(' | ') : ''}`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
