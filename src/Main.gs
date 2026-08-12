// Точки входа веб-приложения (spec §6). TV-ветка достраивается в T8.
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Прачка360')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}
