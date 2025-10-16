/**
 * Convierte cookies de formato Netscape (cookies.txt) a formato JSON
 * Uso: node convert-cookies-netscape.js [archivo_entrada] [archivo_salida]
 */

const fs = require('fs');
const path = require('path');

// Argumentos de línea de comandos
const inputFile = process.argv[2] || 'cookies.txt';
const outputFile = process.argv[3] || 'cookies.json';

console.log('🍪 Conversor de Cookies de Netscape a JSON\n');
console.log(`📥 Entrada: ${inputFile}`);
console.log(`📤 Salida: ${outputFile}\n`);

// Verificar que existe el archivo de entrada
if (!fs.existsSync(inputFile)) {
  console.error(`❌ Error: No se encontró el archivo ${inputFile}`);
  console.log('\n💡 Cómo obtener cookies.txt:');
  console.log('1. Instala la extensión "Get cookies.txt LOCALLY"');
  console.log('2. Ve a YouTube e inicia sesión');
  console.log('3. Haz clic en la extensión y exporta las cookies');
  console.log('4. Guarda el archivo como cookies.txt en esta carpeta\n');
  process.exit(1);
}

try {
  // Leer archivo de cookies en formato Netscape
  const content = fs.readFileSync(inputFile, 'utf8');
  const lines = content.split('\n');
  
  const cookies = [];
  let validCookies = 0;
  let skippedLines = 0;
  
  for (const line of lines) {
    // Ignorar comentarios y líneas vacías
    if (!line || line.trim() === '' || line.startsWith('#')) {
      skippedLines++;
      continue;
    }
    
    // Formato Netscape: domain flag path secure expiration name value
    const parts = line.split('\t');
    
    if (parts.length >= 7) {
      const domain = parts[0];
      const flag = parts[1];
      const cookiePath = parts[2];
      const secure = parts[3];
      const expiration = parts[4];
      const name = parts[5];
      const value = parts[6].trim();
      
      // Filtrar solo cookies de YouTube
      if (domain.includes('youtube.com') || domain.includes('google.com')) {
        const cookie = {
          domain: domain,
          expirationDate: parseInt(expiration),
          hostOnly: flag.toUpperCase() !== 'TRUE',
          httpOnly: name.startsWith('__Secure') || name.startsWith('__Host'),
          name: name,
          path: cookiePath,
          sameSite: 'unspecified',
          secure: secure.toUpperCase() === 'TRUE',
          session: parseInt(expiration) === 0,
          storeId: '0',
          value: value
        };
        
        cookies.push(cookie);
        validCookies++;
      }
    }
  }
  
  console.log(`📊 Estadísticas:`);
  console.log(`   - Líneas procesadas: ${lines.length}`);
  console.log(`   - Líneas omitidas: ${skippedLines}`);
  console.log(`   - Cookies válidas: ${validCookies}\n`);
  
  if (validCookies === 0) {
    console.error('❌ No se encontraron cookies válidas de YouTube');
    process.exit(1);
  }
  
  // Verificar cookies importantes
  const importantCookies = [
    'SID',
    '__Secure-1PSID',
    '__Secure-3PSID',
    'HSID',
    'SSID',
    'APISID',
    'SAPISID',
    'LOGIN_INFO',
    'VISITOR_INFO1_LIVE'
  ];
  
  console.log('🔍 Verificando cookies importantes:');
  let foundImportant = 0;
  for (const cookieName of importantCookies) {
    const found = cookies.find(c => c.name === cookieName);
    if (found) {
      console.log(`   ✓ ${cookieName}`);
      foundImportant++;
    } else {
      console.log(`   ✗ ${cookieName} - NO ENCONTRADA`);
    }
  }
  console.log(`\n   Total: ${foundImportant}/${importantCookies.length} cookies importantes\n`);
  
  if (foundImportant < 5) {
    console.warn('⚠️  ADVERTENCIA: Faltan cookies importantes.');
    console.warn('   El bot podría no funcionar correctamente.');
    console.warn('   Asegúrate de estar autenticado en YouTube antes de exportar.\n');
  }
  
  // Guardar cookies en formato JSON
  fs.writeFileSync(outputFile, JSON.stringify(cookies, null, 2), 'utf8');
  
  console.log(`✅ Cookies convertidas exitosamente a ${outputFile}`);
  console.log(`📦 Total de cookies: ${cookies.length}\n`);
  
  // Verificar fechas de expiración
  const now = Math.floor(Date.now() / 1000);
  const expiredCookies = cookies.filter(c => c.expirationDate > 0 && c.expirationDate < now);
  
  if (expiredCookies.length > 0) {
    console.warn(`⚠️  ADVERTENCIA: ${expiredCookies.length} cookies han expirado`);
    console.warn('   Necesitas exportar cookies nuevas desde el navegador\n');
  } else {
    console.log('✓ Todas las cookies están vigentes\n');
  }
  
  console.log('🚀 Próximos pasos:');
  console.log('1. Verifica las cookies: node test-cookies.js');
  console.log('2. Reinicia el bot: .\\stop-bot.ps1 ; .\\run-bot-bg.ps1');
  
} catch (error) {
  console.error('❌ Error procesando cookies:', error.message);
  console.error(error.stack);
  process.exit(1);
}
