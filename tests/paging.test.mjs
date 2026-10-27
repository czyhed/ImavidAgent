import test from 'node:test';
import assert from 'node:assert/strict';
import { pageInfo, clampOffset, appendUnique, pageQuery, referencedAssetIds, chunk } from '../web/src/lib/paging.js';
import { pageParams, pageBody, idList } from '../server/creation-paging.mjs';

const url = query => new URL('http://x/api/creation/assets?' + query);
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

test('pageInfo reports page, pages and the shown range', () => {
  assert.deepEqual(pageInfo(45, 0, 20), { page: 1, pages: 3, from: 1, to: 20 });
  assert.deepEqual(pageInfo(45, 40, 20), { page: 3, pages: 3, from: 41, to: 45 });
  assert.deepEqual(pageInfo(0, 0, 20), { page: 1, pages: 1, from: 0, to: 0 });
  assert.equal(pageInfo(45, 999, 20).page, 3);
});

test('clampOffset steps back when the current page became empty', () => {
  assert.equal(clampOffset(40, 40, 20), 20, 'last page emptied after a delete');
  assert.equal(clampOffset(0, 20, 20), 0);
  assert.equal(clampOffset(41, 40, 20), null, 'page still has one row');
  assert.equal(clampOffset(10, 0, 20), null);
});

test('appendUnique keeps order and drops rows already loaded', () => {
  const merged = appendUnique([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
  assert.deepEqual(merged.map(x => x.id), ['a', 'b', 'c']);
});

test('pageQuery skips empty values and appends limit and offset last', () => {
  assert.equal(pageQuery({ q: '', type: 'image', role: undefined }, 30, 60), 'type=image&limit=30&offset=60');
  assert.equal(pageQuery({ q: '杯' }), 'q=%E6%9D%AF');
});

test('referencedAssetIds collects source images and tail frames, ignoring malformed ids', () => {
  const draft = { tasks: [{ sourceAssetId: A, tailFrame: { assetId: B } }, { sourceAssetId: A }, { sourceAssetId: 'x' }, { sourceAssetId: null }] };
  assert.deepEqual(referencedAssetIds(draft).sort(), [A, B]);
  assert.deepEqual(referencedAssetIds(null), []);
});

test('chunk splits id lookups to the server batch size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(chunk(Array.from({ length: 120 }, (_, i) => i)).length, 3);
});

test('server pageParams validates limit and offset and keeps no-limit compatibility', () => {
  assert.deepEqual(pageParams(url('')), { limit: null, offset: 0, q: '' });
  assert.deepEqual(pageParams(url('limit=20&offset=40&q=%20杯%20')), { limit: 20, offset: 40, q: '杯' });
  for (const bad of ['limit=0', 'limit=101', 'limit=x', 'limit=2.5', 'limit=5&offset=-1', 'limit=5&offset=1.5', 'offset=3']) {
    assert.throws(() => pageParams(url(bad)), { code: 'INVALID_PAGINATION', status: 400 }, bad);
  }
  assert.equal(pageParams(url('limit=100')).limit, 100);
  assert.equal(pageParams(url('q=' + 'x'.repeat(300))).q.length, 100);
});

test('server pageBody computes nextOffset', () => {
  assert.deepEqual(pageBody('items', [1, 2], 5, { limit: 2, offset: 0 }), { items: [1, 2], total: 5, nextOffset: 2 });
  assert.equal(pageBody('items', [5], 5, { limit: 2, offset: 4 }).nextOffset, null);
  assert.equal(pageBody('items', [1, 2, 3], 3, { limit: null, offset: 0 }).nextOffset, null);
});

test('server idList keeps valid unique uuids only, capped at 100', () => {
  assert.deepEqual(idList(url('ids=' + [A, A, 'bad', B].join(','))), [A, B]);
  assert.equal(idList(url('')), null);
  assert.deepEqual(idList(url('ids=')), []);
  const many = Array.from({ length: 150 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  assert.equal(idList(url('ids=' + many.join(','))).length, 100);
});
