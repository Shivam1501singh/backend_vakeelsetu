import app from '../src/server.js';

console.log('--- Express App Route & Middleware Stack Dump ---');

let foundWebhookBeforeJson = false;
let jsonParserIndex = -1;
let webhookRouteIndex = -1;

const routes = [];

app._router.stack.forEach((middleware, idx) => {
  const name = middleware.name || '<anonymous>';
  const handleStr = middleware.handle ? middleware.handle.toString().slice(0, 50) : '';

  // Check express.json
  if (name === 'jsonParser' || handleStr.includes('express.json') || (middleware.handle && middleware.handle.name === 'jsonParser')) {
    jsonParserIndex = idx;
  }

  // Check webhook registration
  const regexStr = middleware.regexp ? middleware.regexp.toString() : '';
  if (regexStr.includes('api\\/payments\\/razorpay\\/webhook') || regexStr.includes('api/payments/razorpay/webhook')) {
    webhookRouteIndex = idx;
    routes.push({
      index: idx,
      type: 'WEBHOOK',
      path: '/api/payments/razorpay/webhook',
      middleware: name
    });
  }

  // Check mounted route handlers
  if (middleware.route) {
    const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
    routes.push({
      index: idx,
      type: 'ROUTE',
      methods,
      path: middleware.route.path
    });
  } else if (middleware.name === 'router') {
    // Router middleware
    const routerStack = middleware.handle.stack;
    const pathPrefix = middleware.regexp ? middleware.regexp.toString() : '';

    routerStack.forEach((r) => {
      if (r.route) {
        const methods = Object.keys(r.route.methods).join(', ').toUpperCase();
        routes.push({
          index: idx,
          type: 'SUB_ROUTE',
          methods,
          prefix: pathPrefix,
          path: r.route.path
        });
      }
    });
  }
});

console.log(`Webhook Route Index: ${webhookRouteIndex}`);
console.log(`JSON Parser Middleware Index: ${jsonParserIndex}`);

if (webhookRouteIndex !== -1 && jsonParserIndex !== -1 && webhookRouteIndex < jsonParserIndex) {
  foundWebhookBeforeJson = true;
  console.log('✅ CONFIRMED: Webhook route is registered BEFORE express.json()!');
} else {
  console.error('❌ WARNING: Webhook route was NOT found before express.json()');
}

console.log('\n--- Selected Payment and Consultancy Routes ---');
routes.forEach((r) => {
  if (
    r.path?.includes('payment') ||
    r.path?.includes('consultancy') ||
    r.path?.includes('cron') ||
    r.type === 'WEBHOOK'
  ) {
    console.log(`[${r.type}] ${r.methods || 'ALL'} ${r.path} (Prefix: ${r.prefix || ''})`);
  }
});

if (!foundWebhookBeforeJson) {
  process.exit(1);
}
