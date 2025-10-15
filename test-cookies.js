// Test rápido para verificar cookies
const fs = require('fs');
const path = require('path');

const cookieJsonPath = path.join(process.cwd(), 'cookies.json');
console.log('Ruta cookies:', cookieJsonPath);
console.log('Existe:', fs.existsSync(cookieJsonPath));

if (fs.existsSync(cookieJsonPath)) {
  const cookiesArray = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
  console.log(`Total cookies: ${cookiesArray.length}`);
  
  const ytCookie = cookiesArray
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
    
  console.log('\nPrimeros 200 caracteres de cookies:');
  console.log(ytCookie.substring(0, 200));
  
  console.log('\nCookies importantes:');
  ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO', 'VISITOR_INFO1_LIVE'].forEach(name => {
    const found = cookiesArray.find(c => c.name === name);
    if (found) {
      console.log(`✓ ${name}: ${found.value.substring(0, 30)}...`);
    } else {
      console.log(`✗ ${name}: NO ENCONTRADA`);
    }
  });
}
