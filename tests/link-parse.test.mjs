import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import {
  assertSafeHttpUrl,
  classifyPlatform,
  createSafeLookup,
  decodeBody,
  extractOfferId,
  isBlockedAddress,
  parse1688Html,
  parseLink,
} from '../server/link-parse.mjs';
import { routes as linkParseRoutes } from '../server/routes/link-parse.mjs';

// 所有解析测试都使用本地假响应，绝不访问网络。

const PRODUCT_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<title>折叠收纳箱 大容量 - 阿里巴巴</title>
<meta property="og:title" content="折叠收纳箱 大容量">
<meta name="description" content="可折叠设计，适合家庭收纳。">
<meta property="product:price:amount" content="39.90">
<meta property="product:price:currency" content="CNY">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "折叠收纳箱 大容量",
  "description": "可折叠设计，适合家庭收纳。",
  "additionalProperty": [
    { "@type": "PropertyValue", "name": "材质", "value": "PP" },
    { "@type": "PropertyValue", "name": "容量", "value": "60L" }
  ],
  "offers": {
    "@type": "AggregateOffer",
    "lowPrice": "35.00",
    "highPrice": "45.00",
    "priceCurrency": "CNY"
  }
}
</script>
</head><body>
<h1>折叠收纳箱 大容量</h1>
<p>￥35.00-45.00</p>
<p>￥39.90</p>
</body></html>`;

const FALLBACK_HTML = `<!doctype html>
<html><head>
<title>简易衣架 - 阿里巴巴</title>
<meta property="og:title" content="简易衣架">
<meta name="description" content="轻便耐用。">
</head><body>
<dl><dt>材质</dt><dd>不锈钢</dd></dl>
<p>￥9.90</p>
</body></html>`;

const FAILED_HTML = `<!doctype html>
<html><head><title>阿里巴巴1688.com - 全球领先的采购批发平台</title></head>
<body>请登录后查看</body></html>`;

function respond(html, { status = 200, contentType = 'text/html; charset=utf-8', headers = {} } = {}) {
  return {
    status,
    headers: { 'content-type': contentType, ...headers },
    body: Buffer.from(html, 'utf8'),
  };
}

function redirect(location, status = 302, headers = {}) {
  return { status, headers: { location, ...headers }, body: Buffer.alloc(0) };
}

function scripted(...responses) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push(url.href);
    const response = responses[calls.length - 1];
    if (!response) throw new Error(`unexpected request: ${url.href}`);
    return typeof response === 'function' ? response(url, options) : response;
  };
  return { transport, calls };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error => {
    assert.ok(error instanceof AppError, `expected AppError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('URL safety: http/https only, standard ports, no credentials', () => {
  const safe = assertSafeHttpUrl('https://detail.1688.com/offer/123456789.html?spm=a.b');
  assert.equal(safe.hostname, 'detail.1688.com');
  assert.equal(assertSafeHttpUrl('http://m.1688.com/offer/1.html').protocol, 'http:');

  const cases = [
    ['ftp://detail.1688.com/offer/1.html', 'INVALID_URL'],
    ['javascript:alert(1)', 'INVALID_URL'],
    ['not a url', 'INVALID_URL'],
    ['https://user:secret@detail.1688.com/offer/1.html', 'UNSAFE_URL'],
    ['https://detail.1688.com:8080/offer/1.html', 'UNSAFE_URL'],
    ['http://127.0.0.1/offer/1.html', 'UNSAFE_URL'],
    ['http://10.0.0.5/offer/1.html', 'UNSAFE_URL'],
    ['http://169.254.169.254/latest/meta-data', 'UNSAFE_URL'],
    ['http://100.100.100.200/latest/meta-data', 'UNSAFE_URL'],
    ['http://[::1]/offer/1.html', 'UNSAFE_URL'],
    ['http://[fe80::1]/offer/1.html', 'UNSAFE_URL'],
    ['http://[::ffff:127.0.0.1]/offer/1.html', 'UNSAFE_URL'],
    ['http://localhost/offer/1.html', 'UNSAFE_URL'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'UNSAFE_URL'],
    ['http://intranet/offer/1.html', 'UNSAFE_URL'],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => assertSafeHttpUrl(value),
      error => error instanceof AppError && error.code === code,
      value,
    );
  }
});

test('blocked address ranges cover private, loopback, link-local, metadata and mapped forms', () => {
  const blocked = [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.100.100.200', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1',
    '192.0.2.10', '192.168.1.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1',
    '2001:db8::1', '2002:7f00:1::', '::ffff:127.0.0.1',
    '::ffff:169.254.169.254', '127.000.000.001', '2130706433', '0x7f000001',
  ];
  for (const address of blocked) assert.equal(isBlockedAddress(address), true, address);

  const allowed = ['8.8.8.8', '47.96.0.1', '172.32.0.1', '100.63.255.255', '2001:4860:4860::8888', '::ffff:8.8.8.8'];
  for (const address of allowed) assert.equal(isBlockedAddress(address), false, address);
});

test('safe lookup pins only public addresses and rejects an all-private resolution', async () => {
  const mixed = createSafeLookup((hostname, options, callback) => callback(null, [
    { address: '203.0.113.9', family: 4 },
    { address: '93.184.216.34', family: 4 },
  ]));
  const all = await new Promise((resolve, reject) => {
    mixed('example.com', { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  });
  assert.deepEqual(all.map(item => item.address), ['93.184.216.34']);

  const single = await new Promise((resolve, reject) => {
    mixed('example.com', { family: 0 }, (error, address, family) => (
      error ? reject(error) : resolve({ address, family })
    ));
  });
  assert.deepEqual(single, { address: '93.184.216.34', family: 4 });

  const internal = createSafeLookup((hostname, options, callback) => callback(null, [
    { address: '169.254.169.254', family: 4 },
    { address: 'fd00::1', family: 6 },
  ]));
  await expectCode(new Promise((resolve, reject) => {
    internal('internal.example', { all: true }, (error, addresses) => (
      error ? reject(error) : resolve(addresses)
    ));
  }), 'UNSAFE_HOST');
});

test('platform boundary: only 1688 is fetched; Taobao/Tmall is never requested', async () => {
  assert.equal(classifyPlatform(new URL('https://detail.1688.com/offer/1.html')), '1688');
  assert.equal(classifyPlatform(new URL('https://m.1688.com/offer/1.html')), '1688');
  assert.equal(classifyPlatform(new URL('https://item.taobao.com/item.htm?id=1')), 'taobao-tmall');
  assert.equal(classifyPlatform(new URL('https://detail.tmall.com/item.htm?id=1')), 'taobao-tmall');
  assert.equal(classifyPlatform(new URL('https://m.tb.cn/h.abc')), 'taobao-tmall');
  assert.equal(classifyPlatform(new URL('https://www.alibaba.com/product/1.html')), null);

  const taobao = scripted();
  await expectCode(
    parseLink('https://item.taobao.com/item.htm?id=1', { transport: taobao.transport }),
    'PLATFORM_NOT_SUPPORTED',
  );
  assert.equal(taobao.calls.length, 0);

  const unsupported = scripted();
  await expectCode(
    parseLink('https://www.alibaba.com/product/1.html', { transport: unsupported.transport }),
    'PLATFORM_NOT_SUPPORTED',
  );
  assert.equal(unsupported.calls.length, 0);
});

test('1688 parse: JSON-LD name, parameters, price candidates and evidence', async () => {
  const { transport, calls } = scripted(respond(PRODUCT_HTML));
  const result = await parseLink('https://detail.1688.com/offer/123456789.html?spm=a', {
    transport,
    now: () => new Date('2026-10-21T08:00:00.000Z'),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.status, 'parsed');
  assert.equal(result.platform, '1688');
  assert.equal(result.source.productId, '123456789');
  assert.equal(result.source.inputUrl, 'https://detail.1688.com/offer/123456789.html?spm=a');
  assert.equal(result.source.fetchedAt, '2026-10-21T08:00:00.000Z');
  assert.equal(result.source.redirects.length, 0);

  assert.equal(result.draft.verification, 'pending');
  assert.equal(result.draft.sourceType, 'link');
  assert.equal(result.draft.sourcePlatform, '1688');
  assert.equal(result.draft.name, '折叠收纳箱 大容量');
  assert.equal(result.draft.description, '可折叠设计，适合家庭收纳。');
  assert.deepEqual(result.draft.parameters, [
    { name: '材质', value: 'PP', unit: null },
    { name: '容量', value: '60', unit: 'L' },
  ]);

  assert.equal(result.draft.prices.length, 2);
  assert.deepEqual(result.draft.prices[0], {
    amount: null, min: 35, max: 45, currency: 'CNY', type: 'sale', condition: null,
  });
  assert.equal(result.draft.prices[1].amount, 39.9);
  assert.equal(result.confidence.overall, 'high');
  assert.equal(result.evidence.name.source, 'json-ld');
  assert.equal(result.evidence.parameters[0].confidence, 'high');
  assert.equal(result.evidence.prices[0].source, 'json-ld');
});

test('1688 parse: title/meta fallback keeps price type pending and reports partial evidence', async () => {
  const { transport } = scripted(respond(FALLBACK_HTML));
  const result = await parseLink('https://detail.1688.com/offer/555.html', { transport });
  assert.equal(result.status, 'parsed');
  assert.equal(result.draft.name, '简易衣架');
  assert.equal(result.draft.originalTitle, '简易衣架');
  assert.equal(result.draft.description, '轻便耐用。');
  assert.deepEqual(result.draft.parameters, [{ name: '材质', value: '不锈钢', unit: null }]);
  assert.equal(result.draft.prices.length, 1);
  assert.equal(result.draft.prices[0].amount, 9.9);
  assert.equal(result.draft.prices[0].currency, 'CNY');
  assert.equal(result.draft.prices[0].type, null);
  assert.equal(result.confidence.name, 'medium');
  assert.equal(result.confidence.price, 'low');
  assert.equal(result.confidence.overall, 'medium');
  assert.ok(result.warnings.some(message => message.includes('价格仅来自页面文本')));
});

test('1688 parse: no product name yields failure and never fabricates a draft', async () => {
  const { transport } = scripted(respond(FAILED_HTML));
  const result = await parseLink('https://detail.1688.com/offer/999.html', { transport });
  assert.equal(result.status, 'failed');
  assert.equal(result.draft, null);
  assert.equal(result.confidence.overall, 'none');
  assert.equal(result.evidence.name, null);
  assert.ok(result.reason.includes('未能识别商品名称'));
  assert.ok(result.warnings.length > 0);
});

test('redirects are re-validated hop by hop and internal targets are never requested', async () => {
  const internal = scripted(redirect('https://127.0.0.1/secret'), respond(PRODUCT_HTML));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: internal.transport }),
    'UNSAFE_URL',
  );
  assert.equal(internal.calls.length, 1);

  const metadata = scripted(redirect('https://169.254.169.254/latest/meta-data'));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: metadata.transport }),
    'UNSAFE_URL',
  );
  assert.equal(metadata.calls.length, 1);

  const taobao = scripted(redirect('https://item.taobao.com/item.htm?id=1'));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: taobao.transport }),
    'PLATFORM_NOT_SUPPORTED',
  );
  assert.equal(taobao.calls.length, 1);

  const foreign = scripted(redirect('https://evil.example/item.html'));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: foreign.transport }),
    'PLATFORM_NOT_SUPPORTED',
  );
  assert.equal(foreign.calls.length, 1);
});

test('relative redirect chain is resolved and recorded', async () => {
  const { transport, calls } = scripted(
    redirect('/offer/222.html'),
    redirect('https://m.1688.com/offer/333.html', 301),
    respond(PRODUCT_HTML),
  );
  const result = await parseLink('https://detail.1688.com/offer/111.html', { transport });
  assert.equal(calls.length, 3);
  assert.equal(result.source.productId, '333');
  assert.equal(result.source.finalUrl, 'https://m.1688.com/offer/333.html');
  assert.equal(result.source.redirects.length, 2);
  assert.equal(result.source.redirects[0].to, 'https://detail.1688.com/offer/222.html');
  assert.equal(result.draft.name, '折叠收纳箱 大容量');
});

test('redirect loops, limit, missing location and https downgrade are rejected', async () => {
  const loop = scripted(redirect('/offer/1.html'));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: loop.transport }),
    'REDIRECT_LOOP',
  );
  assert.equal(loop.calls.length, 1);

  const limited = scripted(redirect('/offer/2.html'), redirect('/offer/3.html'));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', {
      transport: limited.transport, maxRedirects: 1,
    }),
    'REDIRECT_LIMIT',
  );
  assert.equal(limited.calls.length, 2);

  const missing = scripted({ status: 302, headers: {}, body: Buffer.alloc(0) });
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: missing.transport }),
    'REDIRECT_INVALID',
  );

  const downgrade = scripted(redirect('http://detail.1688.com/offer/2.html'));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: downgrade.transport }),
    'UNSAFE_REDIRECT',
  );
  assert.equal(downgrade.calls.length, 1);
});

test('response size, timeout and non-HTML content are limited', async () => {
  const big = scripted(respond('x'.repeat(200)));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: big.transport, maxBytes: 100 }),
    'RESPONSE_TOO_LARGE',
  );

  const slow = scripted(() => new Promise(() => {}));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: slow.transport, timeoutMs: 20 }),
    'FETCH_TIMEOUT',
  );

  const json = scripted(respond('{"ok":true}', { contentType: 'application/json' }));
  await expectCode(
    parseLink('https://detail.1688.com/offer/1.html', { transport: json.transport }),
    'UNSUPPORTED_CONTENT',
  );
});

test('GBK pages are decoded with declared or meta charset', () => {
  const gbk = Buffer.from([0xCA, 0xD5, 0xC4, 0xC9, 0xCF, 0xE4]);
  assert.equal(decodeBody(gbk, 'text/html; charset=gbk'), '收纳箱');
  assert.equal(decodeBody(gbk, 'text/html; charset=gb2312'), '收纳箱');
  const withMeta = Buffer.concat([Buffer.from('<meta charset="gbk">', 'latin1'), gbk]);
  assert.ok(decodeBody(withMeta, 'text/html').includes('收纳箱'));
});

test('price extraction keeps multiple candidates, ranges and currency without collapsing to the lowest', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Product","name":"测试商品","offers":{"@type":"Offer","price":"12.50","priceCurrency":"cny"}}</script>
    </head><body>￥8.80 起 ￥19.90 ￥5.00-10.00</body></html>`;
  const parsed = parse1688Html(html, 'https://detail.1688.com/offer/42.html');
  assert.equal(parsed.name.value, '测试商品');
  assert.equal(parsed.prices.length, 4);
  const amounts = parsed.prices.map(row => row.amount).filter(value => value !== null);
  assert.deepEqual(amounts.sort((a, b) => a - b), [8.8, 12.5, 19.9]);
  const range = parsed.prices.find(row => row.min === 5 && row.max === 10);
  assert.ok(range);
  assert.equal(range.currency, 'CNY');
  assert.equal(range.confidence, 'low');
  assert.equal(parsed.prices.find(row => row.amount === 12.5).currency, 'CNY');
});

test('structured HTML parameters and offer ID extraction', () => {
  const html = `<table><tr><th>型号</th><td>X-100</td></tr></table>
    <dl><dt>重量</dt><dd>1.5kg</dd></dl>`;
  const parsed = parse1688Html(html);
  assert.deepEqual(parsed.parameters.map(row => [row.name, row.value, row.unit]), [
    ['重量', '1.5', 'kg'],
    ['型号', 'X-100', null],
  ]);  assert.equal(extractOfferId('https://detail.1688.com/offer/123456789.html?x=1'), '123456789');
  assert.equal(extractOfferId('https://detail.1688.com/offer/abc.html'), null);
  assert.equal(extractOfferId('not a url'), null);
});

test('route requires operator role and returns the parser result without writing products', async () => {
  const route = linkParseRoutes().find(item => item.pattern.test('/api/link-parse'));
  let received = null;
  let replied = null;
  const linkParser = {
    async parse(url) {
      received = url;
      return { status: 'parsed', draft: { name: '示例' } };
    },
  };
  const body = { url: 'https://detail.1688.com/offer/1.html' };

  await assert.rejects(
    route.handler({
      ctx: { auth: {}, user: { role: 'viewer', active: true, workspaceId: 'ws-1' }, linkParser },
      body,
      res: {},
      reply() {},
    }),
    error => error instanceof AppError && error.code === 'FORBIDDEN',
  );

  await route.handler({
    ctx: { auth: {}, user: { role: 'operator', active: true, workspaceId: 'ws-1' }, linkParser },
    body,
    res: {},
    reply: (res, status, payload) => { replied = { status, payload }; },
  });
  assert.equal(received, body.url);
  assert.equal(replied.status, 200);
  assert.equal(replied.payload.status, 'parsed');

  await assert.rejects(
    route.handler({
      ctx: { linkParser },
      body: { url: '' },
      res: {},
      reply() {},
    }),
    error => error instanceof AppError && error.code === 'INVALID_URL',
  );
  await assert.rejects(
    route.handler({
      ctx: { linkParser },
      body: { url: body.url, apply: true },
      res: {},
      reply() {},
    }),
    error => error instanceof AppError && error.code === 'INVALID_FIELD',
  );
});

test('HTTP route is discovered, checks CSRF and calls the injected parser', async t => {
  let received = null;
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {},
    linkParser: {
      async parse(url) {
        received = url;
        return { status: 'parsed', draft: { name: '示例' }, warnings: [] };
      },
    },
    port: 0,
    root: new URL('../', import.meta.url),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const session = await (await fetch(`${base}/api/session`)).json();
  const url = 'https://detail.1688.com/offer/1.html';
  const rejected = await fetch(`${base}/api/link-parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error.code, 'TOKEN_REQUIRED');

  const response = await fetch(`${base}/api/link-parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ url }),
  });
  assert.equal(response.status, 200);
  assert.equal(received, url);
  assert.equal((await response.json()).status, 'parsed');
});
