// Server-rendered HTML: login page, dashboard, token debugger and small status pages.
// Self-contained (inline CSS, no external assets, no JavaScript) so it works offline inside kind.
import { FLAVORS } from './flavors.js';
import { esc } from './util.js';

const CSS = `
:root{--bg:#f4f5f7;--card:#fff;--fg:#1c1f26;--muted:#6b7280;--line:#e2e5ea;--accent:#2563eb;--accent-fg:#fff;--err-bg:#fdecec;--err:#b42318;--ok:#067647;--chip:#eef2ff;--code:#0f172a;--code-fg:#e2e8f0}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#e6e8ee;--muted:#9aa3b2;--line:#2a2f3a;--accent:#3b82f6;--err-bg:#3b1a1a;--err:#f87171;--ok:#4ade80;--chip:#1e2536;--code:#0b0e14;--code-fg:#d6dbe5}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.top{display:flex;gap:12px;align-items:center;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
.brand{font-weight:700;text-decoration:none;color:var(--fg);font-size:17px}.spacer{flex:1}.top a{color:var(--muted)}
main{max-width:1040px;margin:0 auto;padding:24px 16px}main.narrow{max-width:520px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin-bottom:20px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:0 0 12px}
.muted{color:var(--muted);font-size:13px}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;background:var(--chip);color:var(--accent)}
.chip{display:inline-block;padding:1px 8px;border-radius:6px;font-size:12px;background:var(--chip);margin:2px 4px 2px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
input[type=text],input[type=password],textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;min-height:130px}
button,.btn{display:inline-block;padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer;text-decoration:none}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);width:100%;margin-top:14px;font-weight:600}
button.user{width:100%;text-align:left;margin-top:8px;display:flex;justify-content:space-between;align-items:center;gap:8px}
button.link{border:none;background:none;color:var(--muted);padding:6px 0;text-decoration:underline;font-size:13px}
.error{background:var(--err-bg);color:var(--err);padding:10px 12px;border-radius:8px;margin:12px 0;font-size:14px}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--err);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}tr.current td{background:var(--chip)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:var(--chip);padding:1px 5px;border-radius:4px;word-break:break-all}
pre{background:var(--code);color:var(--code-fg);padding:14px;border-radius:8px;overflow:auto;font-size:12.5px;line-height:1.45;margin:0}pre code{background:none;padding:0;color:inherit;font-size:inherit;word-break:normal}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
.divider{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:18px 0 6px}.divider:before,.divider:after{content:"";flex:1;border-top:1px solid var(--line)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{color:var(--muted);font-size:13px}dd{margin:0}
footer{text-align:center;padding:20px}
`;

const chips = (values = []) => values.map((v) => `<span class="chip">${esc(v)}</span>`).join('');
const pre = (obj) => `<pre><code>${esc(JSON.stringify(obj, null, 2))}</code></pre>`;

function layout({ config, title, body, narrow = false }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body>
<header class="top"><a class="brand" href="/">Mock IdP</a><span class="badge">${esc(FLAVORS[config.flavor].label)}</span><span class="muted">${esc(config.issuer)}</span><span class="spacer"></span><a href="/debug/token">Token debugger</a></header>
<main${narrow ? ' class="narrow"' : ''}>${body}</main>
<footer class="muted">Development identity provider for the k8sgateway tutorial. Passwords equal usernames. Never run it in production.</footer>
</body></html>`;
}

// Authorization request parameters that travel through the login form as hidden fields.
const HIDDEN = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'response_mode', 'max_age'];

export function loginPage({ config, client, params, users, error, loginHint }) {
  const hidden = HIDDEN.filter((k) => params[k] !== undefined)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('');
  const scopes = chips(String(params.scope ?? '').split(/\s+/).filter(Boolean)) || '<em class="muted">none</em>';
  const demo = users.map((u) => `<button class="user" type="submit" name="user" value="${esc(u.username)}" formnovalidate>
      <span>Sign in as <strong>${esc(u.username)}</strong> <span class="muted">${esc(u.name)}</span></span>
      <span>${chips(u.roles) || '<span class="muted">no roles</span>'}</span></button>`).join('');
  const body = `<div class="card">
  <h1>Sign in</h1>
  <p class="muted">to continue to <strong>${esc(client.name)}</strong> <code>${esc(client.client_id)}</code></p>
  <p class="muted">Requested scopes: ${scopes}</p>
  ${error ? `<div class="error">${esc(error)}</div>` : ''}
  <form method="post" action="/authorize">${hidden}
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus value="${esc(loginHint ?? '')}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    <button class="primary" type="submit">Sign in</button>
    <div class="divider">or use a demo account (one click, no password)</div>
    ${demo}
    <p style="text-align:center;margin:12px 0 0"><button class="link" type="submit" name="cancel" value="1" formnovalidate>Cancel and return to the application</button></p>
  </form></div>`;
  return layout({ config, title: 'Sign in - Mock IdP', body, narrow: true });
}

export function dashboardPage({ config, users, clients, key, session, stats }) {
  const I = config.issuer;
  const flavor = FLAVORS[config.flavor];
  const userRows = users.map((u) => `<tr><td><code>${esc(u.username)}</code></td><td><code>${esc(u.password)}</code></td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${chips(u.roles) || '<span class="muted">none</span>'}</td><td class="muted">${esc(u.sub)}</td></tr>`).join('');
  const clientRows = clients.map((c) => `<tr><td><code>${esc(c.client_id)}</code><div class="muted">${esc(c.name)}</div></td>
    <td>${c.client_secret ? `confidential<div class="muted">secret <code>${esc(c.client_secret)}</code></div>` : 'public'}</td>
    <td>${chips(c.grant_types)}</td>
    <td>${c.redirect_uris.map((r) => `<div><code>${esc(r)}</code></div>`).join('') || '<span class="muted">-</span>'}</td>
    <td>${chips(c.roles) || '<span class="muted">-</span>'}</td></tr>`).join('');
  const endpointRows = [
    ['Discovery', 'GET', '/.well-known/openid-configuration'], ['JWKS', 'GET', '/jwks'], ['Authorize', 'GET, POST', '/authorize'],
    ['Token', 'POST', '/token'], ['Userinfo', 'GET, POST', '/userinfo'], ['Introspect', 'POST', '/introspect'], ['Revoke', 'POST', '/revoke'],
    ['End session', 'GET, POST', '/logout'], ['Token debugger', 'GET, POST', '/debug/token'], ['Liveness', 'GET', '/healthz'], ['Readiness', 'GET', '/readyz'],
  ].map(([name, methods, path]) => `<tr><td>${name}</td><td class="muted">${methods}</td><td><a href="${esc(I + path)}"><code>${esc(I + path)}</code></a></td></tr>`).join('');
  const flavorRows = Object.entries(FLAVORS).map(([name, f]) => `<tr${name === config.flavor ? ' class="current"' : ''}>
    <td><code>${name}</code>${name === config.flavor ? ' <span class="badge">active</span>' : ''}</td><td>${esc(f.label)}</td><td><code>${esc(f.rolesClaim)}</code></td><td class="muted">${esc(f.summary)}</td></tr>`).join('');
  const envRows = [
    ['MOCK_ISSUER', config.issuer], ['MOCK_ISSUER_CLAIM', config.issuerClaim], ['MOCK_FLAVOR', config.flavor], ['MOCK_AUDIENCE', config.audience],
    ['MOCK_ACCESS_TOKEN_TTL', config.ttl.access], ['MOCK_ID_TOKEN_TTL', config.ttl.id], ['MOCK_REFRESH_TOKEN_TTL', config.ttl.refresh],
    ['MOCK_ALLOW_ANY_REDIRECT', config.allowAnyRedirect], ['MOCK_KEY_FILE', config.keyFile || '(unset: ephemeral key)'],
    ['MOCK_USERS_FILE', config.usersFile], ['MOCK_CLIENTS_FILE', config.clientsFile], ['signing key', `kid ${key.kid} (${key.source})`],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd><code>${esc(v)}</code></dd>`).join('');
  const sessionHtml = session
    ? `Signed in as <strong>${esc(session.username)}</strong> since ${new Date(session.auth_time * 1000).toISOString()} (sid <code>${esc(session.sid)}</code>). Applications that redirect here now get a code without a login page. <a class="btn" href="/logout">Sign out</a>`
    : 'No SSO session in this browser. Start a login from one of the applications; the session cookie is set once you sign in.';
  const curl = `# 1. Discovery and signing keys
curl -s ${I}/.well-known/openid-configuration | jq .
curl -s ${I}/jwks | jq .

# 2. Password grant (scripts and CI only). alice has the roles admin + user.
#    A refresh token is always included; offline_access is accepted but not required
#    (Entra ID needs it, Keycloak must not get it, the mock does not care).
TOKEN=$(curl -s -X POST ${I}/token \\
  -d grant_type=password -d client_id=cli -d username=alice -d password=alice \\
  -d 'scope=openid profile email' | tee /tmp/tokens.json | jq -r .access_token)
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq .

# 3. Client credentials (service to service): roles come from clients.json
curl -s -X POST ${I}/token -u svc-batch:svc-batch-secret -d grant_type=client_credentials | jq .

# 4. Refresh (rotating: the previous refresh token stops working)
curl -s -X POST ${I}/token -d grant_type=refresh_token -d client_id=cli \\
  -d refresh_token=$(jq -r .refresh_token /tmp/tokens.json) | jq .

# 5. Userinfo and introspection
curl -s ${I}/userinfo -H "Authorization: Bearer $TOKEN" | jq .
curl -s -X POST ${I}/introspect -d client_id=cli -d token=$TOKEN | jq .

# 6. Call a protected API through the gateway with the token
curl -s http://api.127.0.0.1.nip.io/api/me -H "Authorization: Bearer $TOKEN" | jq .`;

  const body = `<div class="card"><h1>Mock IdP dashboard</h1>
  <p class="muted">Issuer <code>${esc(I)}</code> &middot; flavor <code>${esc(config.flavor)}</code> (${esc(flavor.label)}) &middot; roles claim for applications: <code>ROLES_CLAIM=${esc(flavor.rolesClaim)}</code> &middot; audience <code>${esc(config.audience)}</code></p>
  <p>${sessionHtml}</p>
  <p class="muted">In memory right now: ${stats.codes} authorization code(s), ${stats.refreshTokens} refresh token(s), ${stats.sessions} SSO session(s).</p></div>

  <div class="card"><h2>Users <span class="muted">(password = username)</span></h2>
  <table><tr><th>username</th><th>password</th><th>name</th><th>email</th><th>roles</th><th>sub</th></tr>${userRows}</table></div>

  <div class="card"><h2>Clients</h2>
  <table><tr><th>client_id</th><th>type</th><th>grants</th><th>redirect URIs</th><th>roles (client_credentials)</th></tr>${clientRows}</table>
  <p class="muted">Secrets are demo values from clients.json. ${config.allowAnyRedirect ? 'MOCK_ALLOW_ANY_REDIRECT=true: any http(s) redirect_uri is accepted during development.' : 'Only the registered redirect URIs are accepted (trailing * is a prefix wildcard).'}</p></div>

  <div class="card"><h2>Endpoints</h2><table>${endpointRows}</table></div>

  <div class="card"><h2>Try it with curl</h2><pre><code>${esc(curl)}</code></pre></div>

  <div class="card"><h2>Flavors <span class="muted">(MOCK_FLAVOR)</span></h2>
  <table><tr><th>flavor</th><th>imitates</th><th>roles claim</th><th>access token shape</th></tr>${flavorRows}</table>
  <p class="muted">The ID token has the same shape in every flavor. Switch the flavor and restart to see how the same application copes with a different real-world token layout.</p></div>

  <div class="card"><h2>Configuration</h2><dl>${envRows}</dl></div>`;
  return layout({ config, title: 'Mock IdP dashboard', body });
}

export function debugTokenPage({ config, key, token = '', result }) {
  let outcome = '';
  if (result?.parseError) {
    outcome = `<div class="card"><div class="error">${esc(result.parseError)}</div></div>`;
  } else if (result) {
    const rows = result.checks.map((c) => `<tr><td>${esc(c.name)}</td><td class="${c.ok ? 'ok' : 'bad'}">${c.ok ? 'OK' : 'FAIL'}</td><td class="muted">${esc(c.detail)}</td></tr>`).join('');
    const times = ['iat', 'nbf', 'exp', 'auth_time'].filter((k) => typeof result.payload[k] === 'number')
      .map((k) => `<dt>${k}</dt><dd>${new Date(result.payload[k] * 1000).toISOString()}</dd>`).join('');
    outcome = `<div class="card"><h2>${result.valid ? '<span class="ok">Token is valid</span>' : '<span class="bad">Token is NOT valid</span>'} <span class="muted">for this issuer and key</span></h2>
    <table>${rows}</table>${times ? `<dl style="margin-top:14px">${times}</dl>` : ''}</div>
    <div class="grid"><div class="card"><h2>Header</h2>${pre(result.header)}</div><div class="card"><h2>Payload</h2>${pre(result.payload)}</div></div>`;
  }
  const body = `<div class="card"><h1>Token debugger</h1>
  <p class="muted">Paste any JWT (access or ID token). The signature is checked against this server's current key (kid <code>${esc(key.kid)}</code>); nothing is stored or logged.</p>
  <form method="post" action="/debug/token"><textarea name="token" placeholder="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ii4uLiJ9...">${esc(token)}</textarea>
  <button class="primary" type="submit" style="width:auto">Decode and validate</button></form></div>${outcome}`;
  return layout({ config, title: 'Token debugger - Mock IdP', body });
}

export function loggedOutPage({ config, rejectedRedirect }) {
  const body = `<div class="card"><h1>Signed out</h1><p>Your SSO session at the Mock IdP has ended and its refresh tokens were revoked.</p>
  ${rejectedRedirect ? `<div class="error">post_logout_redirect_uri <code>${esc(rejectedRedirect)}</code> is not registered for this client, so no redirect was performed.</div>` : ''}
  <p><a class="btn" href="/">Back to the dashboard</a></p></div>`;
  return layout({ config, title: 'Signed out - Mock IdP', body, narrow: true });
}

export function errorPage({ config, title, message }) {
  const body = `<div class="card"><h1>${esc(title)}</h1><div class="error">${esc(message)}</div>
  <p class="muted">The browser was not redirected back because the client or its redirect URI could not be trusted (RFC 6749 3.1.2.4). Check clients.json.</p></div>`;
  return layout({ config, title: `${title} - Mock IdP`, body, narrow: true });
}
