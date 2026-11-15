import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="c"><input id="i"></div></body>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
const { attachCombobox } = await import('../public/combobox.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const CAT = ['Amoxicillin', 'Amlodipine', 'Aspirin'];

function mount(search) {
  document.body.innerHTML = '<div id="c"><input id="i"></div>';
  const input = document.getElementById('i'); input.focus();
  const picked = [];
  const cb = attachCombobox(input, { search, onSelect: (x) => picked.push(x.name), debounceMs: 20 });
  return { input, cb, picked, list: input.nextSibling };
}
const type = (input, text) => { for (const ch of text) { input.value += ch; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); } };

test('typing never recreates the input, loses characters or focus; search is debounced', async () => {
  let calls = [];
  const { input } = mount(async (q) => { calls.push(q); return CAT.filter((n) => n.toLowerCase().startsWith(q.toLowerCase())).map((name) => ({ name })); });
  const same = input;
  type(input, 'amoxicillin');
  await sleep(80);
  assert.equal(document.getElementById('i'), same);
  assert.equal(input.value, 'amoxicillin');
  assert.equal(document.activeElement, input);
  assert.deepEqual(calls, ['amoxicillin']); // one request, not eleven
});
test('keyboard: ArrowDown/Up move, Enter selects, Escape closes', async () => {
  const { input, list, picked } = mount(async () => CAT.map((name) => ({ name })));
  type(input, 'am'); await sleep(60);
  assert.equal(list.hidden, false);
  assert.equal(list.querySelectorAll('[role=option]').length, 3);
  key(input, 'ArrowDown'); key(input, 'ArrowDown'); key(input, 'ArrowUp');
  assert.equal(list.querySelector('[aria-selected=true]').textContent, 'Amlodipine');
  key(input, 'Enter');
  assert.deepEqual(picked, ['Amlodipine']); assert.equal(input.value, 'Amlodipine'); assert.equal(list.hidden, true);
  type(input, 'x'); await sleep(60); key(input, 'Escape');
  assert.equal(list.hidden, true);
});
test('mouse selection works without stealing focus', async () => {
  const { input, list, picked } = mount(async () => CAT.map((name) => ({ name })));
  type(input, 'as'); await sleep(60);
  const ev = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  list.querySelectorAll('li')[2].dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(picked, ['Aspirin']); assert.equal(document.activeElement, input);
});
test('loading, empty and error states; stale responses are ignored', async () => {
  let r1;
  let m = mount(() => new Promise((res) => { r1 = res; }));
  type(m.input, 'zz'); await sleep(40);
  assert.match(m.list.textContent, /Searching/);
  r1([]); await sleep(10);
  assert.match(m.list.textContent, /Not in catalogue/);
  m = mount(async () => { throw new Error('net'); });
  type(m.input, 'zz'); await sleep(60);
  assert.match(m.list.textContent, /unverified/);
  assert.equal(m.input.value, 'zz'); // free text preserved
  const resolvers = [];
  m = mount((q) => new Promise((res) => resolvers.push([q, res])));
  type(m.input, 'am'); await sleep(40);
  m.input.value = 'ami'; m.input.dispatchEvent(new dom.window.Event('input')); await sleep(40);
  resolvers[0][1]([{ name: 'STALE' }]); resolvers[1][1]([{ name: 'Amiodarone' }]); await sleep(10);
  assert.equal(m.list.textContent, 'Amiodarone');
});
