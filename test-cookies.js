/**
 * Test y validación de cookies de YouTube
 * Verifica que las cookies estén correctamente configuradas y vigentes
 */

const fs = require('fs');
const path = require('path');

console.log('🍪 Test de Cookies de YouTube\n');

const cookieJsonPath = path.join(process.cwd(), 'cookies.json');
console.log('📁 Ruta:', cookieJsonPath);
console.log('📄 Existe:', fs.existsSync(cookieJsonPath) ? '✓' : '✗');

if (!fs.existsSync(cookieJsonPath)) {
  console.error('\n❌ Error: No se encontró cookies.json');
  console.log('\n💡 Para solucionar este problema:');
  console.log('1. Sigue la guía en actualizar-cookies.md');
  console.log('2. Exporta cookies desde YouTube usando la extensión del navegador');
  console.log('3. Convierte las cookies: node convert-cookies-netscape.js\n');
  process.exit(1);
}

try {
  const cookiesArray = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
  console.log(`\n📦 Total cookies: ${cookiesArray.length}`);
  
  // Verificar cookies importantes
  console.log('\n🔍 Cookies importantes:');
  const importantCookies = [
    'SID',
    '__Secure-1PSID',
    '__Secure-3PSID',
    'HSID',
    'SSID',
    'APISID',
    'SAPISID',
    '__Secure-1PAPISID',
    '__Secure-3PAPISID',
    'LOGIN_INFO',
    'VISITOR_INFO1_LIVE',
    'VISITOR_PRIVACY_METADATA'
  ];
  
  let foundCount = 0;
  const missingCookies = [];
  
  for (const name of importantCookies) {
    const found = cookiesArray.find(c => c.name === name);
    if (found) {
      const preview = found.value.substring(0, 30);
      console.log(`   ✓ ${name.padEnd(30)} ${preview}...`);
      foundCount++;
      
      // Verificar expiración
      if (found.expirationDate) {
        const now = Math.floor(Date.now() / 1000);
        if (found.expirationDate < now) {
          console.log(`     ⚠️  EXPIRADA (${new Date(found.expirationDate * 1000).toLocaleDateString()})`);
        }
      }
    } else {
      console.log(`   ✗ ${name.padEnd(30)} NO ENCONTRADA`);
      missingCookies.push(name);
    }
  }
  
  console.log(`\n📊 Resultado: ${foundCount}/${importantCookies.length} cookies encontradas`);
  
  // Verificar fechas de expiración
  const now = Math.floor(Date.now() / 1000);
  const expiredCookies = cookiesArray.filter(c => c.expirationDate > 0 && c.expirationDate < now);
  const validCookies = cookiesArray.filter(c => c.expirationDate === 0 || c.expirationDate > now);
  
  console.log('\n📅 Estado de expiración:');
  console.log(`   ✓ Vigentes: ${validCookies.length}`);
  console.log(`   ✗ Expiradas: ${expiredCookies.length}`);
  
  if (expiredCookies.length > 0) {
    console.log('\n⚠️  ADVERTENCIA: Algunas cookies han expirado');
    console.log('   Cookies expiradas:');
    expiredCookies.slice(0, 5).forEach(c => {
      const expDate = new Date(c.expirationDate * 1000).toLocaleDateString();
      console.log(`   - ${c.name} (expiró el ${expDate})`);
    });
    if (expiredCookies.length > 5) {
      console.log(`   ... y ${expiredCookies.length - 5} más`);
    }
  }
  
  // Convertir a formato header para verificar
  const ytCookie = cookiesArray
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
    
  console.log('\n📏 Tamaño total de cookies:', ytCookie.length, 'caracteres');
  
  // Diagnóstico final
  console.log('\n' + '='.repeat(60));
  if (foundCount >= 8 && expiredCookies.length === 0) {
    console.log('✅ COOKIES VÁLIDAS - El bot debería funcionar correctamente');
  } else if (foundCount >= 5) {
    console.log('⚠️  COOKIES PARCIALES - El bot podría tener problemas');
    if (missingCookies.length > 0) {
      console.log(`   Faltan: ${missingCookies.slice(0, 3).join(', ')}`);
    }
    if (expiredCookies.length > 0) {
      console.log(`   ${expiredCookies.length} cookies expiradas`);
    }
    console.log('\n💡 Recomendación: Exporta cookies nuevas desde el navegador');
  } else {
    console.log('❌ COOKIES INSUFICIENTES - El bot NO funcionará');
    console.log('\n💡 ACCIÓN REQUERIDA:');
    console.log('1. Abre YouTube en tu navegador');
    console.log('2. Inicia sesión con tu cuenta');
    console.log('3. Reproduce un video con restricción de edad');
    console.log('4. Exporta las cookies usando la extensión');
    console.log('5. Ejecuta: node convert-cookies-netscape.js');
  }
  console.log('='.repeat(60) + '\n');
  
  // Mostrar próximos pasos
  if (foundCount < 8 || expiredCookies.length > 0) {
    console.log('📖 Guía completa: cat actualizar-cookies.md');
  }
  
} catch (error) {
  console.error('\n❌ Error leyendo cookies.json:', error.message);
  console.log('\n💡 El archivo podría estar corrupto. Verifica que sea JSON válido.');
  process.exit(1);
}
