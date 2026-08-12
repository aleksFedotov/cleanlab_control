// Точки входа веб-приложения (spec §6).
// ?tv=1&key=<TV_KEY> → табло цеха; неверный ключ → обычная PIN-форма (spec §5.3, §7.4).
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.tv === '1' && String(p.key) === PropertiesService.getScriptProperties().getProperty('TV_KEY')) {
    return HtmlService.createHtmlOutputFromFile('Tv')
      .setTitle('Прачка360 — табло')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Прачка360')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}
