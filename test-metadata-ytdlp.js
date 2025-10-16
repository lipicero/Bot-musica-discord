/**
 * Test de metadata con yt-dlp
 * Verifica que se obtenga correctamente el título y duración
 */

require('dotenv').config();
const { getVideoInfoWithYtDlp } = require('./src/utils/yt-dlp');

const testUrl = process.argv[2] || 'https://www.youtube.com/watch?v=njci7yREmf8';

console.log('🎬 TEST DE METADATA CON YT-DLP\n');
console.log('='.repeat(70));
console.log(`URL: ${testUrl}\n`);

(async () => {
  try {
    console.log('Obteniendo información del video...');
    const info = await getVideoInfoWithYtDlp(testUrl);
    
    if (!info) {
      console.log('❌ No se pudo obtener información del video');
      process.exit(1);
    }
    
    console.log('\n✅ INFORMACIÓN OBTENIDA:\n');
    console.log(`📌 Título:     ${info.title}`);
    console.log(`👤 Canal:      ${info.author}`);
    console.log(`⏱️  Duración:   ${info.duration}s (${Math.floor(info.duration / 60)}:${(info.duration % 60).toString().padStart(2, '0')})`);
    console.log(`🔴 En vivo:    ${info.isLive ? 'Sí' : 'No'}`);
    console.log(`👁️  Vistas:     ${info.viewCount ? info.viewCount.toLocaleString() : 'N/A'}`);
    console.log(`🆔 Video ID:   ${info.videoId}`);
    console.log(`🎵 Audio:      ${info.acodec || 'N/A'} @ ${info.abr || 'N/A'}kbps`);
    console.log(`🖼️  Thumbnail:  ${info.thumbnail ? 'Sí' : 'No'}`);
    
    if (info.thumbnail) {
      console.log(`   ${info.thumbnail.substring(0, 60)}...`);
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('✅ TEST COMPLETADO EXITOSAMENTE\n');
    console.log('Esta información debería aparecer en el panel de reproducción.');
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
