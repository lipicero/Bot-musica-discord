/**
 * Script de prueba para verificar la conversión de cookies
 * Crea un archivo cookies.txt de ejemplo y lo convierte
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 Test de Conversión de Cookies\n');

// Crear archivo cookies.txt de prueba
const testCookiesNetscape = `# Netscape HTTP Cookie File
# This is a generated file. Do not edit.

.youtube.com	TRUE	/	TRUE	1795137704	SID	g.a0002gg7tZZ5iosWqlrCvs
.youtube.com	TRUE	/	TRUE	1795137704	__Secure-1PSID	g.a0002gg7tZZ5iosWqlrCvs-secure
.youtube.com	TRUE	/	FALSE	1795137704	VISITOR_INFO1_LIVE	abcdef123456
.google.com	TRUE	/	TRUE	1795137704	HSID	AD2jlBWJ6ykRVmvEv
.google.com	TRUE	/	TRUE	1795137704	SSID	AuR7XD4wWBuU32SJ1
.google.com	TRUE	/	TRUE	1795137704	APISID	puAXr3ghkIs2tAaN
.google.com	TRUE	/	TRUE	1795137704	SAPISID	zwloVhqGeF_qNeVP
.google.com	TRUE	/	TRUE	1795137704	__Secure-1PAPISID	zwloVhqGeF_qNeVP-secure
.google.com	TRUE	/	TRUE	1795137704	__Secure-3PAPISID	zwloVhqGeF_qNeVP-secure3
`;

const testFile = 'test-cookies.txt';
const testOutput = 'test-cookies.json';

// Escribir archivo de prueba
fs.writeFileSync(testFile, testCookiesNetscape, 'utf8');
console.log(`✓ Archivo de prueba creado: ${testFile}`);

// Ejecutar conversión
console.log('\n📦 Ejecutando conversión...\n');
const { execSync } = require('child_process');

try {
  const output = execSync(`node convert-cookies-netscape.js ${testFile} ${testOutput}`, { encoding: 'utf8' });
  console.log(output);
  
  // Verificar resultado
  if (fs.existsSync(testOutput)) {
    const result = JSON.parse(fs.readFileSync(testOutput, 'utf8'));
    console.log('\n✅ Conversión exitosa!');
    console.log(`📊 Cookies convertidas: ${result.length}`);
    
    // Verificar estructura
    console.log('\n🔍 Verificando estructura de cookies:');
    const firstCookie = result[0];
    const requiredFields = ['domain', 'expirationDate', 'hostOnly', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'session', 'storeId', 'value'];
    
    let allFieldsPresent = true;
    for (const field of requiredFields) {
      if (field in firstCookie) {
        console.log(`   ✓ ${field}: ${typeof firstCookie[field]}`);
      } else {
        console.log(`   ✗ ${field}: FALTA`);
        allFieldsPresent = false;
      }
    }
    
    if (allFieldsPresent) {
      console.log('\n✅ Todos los campos requeridos están presentes');
    } else {
      console.log('\n❌ Faltan campos en la estructura');
    }
    
    // Verificar cookies httpOnly
    console.log('\n🔒 Verificando atributos httpOnly:');
    const httpOnlyCookies = result.filter(c => c.httpOnly);
    console.log(`   Cookies con httpOnly=true: ${httpOnlyCookies.length}`);
    httpOnlyCookies.forEach(c => {
      console.log(`   - ${c.name}: httpOnly=${c.httpOnly}`);
    });
    
    // Limpiar archivos de prueba
    fs.unlinkSync(testFile);
    fs.unlinkSync(testOutput);
    console.log('\n🧹 Archivos de prueba eliminados');
    console.log('\n✅ ¡Test completado con éxito!');
    
  } else {
    console.error('❌ No se generó el archivo de salida');
    process.exit(1);
  }
  
} catch (error) {
  console.error('❌ Error durante la conversión:', error.message);
  // Limpiar en caso de error
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  if (fs.existsSync(testOutput)) fs.unlinkSync(testOutput);
  process.exit(1);
}
