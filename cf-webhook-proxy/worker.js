// Прокси Telegram → Google Apps Script (обход 302, spec §9).
// Telegram шлёт апдейт сюда; мы сразу отвечаем 200 и пересылаем апдейт в GAS
// (fetch внутри Workers сам проходит редиректы Google).
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
      return new Response('ok');
    }
    ctx.waitUntil(
      fetch(env.GAS_URL + '?secret=' + env.WEBHOOK_SECRET, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await request.text(),
      })
    );
    return new Response('ok');
  },
};
