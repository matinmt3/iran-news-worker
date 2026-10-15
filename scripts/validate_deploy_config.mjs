import fs from 'node:fs';

const path = new URL('../wrangler.jsonc', import.meta.url);
const raw = fs.readFileSync(path, 'utf8');
const config = JSON.parse(raw);
const database = config.d1_databases?.find((item) => item.binding === 'DB');
const crons = config.triggers?.crons || [];

if (!database?.database_id || /REPLACE_WITH/i.test(database.database_id)) {
  throw new Error('ابتدا database_id واقعی D1 را در wrangler.jsonc جایگزین کنید.');
}
if (!crons.includes('* * * * *')) {
  throw new Error('برای پردازش مداوم، Cron در wrangler.jsonc باید دقیقاً * * * * * باشد.');
}
if (config.main !== 'worker.js') throw new Error('main در wrangler.jsonc باید worker.js باشد.');

console.log('Deploy configuration is valid.');
