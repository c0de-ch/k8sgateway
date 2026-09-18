// RS256 signing key: loaded from MOCK_KEY_FILE or generated at start; published as a JWK Set.
import { readFile, writeFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair, importJWK, importPKCS8 } from 'jose';
import { log } from './util.js';

export const ALG = 'RS256';

/**
 * Loads the signing key from `keyFile` (any RSA private key PEM) or generates a 2048-bit key.
 * A generated key is written back to `keyFile` when one is configured, so restarts keep the same
 * `kid` - resource servers cache the JWKS and reject tokens signed by a key they do not know yet.
 */
export async function loadSigningKey(keyFile = '') {
  let privateKey;
  let source = 'generated (ephemeral)';

  if (keyFile) {
    try {
      // createPrivateKey accepts PKCS#1 and PKCS#8; jose needs PKCS#8.
      const pem = createPrivateKey(await readFile(keyFile, 'utf8')).export({ type: 'pkcs8', format: 'pem' });
      privateKey = await importPKCS8(pem, ALG, { extractable: true });
      source = keyFile;
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`cannot load MOCK_KEY_FILE ${keyFile}: ${err.message}`);
    }
  }

  if (!privateKey) {
    ({ privateKey } = await generateKeyPair(ALG, { extractable: true, modulusLength: 2048 }));
    if (keyFile) {
      try {
        await writeFile(keyFile, await exportPKCS8(privateKey), { mode: 0o600 });
        source = `${keyFile} (created)`;
      } catch (err) {
        log('warn', { msg: 'could not persist the signing key, using an ephemeral one', file: keyFile, error: err.message });
      }
    }
  }

  // exportJWK(privateKey) returns the PRIVATE JWK: drop the private members before publishing.
  const { d, p, q, dp, dq, qi, oth, ...publicJwk } = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk); // RFC 7638: stable id derived from the key itself
  const jwk = { ...publicJwk, kid, use: 'sig', alg: ALG };
  return { privateKey, publicKey: await importJWK(jwk, ALG), jwk, kid, source };
}
