/**
 * Accessible autocomplete for the medicine field.
 * Guarantees: the <input> is never recreated and its value is only written when the user
 * picks an option; searches are debounced and stale responses are ignored.
 */
export function attachCombobox(input, { search, onSelect, debounceMs = 250, minChars = 2 }) {
  const list = document.createElement('ul');
  list.className = 'cb-list'; list.hidden = true; list.setAttribute('role', 'listbox');
  list.id = 'cb-' + Math.random().toString(36).slice(2);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id); input.setAttribute('aria-autocomplete', 'list'); input.autocomplete = 'off';
  input.parentNode.style.position = 'relative';
  input.after(list);
  let items = [], active = -1, timer, seq = 0, state = 'idle';

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const open = () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  function render() {
    list.replaceChildren();
    const msg = (t) => { const li = document.createElement('li'); li.className = 'msg'; li.textContent = t; li.setAttribute('role', 'presentation'); list.append(li); };
    if (state === 'loading') msg('Searching…');
    else if (state === 'error') msg('Search failed. You can still type the name; it will be marked unverified.');
    else if (state === 'empty') msg('Not in catalogue. It will be saved as unverified.');
    else items.forEach((it, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`; li.dataset.i = i; li.textContent = it.name; li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active)); list.append(li);
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    open();
  }
  async function run(q) {
    const mine = ++seq; state = 'loading'; items = []; active = -1; render();
    try { const r = await search(q); if (mine !== seq) return; items = r; state = r.length ? 'ok' : 'empty'; }
    catch { if (mine !== seq) return; state = 'error'; }
    active = items.length ? 0 : -1; render();
  }
  function pick(i) {
    const it = items[i]; if (!it) return;
    seq++; input.value = it.name; close(); onSelect(it);
  }
  const onInput = () => {
    clearTimeout(timer); seq++;
    const q = input.value.trim();
    if (q.length < minChars) { state = 'idle'; items = []; close(); return; }
    timer = setTimeout(() => run(q), debounceMs);
  };
  const onKey = (e) => {
    if (list.hidden || !items.length) { if (e.key === 'Escape') close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  const onDown = (e) => { const li = e.target.closest('li[data-i]'); if (!li) return; e.preventDefault(); pick(Number(li.dataset.i)); }; // preventDefault keeps focus in the input
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', () => { setTimeout(close, 120); });
  list.addEventListener('mousedown', onDown);
  return { close, get state() { return state; }, destroy() { clearTimeout(timer); input.removeEventListener('input', onInput); input.removeEventListener('keydown', onKey); list.remove(); } };
}
