// Загрузчик .gs-файлов для Node-тестов: выполняет файл в vm-песочнице
// с подставленными моками GAS-сервисов и возвращает контекст с функциями файла.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

function loadGs(fileName, sandbox = {}) {
  const code = fs.readFileSync(path.join(SRC_DIR, fileName), 'utf8');
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: fileName });
  return context;
}

module.exports = { loadGs };
