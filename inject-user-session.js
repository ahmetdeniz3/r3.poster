const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '.tiktok_session.json');

const userSessionCookies = [
  { name: 'sessionid', value: '23be56bf3bdc2c2d3902233ac4959d70', domain: '.tiktok.com', path: '/', httpOnly: true, secure: true },
  { name: 'sessionid_ss', value: '23be56bf3bdc2c2d3902233ac4959d70', domain: '.tiktok.com', path: '/', httpOnly: true, secure: true },
  { name: 'sid_tt', value: '23be56bf3bdc2c2d3902233ac4959d70', domain: '.tiktok.com', path: '/', httpOnly: true, secure: true },
  { name: 'uid_tt', value: '855318837457', domain: '.tiktok.com', path: '/', secure: true },
  { name: 'living_user_id', value: '855318837457', domain: '.tiktok.com', path: '/', secure: true },
  { name: 's_v_web_id', value: 'verify_mwcncj0q_8ioZ9W0O_Kve8_4JPw_84f3_PHlmJZ7dq2Oc', domain: '.tiktok.com', path: '/', secure: true },
  { name: 'last_login_method', value: 'QRcode', domain: '.tiktok.com', path: '/', secure: true }
];

let existingCookies = [];
try {
  if (fs.existsSync(SESSION_FILE)) {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (Array.isArray(data.cookies)) {
      existingCookies = data.cookies;
    }
  }
} catch (e) {}

// Merge cookies (userSessionCookies take precedence)
const cookieMap = new Map();
existingCookies.forEach(c => {
  if (c && c.name) cookieMap.set(c.name, c);
});
userSessionCookies.forEach(c => {
  cookieMap.set(c.name, c);
});

const mergedCookies = Array.from(cookieMap.values());
const cookieHeader = mergedCookies.map(c => `${c.name}=${c.value}`).join('; ');

const sessionData = {
  cookies: mergedCookies,
  cookieHeader,
  updatedAt: new Date().toISOString()
};

fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2), 'utf8');
console.log('Saved .tiktok_session.json with', mergedCookies.length, 'cookies.');
console.log('sessionid is set:', mergedCookies.some(c => c.name === 'sessionid'));
console.log('cookieHeader preview:', cookieHeader.slice(0, 150) + '...');
