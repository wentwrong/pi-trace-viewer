<script>
  import { onMount, tick } from 'svelte';
  import { parseTrace } from './parse.mjs';

  const SAMPLE = `{"type":"session","version":3,"id":"demo-trace","timestamp":"2026-10-10T10:00:00.000Z","cwd":"/workspace/demo"}
{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-10-10T10:00:00.100Z","provider":"openrouter","modelId":"qwen/qwen3.8-27b"}
{"type":"message","id":"u1","parentId":"m1","timestamp":"2026-10-10T10:00:01.000Z","message":{"role":"user","content":"Find the main reliability risk in this service and suggest a focused fix.","timestamp":1781049601000}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-10-10T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"I should inspect the health check and retry behavior before proposing a change."},{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"src/health.js"}}],"provider":"openrouter","model":"qwen/qwen3.8-27b","usage":{"input":1200,"output":180,"totalTokens":1380,"cost":{"total":0.0021}},"stopReason":"toolUse","timestamp":1781049602000}}
{"type":"message","id":"t1","parentId":"a1","timestamp":"2026-10-10T10:00:02.200Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"export async function health() { return fetch('/health'); }"}],"isError":false,"timestamp":1781049602200}}
{"type":"message","id":"a2","parentId":"t1","timestamp":"2026-10-10T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"The health check has no timeout, so a stalled upstream can consume a worker indefinitely. Add an AbortController deadline and test the timeout path."}],"provider":"openrouter","model":"qwen/qwen3.8-27b","usage":{"input":1500,"output":95,"totalTokens":1595,"cost":{"total":0.0028}},"stopReason":"stop","timestamp":1781049603000}}
{"type":"label","id":"l1","parentId":"a2","targetId":"a2","label":"reliability-fix","timestamp":"2026-10-10T10:00:03.100Z"}`;

  const TYPES = ['all', 'message', 'tool results', 'settings', 'compaction', 'other'];
  const ROW = 76, OVERSCAN = 8;
  const REFS = [['parent', 'parentId'], ['target', 'targetId'], ['from', 'fromId'], ['first kept', 'firstKeptEntryId']];
  let header = null, entries = [], selected = null, rawOpen = false;
  let query = '', typeFilter = 'all', notice = '', fileName = '', copyState = '';
  let scrollTop = 0, viewportHeight = 600, listEl, detailEl, raf;
  let searchCache = new WeakMap(), loadToken = 0;

  $: index = buildIndex(entries);
  $: digits = Math.max(3, String(entries.length).length);
  $: q = query.trim().toLowerCase();
  $: filtered = entries.filter((e) => (typeFilter === 'all' || kindOf(e) === typeFilter) && (!q || searchTextOf(e).includes(q)));
  $: start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  $: end = Math.min(filtered.length, Math.ceil((scrollTop + viewportHeight) / ROW) + OVERSCAN);
  $: visible = filtered.slice(start, end);
  $: if (!filtered.includes(selected)) selected = filtered[0] || null;
  $: selectedIndex = selected ? filtered.indexOf(selected) : -1;
  $: if (detailEl) selected, detailEl.scrollTop = 0;
  $: stats = getStats(entries);
  $: title = entries.length ? entries.findLast((e) => e.type === 'session_info' && typeof e.name === 'string' && e.name)?.name || fileName : '';
  $: query, typeFilter, tick().then(() => reveal('center'));

  onMount(() => {
    const onKey = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('input, textarea, select, summary')) return;
      if (event.key === '/') { event.preventDefault(); document.querySelector('#search')?.focus(); }
      if (event.key === 'j') selectAt(selectedIndex + 1);
      if (event.key === 'k') selectAt(selectedIndex - 1);
      if (event.key === 'Enter') reveal('center');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Lookup tables: entries by id (first wins), labels by target, tool calls <-> results.
  function buildIndex(list) {
    const byId = new Map(), labels = new Map(), callOwner = new Map(), resultFor = new Map(), position = new Map();
    for (const [i, e] of list.entries()) {
      position.set(e, i + 1);
      if (typeof e.id === 'string' && !byId.has(e.id)) byId.set(e.id, e);
      if (e.type === 'label' && typeof e.targetId === 'string') e.label ? labels.set(e.targetId, String(e.label)) : labels.delete(e.targetId);
      const m = e.type === 'message' ? e.message : null;
      if (m?.role === 'toolResult' && typeof m.toolCallId === 'string') resultFor.set(m.toolCallId, e);
      if (Array.isArray(m?.content)) for (const b of m.content) if (b?.type === 'toolCall' && typeof b.id === 'string') callOwner.set(b.id, e);
    }
    return { byId, labels, callOwner, resultFor, position };
  }
  // Search covers human-readable values only: no keys, image data, or opaque signatures. Built lazily, once per entry.
  function valuesOf(v) {
    if (!v || typeof v !== 'object') return String(v ?? '');
    if (v.type === 'image') return '';
    return Object.entries(v).filter(([k]) => !k.endsWith('Signature')).map(([, x]) => valuesOf(x)).join('\n');
  }
  function searchTextOf(e) {
    let text = searchCache.get(e);
    if (text === undefined) { try { text = valuesOf(e).toLowerCase(); } catch { text = ''; } searchCache.set(e, text); }
    return text;
  }
  function isError(e) {
    const m = e.type === 'message' ? e.message : null;
    return !!m && (m.isError === true || m.stopReason === 'error' || (m.role === 'bashExecution' && typeof m.exitCode === 'number' && m.exitCode !== 0));
  }
  function kindOf(e) {
    if (e.type === 'message') return e.message?.role === 'toolResult' ? 'tool results' : 'message';
    if (['model_change', 'thinking_level_change'].includes(e.type)) return 'settings';
    if (e.type === 'compaction' || e.type === 'branch_summary') return 'compaction';
    return 'other';
  }
  function labelOf(e) {
    const suffix = isError(e) ? ' · error' : '';
    if (e.type === 'message') {
      const m = e.message || {};
      if (m.role === 'toolResult') return `tool · ${m.toolName || 'result'}${suffix}`;
      if (m.role === 'bashExecution') return `bash${suffix}`;
      if (m.role === 'custom' && m.customType) return `custom · ${m.customType}`;
      return `${m.role || 'message'}${suffix}`;
    }
    if (e.type === 'model_change') return 'model';
    if (e.type === 'thinking_level_change') return 'thinking';
    if (e.type === 'branch_summary') return 'branch summary';
    if (e.type === 'custom_message' || e.type === 'custom') return `${e.type.replace('_', ' ')} · ${e.customType || ''}`;
    return String(e.type || 'unknown').replaceAll('_', ' ');
  }
  function messageText(m) {
    if (m.role === 'bashExecution') return `$ ${m.command ?? ''}\n${m.output ?? ''}`;
    return textOf(m.content) || m.errorMessage || m.summary || (m.sections && typeof m.sections === 'object' ? `sections: ${Object.keys(m.sections).join(', ')}` : '');
  }
  function previewOf(e) {
    if (e.type === 'message') {
      const m = e.message || {}, text = String(messageText(m)).slice(0, 150);
      if (m.role === 'toolResult') return text || '(empty tool result)';
      return text || (Array.isArray(m.content) && m.content.length ? '(tool call / reasoning)' : '(empty)');
    }
    if (e.type === 'model_change') return `${e.provider || 'unknown'} / ${e.modelId || 'unknown'}`;
    if (e.type === 'thinking_level_change') return e.thinkingLevel || '';
    if (e.type === 'label') return `→ ${e.targetId}: ${e.label || '(cleared)'}`;
    if (e.type === 'context_edit') return `→ ${e.targetId}: ${e.replacement == null ? 'omitted from context' : 'content replaced'}`;
    if (e.type === 'usage') return `${e.kind || 'usage'} · ${(Number(e.usage?.totalTokens) || 0).toLocaleString()} tokens`;
    if (e.type === 'compaction') return e.summary || `${e.tokensBefore || '?'} tokens summarized`;
    if (e.type === 'branch_summary') return e.summary || `from ${e.fromId || 'unknown'}`;
    if (e.type === 'session_info') return e.name || '';
    if (e.type === 'session') return e.cwd || 'session header';
    return textOf(e.content || e.data || e.details || '').slice(0, 150) || formatJson(e.data ?? e, 0).slice(0, 150);
  }
  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((x) => x?.type === 'text' ? x.text : x?.type === 'thinking' ? x.thinking : x?.type === 'toolCall' ? `${x.name}(${formatJson(x.arguments || {}, 0)})` : '').filter(Boolean).join('\n');
  }
  function blockText(b) {
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
    if (b?.type === 'thinking') return b.thinking || (b.redacted ? '(redacted)' : '');
    if (b?.type === 'toolCall') return formatJson(b.arguments ?? {});
    return typeof b === 'string' ? b : formatJson(b);
  }
  // Extra labelled text sections for message roles and entries that don't use `content`.
  function sectionsOf(x) {
    const out = [];
    if (!x || typeof x !== 'object') return out;
    const str = (v) => typeof v === 'string' ? v : formatJson(v);
    const names = (list) => (Array.isArray(list) ? list : []).map((t) => t?.name ?? '?').join(', ');
    if (x.role === 'bashExecution') out.push(['command', str(x.command ?? '')], ['output', str(x.output ?? '')]);
    if (typeof x.summary === 'string') out.push(['summary', x.summary]);
    if (x.sections && typeof x.sections === 'object') for (const [name, text] of Object.entries(x.sections)) out.push([`section · ${name}`, text == null ? '(removed)' : str(text)]);
    if (names(x.toolsAdded)) out.push(['tools added', names(x.toolsAdded)]);
    if (names(x.toolsRemoved)) out.push(['tools removed', names(x.toolsRemoved)]);
    return out;
  }
  function refsOf(e) {
    const refs = REFS.filter(([, key]) => typeof e[key] === 'string').map(([name, key]) => [name, e[key]]);
    const call = e.message?.role === 'toolResult' && index.callOwner.get(e.message.toolCallId);
    if (call && call.id !== e.parentId) refs.push(['tool call', call.id]);
    return refs;
  }
  function dateOf(e) { const t = e.timestamp || e.message?.timestamp; const d = new Date(t); return !t || Number.isNaN(d.getTime()) ? null : d; }
  function formatTime(e) { return dateOf(e)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) || ''; }
  function formatDate(e) { return dateOf(e)?.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) || ''; }
  // Pathologically nested input can overflow the stack; never let that break rendering.
  function formatJson(v, indent = 2) { try { return JSON.stringify(v, null, indent) ?? String(v); } catch { return '(too deeply nested to display)'; } }
  function money(n) { return Number(n) ? `$${Number(n).toFixed(4)}` : ''; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function count(n, one, many) { return `${n.toLocaleString()} ${plural(n, one, many)}`; }
  function getStats(list) {
    const s = { total: list.length, messages: 0, tools: 0, tokens: 0, cost: 0 };
    for (const e of list) {
      const kind = kindOf(e), usage = e.message?.usage || e.usage;
      if (kind === 'message') s.messages++;
      if (kind === 'tool results') s.tools++;
      s.tokens += Number(usage?.totalTokens) || 0;
      s.cost += Number(usage?.cost?.total) || 0;
    }
    return s;
  }
  // Scroll the virtual list by index, so it works even when the selected row isn't rendered.
  function reveal(where = 'nearest') {
    const i = filtered.indexOf(selected); if (!listEl || i < 0) return;
    const top = i * ROW, h = listEl.clientHeight;
    if (where === 'center') listEl.scrollTop = top - (h - ROW) / 2;
    else if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (top + ROW > listEl.scrollTop + h) listEl.scrollTop = top + ROW - h;
  }
  function selectAt(i) { if (i >= 0 && i < filtered.length) { selected = filtered[i]; reveal(); } }
  function pick(entry) {
    selected = entry;
    if (matchMedia('(max-width: 760px)').matches) tick().then(() => detailEl?.scrollIntoView({ behavior: 'smooth' }));
  }
  function handleScroll() { if (!listEl) return; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => scrollTop = listEl.scrollTop); }
  function loadText(text, name) {
    loadToken++;
    const { entries: parsed, skipped } = parseTrace(text);
    searchCache = new WeakMap();
    header = parsed.find((e) => e.type === 'session') || null;
    entries = parsed; selected = parsed[0] || null; fileName = name; query = ''; typeFilter = 'all';
    notice = !parsed.length ? `No Pi entries found in ${name}.` : [
      skipped.length && `Skipped ${count(skipped.length, 'invalid line', 'invalid lines')}: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}.`,
      !header && 'No session header found; this may not be a Pi session file.',
    ].filter(Boolean).join(' ');
    scrollTop = 0; if (listEl) listEl.scrollTop = 0;
  }
  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    const token = ++loadToken; // ignore a slower, older read finishing after a newer one
    reader.onload = () => token === loadToken && loadText(reader.result, file.name);
    reader.onerror = () => { if (token === loadToken) notice = `Could not read ${file.name}.`; };
    reader.readAsText(file);
  }
  function hasFiles(event) { return !!event.dataTransfer?.types?.includes('Files'); }
  function onPick(event) { readFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }
  function clearTrace() { loadToken++; header = null; entries = []; selected = null; fileName = ''; notice = ''; }
  function jumpTo(id) {
    const found = index.byId.get(id); if (!found) return;
    if (!filtered.includes(found)) { query = ''; typeFilter = 'all'; }
    selected = found; tick().then(() => reveal('center'));
  }
  async function copySelected() {
    try { await navigator.clipboard.writeText(formatJson(selected)); copyState = 'copied'; } catch { copyState = 'failed'; }
    setTimeout(() => copyState = '', 1500);
  }
</script>

<svelte:head>
  <title>{title ? `${title} · Pi trace viewer` : 'Pi Agent Harness Trace Viewer'}</title>
</svelte:head>
<svelte:window on:dragover={(e) => hasFiles(e) && e.preventDefault()} on:drop={(e) => { if (hasFiles(e)) { e.preventDefault(); readFile(e.dataTransfer.files[0]); } }} />

{#snippet contentView(content)}
  {#if Array.isArray(content)}
    {#each content as block}
      <article class="block"><div class="block-label">{block?.type ?? 'block'}{#if block?.name}{' · '}{block.name}{/if}{#if block?.type === 'toolCall' && index.resultFor.has(block.id)}<button class="link" on:click={() => jumpTo(index.resultFor.get(block.id).id)}>result ↳</button>{/if}</div>
        {#if block?.type === 'image' && typeof block.data === 'string' && /^image\/(png|jpe?g|gif|webp)$/.test(block.mimeType)}<img alt="Attached content" src={`data:${block.mimeType};base64,${block.data}`} />
        {:else if block?.type === 'image'}<pre>Image ({block.mimeType || 'unknown type'}, {(block.data?.length || 0).toLocaleString()} base64 chars) not displayed</pre>
        {:else}<pre>{blockText(block)}</pre>{/if}
      </article>
    {/each}
  {:else if typeof content === 'string' && content}<pre>{content}</pre>{/if}
{/snippet}

<header class="topbar">
  <div class="brand"><span class="mark">π</span><div><h1>Pi trace viewer</h1><p>Agent Harness session inspector</p></div></div>
  <div class="actions">
    <label class="button primary">Open JSONL<input aria-label="Upload a Pi JSONL trace" type="file" accept=".jsonl,.json,application/json,text/plain" on:change={onPick} /></label>
    <button class="button" on:click={() => loadText(SAMPLE, 'built-in-example.jsonl')}>Try example</button>
    {#if entries.length}<button class="button quiet" on:click={clearTrace}>Clear</button>{/if}
  </div>
</header>

{#if notice}<div class="alert" role="alert"><span>{notice}</span><button aria-label="Dismiss" on:click={() => notice = ''}>×</button></div>{/if}

{#if !entries.length}
  <main class="welcome">
    <div class="welcome-card">
      <span class="eyebrow">PRIVATE · LOCAL · JSONL</span>
      <h2>Understand what your agent actually did.</h2>
      <p>Drop a Pi Agent Harness session trace here to inspect prompts, reasoning, tool calls, model changes, branches, and usage without uploading it anywhere.</p>
      <div class="welcome-actions"><label class="button primary large">Choose a .jsonl trace<input aria-label="Choose a Pi JSONL trace" type="file" accept=".jsonl,.json,application/json,text/plain" on:change={onPick} /></label><button class="button large" on:click={() => loadText(SAMPLE, 'built-in-example.jsonl')}>Explore a test trace</button></div>
      <small>Supports Pi session format v1–v3 · works offline after loading · keyboard: / search, j/k move</small>
    </div>
  </main>
{:else}
  <main class="workspace">
    <section class="summary" aria-label="Trace summary">
      <div class="trace-title"><strong title={title}>{title || 'Pi session trace'}</strong><span title={header?.cwd}>{header?.cwd || 'Uploaded locally'}</span></div>
      <div class="stats"><span><b>{stats.total.toLocaleString()}</b> {plural(stats.total, 'entry', 'entries')}</span><span><b>{stats.messages.toLocaleString()}</b> {plural(stats.messages, 'message', 'messages')}</span><span><b>{stats.tools.toLocaleString()}</b> {plural(stats.tools, 'tool result', 'tool results')}</span><span title="Sum of per-turn totals, including cache reads"><b>{stats.tokens.toLocaleString()}</b> {plural(stats.tokens, 'token', 'tokens')}</span>{#if stats.cost}<span><b>{money(stats.cost)}</b> cost</span>{/if}</div>
    </section>
    <section class="controls">
      <label class="search"><span aria-hidden="true">⌕</span><input id="search" bind:value={query} on:keydown={(e) => { if (e.key === 'Escape') { query = ''; e.currentTarget.blur(); } }} placeholder="Search the trace…" aria-label="Search trace" autocomplete="off" /><kbd>/</kbd></label>
      <div class="filters" role="group" aria-label="Filter entry type">{#each TYPES as type}<button class:active={typeFilter === type} aria-pressed={typeFilter === type} on:click={() => typeFilter = type}>{type}</button>{/each}</div>
      <span class="result-count">{filtered.length.toLocaleString()} shown</span>
    </section>
    <div class="content-grid">
      <section class="event-panel" aria-label="Trace entries">
        <div class="list-head"><span>EVENTS</span><span>{selectedIndex >= 0 ? `${(selectedIndex + 1).toLocaleString()} / ${filtered.length.toLocaleString()}` : ''}</span></div>
        <div class="event-list" role="region" bind:this={listEl} bind:clientHeight={viewportHeight} on:scroll={handleScroll} tabindex="-1" aria-label="Virtualized trace event list">
          <div style={`height: ${filtered.length * ROW}px; position: relative`}>
            {#each visible as entry, n (entry)}
              <button class="event-row" class:selected={selected === entry} aria-current={selected === entry} style={`position:absolute; top:${(start + n) * ROW}px; left:0; right:0; height:${ROW}px`} on:click={() => pick(entry)}>
                <span class="event-index">{String(index.position.get(entry)).padStart(digits, '0')}</span><span class={`dot ${kindOf(entry).replace(' ', '-')}`} class:error={isError(entry)}></span>
                <span class="event-main"><span class="event-meta"><b>{labelOf(entry)}{#if index.labels.get(entry.id)}<span class="tag">#{index.labels.get(entry.id)}</span>{/if}</b><time>{formatTime(entry)}</time></span><span class="preview">{previewOf(entry)}</span></span>
                <span class="branch-mark" title={entry.parentId ? 'Has a parent' : undefined}>{entry.parentId ? '↳' : ''}</span>
              </button>
            {/each}
            {#if !filtered.length}<div class="empty-list">No matching entries. Try a different search or filter.</div>{/if}
          </div>
        </div>
      </section>
      <aside class="detail-panel" aria-label="Selected event detail" bind:this={detailEl}>
        {#if selected}
          {@const m = selected.type === 'message' ? selected.message || {} : null}
          <div class="detail-head"><div><span class={`pill ${kindOf(selected).replace(' ', '-')}`} class:error={isError(selected)}>{labelOf(selected)}</span>{#if index.labels.get(selected.id)}<span class="pill tag">#{index.labels.get(selected.id)}</span>{/if}<h2>{typeof selected.id === 'string' ? selected.id : labelOf(selected)}</h2><time>{formatDate(selected)}</time></div><button class="icon-button" title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy raw JSON'} aria-label="Copy raw JSON" on:click={copySelected}>{copyState === 'copied' ? '✓' : copyState === 'failed' ? '!' : '⧉'}</button></div>
          <div class="detail-body">
            {#if m}
              <div class="message-info"><span>role <b>{m.role ?? '—'}</b></span>{#if m.model}<span>model <b>{m.model}</b></span>{/if}{#if m.stopReason}<span>stop <b>{m.stopReason}</b></span>{/if}{#if m.exitCode !== undefined}<span>exit <b>{m.exitCode ?? '—'}</b></span>{/if}{#if m.cancelled}<span><b>cancelled</b></span>{/if}</div>
              {#if m.errorMessage}<article class="block error-block"><div class="block-label">error</div><pre>{m.errorMessage}</pre></article>{/if}
              {@render contentView(m.content)}
              {#each sectionsOf(m) as [label, text]}<article class="block"><div class="block-label">{label}</div><pre>{text}</pre></article>{/each}
              {#if m.usage}<div class="usage"><span>usage</span><b>{count(Number(m.usage.totalTokens) || 0, 'token', 'tokens')}</b><span>{money(m.usage.cost?.total)}</span></div>{/if}
            {:else if selected.type === 'model_change'}<div class="big-value">{selected.provider}<span>/</span>{selected.modelId}</div>
            {:else if selected.type === 'custom_message'}{@render contentView(selected.content)}
            {:else if selected.type === 'compaction' || selected.type === 'branch_summary'}{#each sectionsOf(selected) as [label, text]}<article class="block"><div class="block-label">{label}</div><pre>{text}</pre></article>{/each}
            {:else if selected.type !== 'label'}<pre>{formatJson(selected)}</pre>{/if}
            {#if ['message', 'model_change', 'label', 'custom_message', 'compaction', 'branch_summary'].includes(selected.type)}
              <details class="raw" bind:open={rawOpen}><summary>Raw JSON</summary>{#if rawOpen}<pre>{formatJson(selected)}</pre>{/if}</details>
            {/if}
            {#each refsOf(selected) as [name, id]}
              <div class="parent"><span>{name}</span><button disabled={!index.byId.has(id)} title={index.byId.has(id) ? undefined : 'Not in this file'} on:click={() => jumpTo(id)}>↳ {id}</button>{#if name === 'target' && selected.type === 'label'}<b class="tag">#{selected.label || '(cleared)'}</b>{/if}</div>
            {/each}
          </div>
        {:else}<div class="no-selection">Select an event to inspect it.</div>{/if}
      </aside>
    </div>
  </main>
{/if}

<footer><a href="https://pi.dev" rel="noreferrer">Pi Agent Harness</a><span>Trace data stays in your browser.</span></footer>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #f6f7f9; color: #18202b; font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  :global(button), :global(input) { font: inherit; }
  :global(button) { cursor: pointer; }
  .topbar { height: 68px; padding: 0 28px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e3e6eb; background: #fff; }
  .brand { display: flex; align-items: center; gap: 11px; }.mark { width: 33px; height: 33px; display: grid; place-items: center; border-radius: 7px; background: #202938; color: #fff; font: 22px Georgia, serif; }.brand h1 { margin: 0; font-size: 15px; letter-spacing: -.01em; }.brand p { margin: 1px 0 0; color: #556170; font-size: 11px; }.actions { display: flex; gap: 8px; }
  .button { border: 1px solid #d5dae2; border-radius: 6px; white-space: nowrap; padding: 7px 12px; color: #354052; background: #fff; font-weight: 600; font-size: 12px; }.button:hover { border-color: #aeb8c6; background: #fafbfc; }.button.primary { background: #1e2938; border-color: #1e2938; color: #fff; }.button.quiet { color: #52606f; }.button.large { padding: 10px 14px; font-size: 13px; }label.button { position: relative; cursor: pointer; }label.button:focus-within { outline: 2px solid #4b6c8d; outline-offset: 2px; }input[type=file] { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .welcome { min-height: calc(100vh - 115px); display: grid; place-items: center; padding: 28px; }.welcome-card { width: min(640px, 100%); text-align: center; }.eyebrow { color: #5b6675; font-size: 11px; font-weight: 700; letter-spacing: .12em; }.welcome h2 { margin: 12px 0 10px; font-size: clamp(26px, 5vw, 40px); line-height: 1.1; letter-spacing: -.04em; }.welcome p { max-width: 510px; margin: 0 auto 24px; color: #5b6675; font-size: 15px; }.welcome-actions { display: flex; justify-content: center; gap: 9px; flex-wrap: wrap; }.welcome small { display: block; margin-top: 22px; color: #5b6675; font-size: 11px; }
  .workspace { max-width: 1440px; margin: auto; padding: 22px 28px 0; }.summary { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding-bottom: 16px; }.trace-title { min-width: 0; }.trace-title strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }.trace-title span { display: block; overflow: hidden; color: #5d6978; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.stats { display: flex; gap: 18px; color: #5d6978; font-size: 11px; white-space: nowrap; }.stats b { color: #263241; font-size: 13px; }.controls { min-height: 45px; display: flex; align-items: center; gap: 12px; border-top: 1px solid #e1e5ea; border-bottom: 1px solid #e1e5ea; }.search { display: flex; align-items: center; gap: 7px; width: min(340px, 40%); padding: 6px 8px; border: 1px solid #d8dde5; border-radius: 5px; background: #fff; color: #5b6675; }.search input { min-width: 0; width: 100%; border: 0; outline: 0; color: #273241; background: transparent; font-size: 12px; }.search kbd { border: 1px solid #dfe3e8; border-radius: 3px; padding: 0 4px; color: #5b6675; font-size: 10px; }.filters { display: flex; gap: 3px; overflow-x: auto; }.filters button { border: 0; border-radius: 4px; padding: 5px 8px; background: transparent; color: #5c6877; font-size: 11px; text-transform: capitalize; white-space: nowrap; }.filters button:hover, .filters button.active { background: #e9edf2; color: #283444; }.result-count { margin-left: auto; color: #5c6877; font-size: 11px; white-space: nowrap; }.alert { width: min(1384px, calc(100% - 56px)); margin: 12px auto 0; padding: 9px 12px; border: 1px solid #efc4c4; border-radius: 5px; color: #9b3434; background: #fff5f5; display: flex; gap: 12px; justify-content: space-between; align-items: center; }.alert button { border: 0; padding: 0 4px; background: transparent; color: inherit; font-size: 16px; line-height: 1; }
  .content-grid { display: grid; grid-template-columns: minmax(0, 1.02fr) minmax(340px, .98fr); min-height: 610px; height: calc(100vh - 210px); max-height: 850px; border: 1px solid #e0e4e9; border-top: 0; background: #fff; }.event-panel { min-width: 0; min-height: 0; border-right: 1px solid #e0e4e9; }.list-head { height: 35px; padding: 0 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eef0f3; color: #5c6877; font-size: 10px; font-weight: 700; letter-spacing: .08em; }.event-list { height: calc(100% - 35px); min-height: 0; overflow: auto; outline: 0; }.event-row { width: 100%; display: flex; align-items: center; gap: 9px; padding: 0 15px; border: 0; border-bottom: 1px solid #f0f2f4; background: #fff; color: #303b4b; text-align: left; }.event-row:hover { background: #fafbfd; }.event-row.selected { background: #eef3f8; box-shadow: inset 3px 0 #4b6c8d; }.event-index { flex: none; min-width: 25px; color: #5b6675; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }.dot { flex: 0 0 7px; width: 7px; height: 7px; border-radius: 50%; background: #9da7b4; }.dot.message { background: #4b6c8d; }.dot.tool-results { background: #b27d3e; }.dot.error { background: #c0392b; }.dot.settings { background: #7a69a7; }.dot.compaction { background: #b65c63; }.event-main { min-width: 0; flex: 1; }.event-meta { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }.event-meta b { min-width: 0; overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.tag { margin-left: 6px; padding: 1px 5px; border-radius: 3px; background: #e6f0e8; color: #3f6b4b; font-size: 10px; font-weight: 600; }.pill.tag { margin-left: 6px; background: #e6f0e8; color: #3f6b4b; text-transform: none; }.link { margin-left: 8px; border: 0; padding: 0; background: transparent; color: #44607e; font-size: 10px; font-weight: 700; text-transform: uppercase; }.error-block { border-color: #efc4c4; }.error-block .block-label { color: #9b3434; background: #fff5f5; }.event-meta time { flex: none; color: #5b6675; font: 10px ui-monospace, monospace; }.preview { display: block; overflow: hidden; color: #5d6977; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.branch-mark { flex: none; width: 12px; color: #5b6675; }.empty-list { padding: 30px 20px; color: #5b6675; text-align: center; font-size: 12px; }
  .detail-panel { min-width: 0; overflow: auto; background: #fbfcfd; }.detail-head { display: flex; justify-content: space-between; gap: 12px; padding: 20px 22px 15px; border-bottom: 1px solid #e9edf1; }.pill { display: inline-block; margin-bottom: 8px; padding: 3px 6px; border-radius: 3px; background: #e8edf2; color: #526274; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }.pill.tool-results { background: #f3eadc; color: #74521f; }.pill.error { background: #fbe4e4; color: #a33a3a; }.pill.settings { background: #eeeaf7; color: #66558e; }.detail-head h2 { overflow: hidden; margin: 0 0 3px; font: 12px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }.detail-head time { color: #5b6675; font-size: 11px; }.icon-button { align-self: start; border: 1px solid #dfe4ea; border-radius: 4px; padding: 4px 7px; background: #fff; color: #657181; }.detail-body { padding: 17px 22px 30px; }.message-info { display: flex; gap: 13px; flex-wrap: wrap; margin-bottom: 15px; color: #5b6675; font-size: 10px; text-transform: uppercase; }.message-info b { color: #4c5968; font-size: 11px; text-transform: none; }.block { margin: 0 0 14px; border: 1px solid #e2e6eb; border-radius: 5px; overflow: hidden; background: #fff; }.block-label { padding: 6px 9px; border-bottom: 1px solid #e7eaee; color: #5b6675; font-size: 10px; font-weight: 700; text-transform: uppercase; }.detail-body pre { overflow: auto; margin: 0; padding: 11px; color: #354151; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }.block img { display: block; max-width: calc(100% - 18px); max-height: 360px; margin: 9px; }.raw { margin-top: 14px; color: #5b6675; font-size: 11px; }.raw summary { cursor: pointer; }.usage { display: flex; gap: 10px; align-items: center; padding: 9px 11px; border: 1px solid #e2e6eb; border-radius: 5px; color: #5b6675; font-size: 11px; }.usage b { color: #475466; }.big-value { padding: 18px 0; color: #38475a; font: 16px ui-monospace, monospace; overflow-wrap: anywhere; }.big-value span { padding: 0 5px; color: #5b6675; }.parent { display: flex; align-items: center; gap: 10px; margin-top: 20px; padding-top: 13px; border-top: 1px solid #e5e9ed; color: #5b6675; font-size: 10px; text-transform: uppercase; }.parent button:disabled { color: #a0a8b2; cursor: not-allowed; }.parent .tag { text-transform: none; }.parent button { overflow: hidden; border: 0; padding: 0; background: transparent; color: #44607e; font: 11px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }.no-selection { padding: 30px 22px; color: #5b6675; }footer { max-width: 1440px; margin: 0 auto; padding: 15px 28px 22px; display: flex; gap: 16px; color: #5b6675; font-size: 10px; }footer a { color: #4a5f78; text-decoration: none; }
  @media (max-width: 760px) { .topbar { height: auto; min-height: 62px; padding: 11px 14px; gap: 10px 12px; flex-wrap: wrap; }.brand p { display: none; }.actions { gap: 5px; }.actions .button { padding: 7px 8px; }.workspace { padding: 14px 10px 0; }.summary { display: block; padding-bottom: 12px; }.stats { margin-top: 10px; gap: 4px 12px; flex-wrap: wrap; }.controls { display: block; padding: 9px 0; }.search { width: 100%; }.search kbd { display: none; }.alert { width: calc(100% - 20px); }.filters { margin-top: 8px; flex-wrap: wrap; }.result-count { display: block; margin-top: 5px; }.content-grid { display: flex; flex-direction: column; height: auto; min-height: 0; border: 1px solid #e0e4e9; }.event-panel { height: 58vh; min-height: 350px; border-right: 0; border-bottom: 1px solid #e0e4e9; }.detail-panel { min-height: 360px; max-height: 65vh; }.detail-head { padding: 15px; }.detail-body { padding: 14px 15px 24px; }footer { padding: 13px 10px; flex-wrap: wrap; gap: 5px 12px; }.welcome { min-height: calc(100vh - 90px); padding: 20px 15px; }.welcome h2 { font-size: 29px; }.welcome p { font-size: 14px; }.welcome-actions { display: grid; }.welcome-actions .button { text-align: center; }.event-row { padding: 0 10px; }.preview { max-width: 75vw; } }
</style>
