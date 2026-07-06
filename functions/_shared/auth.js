/* Google Service Account → Access Token
   Web Crypto API 사용 — npm 패키지 불필요 */

let _tokenCache  = null;
let _tokenExpiry = 0;

function pemToDer(pem) {
    const b64 = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s/g, '');
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function b64url(str) {
    return btoa(str).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlBuf(buf) {
    let str = '';
    new Uint8Array(buf).forEach(b => str += String.fromCharCode(b));
    return b64url(str);
}

export async function getAccessToken(email, privateKeyPem) {
    if (_tokenCache && Date.now() < _tokenExpiry) return _tokenCache;

    const now    = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim  = b64url(JSON.stringify({
        iss:   email,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud:   'https://oauth2.googleapis.com/token',
        exp:   now + 3600,
        iat:   now,
    }));

    const message = `${header}.${claim}`;
    const key = await crypto.subtle.importKey(
        'pkcs8', pemToDer(privateKeyPem),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
    );
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(message));
    const jwt = `${message}.${b64urlBuf(sig)}`;

    const res  = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const { access_token, expires_in } = await res.json();

    _tokenCache  = access_token;
    _tokenExpiry = Date.now() + (expires_in - 120) * 1000;
    return _tokenCache;
}
