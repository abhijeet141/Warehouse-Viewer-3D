<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import WarehouseScene from './lib/WarehouseScene.svelte';
  import { SEGMENTS_SUNDANCE } from './data/segmentsWarehouse5';
  import { SEGMENTS_BLOCK_STACK } from './data/blockStack';
  import type { Segment, SegmentType } from './types';

  // The Sundance racking model plus the block-stack floor storage laid out
  // beside it (zones BSA/BSB/BSC, their lanes, and the BS drive aisle).
  const SEGMENTS: Segment[] = [...SEGMENTS_SUNDANCE, ...SEGMENTS_BLOCK_STACK];

  const ALL_TYPES: SegmentType[] = ['AISLE', 'BAY', 'LEVEL', 'SPACE', 'BLOCK', 'LANE'];

  const TYPE_COLORS: Record<SegmentType, string> = {
    AISLE: '#3b82f6',
    BAY:   '#f97316',
    LEVEL: '#22c55e',
    SPACE: '#ef4444',
    BLOCK: '#6366f1',
    LANE:  '#ec4899',
  };

  // Overlays default off — the realistic racks carry the view; chips toggle
  // the schematic tier boxes on top.
  let visibleTypes = new Set<SegmentType>();

  // Demo stock: pallets + box stacks filling the bins, on by default.
  let showStock = true;

  // Building shell (roof, walls, columns, lights). On by default; turning it off
  // gives a clean open overview you can pull back from.
  let showShell = true;

  // App fullscreen via the Fullscreen API (NOT the browser's F11 chrome
  // fullscreen). This kind exits cleanly on Esc, unlike F11.
  let isFullscreen = false;
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  // Mirrors the scene's virtual-tour state so the header button reflects it.
  let tourActive = false;
  // Mirrors the block-stack walk-through (FLD-69) panel state.
  let flowActive = false;

  // Collapsible nav bar — slides away to maximise the 3D viewport. Toggled by the
  // chevron, the floating tab, or the "H" key; auto-collapses in fullscreen.
  let navCollapsed = false;
  function toggleNav() { navCollapsed = !navCollapsed; }

  // Small-screen (mobile/tablet) hamburger menu. On desktop the controls sit
  // inline in the header and this state is ignored (the panel uses display:contents
  // via CSS); below the responsive breakpoint the controls collapse into a dropdown
  // that this toggles open. Has no effect on the desktop/laptop layout.
  let menuOpen = false;
  function toggleMenu() { menuOpen = !menuOpen; }

  // Fade out the inline loading overlay (in index.html) once the 3D scene has
  // rendered its first frame — this masks the whole startup so there's no flash.
  // Kept on screen for at least MIN_LOADER_MS so it never just flickers past.
  const MIN_LOADER_MS = 1000;
  const appStart = performance.now();
  function onSceneReady() {
    const loader = document.getElementById('loader');
    if (!loader) return;
    const wait = Math.max(0, MIN_LOADER_MS - (performance.now() - appStart));
    setTimeout(() => {
      loader.classList.add('hide');
      loader.addEventListener('transitionend', () => loader.remove(), { once: true });
      setTimeout(() => loader.remove(), 900); // fallback if transitionend doesn't fire
    }, wait);
  }

  function toggle(type: SegmentType) {
    const next = new Set(visibleTypes);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    visibleTypes = next;
  }

  $: counts = (() => {
    const out: Record<SegmentType, number> = { AISLE: 0, BAY: 0, LEVEL: 0, SPACE: 0, BLOCK: 0, LANE: 0 };
    for (const s of SEGMENTS) out[s.type]++;
    return out;
  })();

  // Location search — lives in the header (nav bar). The 3D side effects (fly-to
  // + highlight boxes) run inside WarehouseScene via its exported methods.
  let sceneRef: WarehouseScene;
  let findInputEl: HTMLInputElement;
  let findQuery = '';
  let suggestions: Segment[] = [];
  let suggestionsOpen = false;
  let activeSuggestion = -1;
  let findStatus = '';
  let findStatusKind: 'ok' | 'err' = 'ok';
  $: qLen = findQuery.trim().length;

  function updateSuggestions() {
    findStatus = '';
    const q = findQuery.trim().toUpperCase();
    if (!q) { suggestions = []; suggestionsOpen = false; activeSuggestion = -1; return; }
    const out: Segment[] = [];
    for (const s of SEGMENTS) {
      if (s.fullName.toUpperCase().startsWith(q)) {
        out.push(s);
        if (out.length >= 8) break;
      }
    }
    suggestions = out;
    suggestionsOpen = out.length > 0;
    activeSuggestion = -1;
  }

  function runSearch(name?: string) {
    if (name !== undefined) findQuery = name;
    suggestionsOpen = false;
    activeSuggestion = -1;
    const res = sceneRef?.findLocation(findQuery) ?? { ok: true, message: '' };
    findStatus = res.message;
    findStatusKind = res.ok ? 'ok' : 'err';
  }

  function clearSearch() {
    findQuery = '';
    findStatus = '';
    suggestions = [];
    suggestionsOpen = false;
    activeSuggestion = -1;
    sceneRef?.clearFind();
    findInputEl?.focus();
  }

  function onFindKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' && suggestionsOpen) {
      e.preventDefault();
      activeSuggestion = (activeSuggestion + 1) % suggestions.length;
    } else if (e.key === 'ArrowUp' && suggestionsOpen) {
      e.preventDefault();
      activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
    } else if (e.key === 'Enter') {
      if (suggestionsOpen && activeSuggestion >= 0) runSearch(suggestions[activeSuggestion].fullName);
      else runSearch();
    } else if (e.key === 'Escape') {
      if (suggestionsOpen) { suggestionsOpen = false; activeSuggestion = -1; }
      else clearSearch();
    }
  }

  // Keyboard shortcuts (ignored while typing in a field): "/" focuses search,
  // "H" toggles the nav bar.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === '/') {
        e.preventDefault();
        navCollapsed = false; // reveal the bar if hidden, then focus search
        setTimeout(() => findInputEl?.focus(), 0);
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        toggleNav();
      }
    };
    window.addEventListener('keydown', onKey);
    // Maximise the view in fullscreen by auto-collapsing the nav; restore on exit.
    const onFsChange = () => {
      isFullscreen = !!document.fullscreenElement;
      navCollapsed = isFullscreen;
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
    };
  });
</script>

<main class:nav-collapsed={navCollapsed}>
  <header class="nav" class:collapsed={navCollapsed}>
    <div class="title">
      <h1>Warehouse 3D View</h1>
      <span class="subtitle">
        {counts.AISLE} aisles · {counts.BAY} bays · {counts.LEVEL} levels · {counts.SPACE.toLocaleString()} spaces · {counts.BLOCK} block-stack zones · {counts.LANE} segments
      </span>
    </div>

    <!-- Mobile/tablet hamburger — hidden on desktop via CSS (display:none). Toggles
         the .nav-body dropdown below the responsive breakpoint. -->
    <button
      class="hamburger"
      class:open={menuOpen}
      on:click={toggleMenu}
      title={menuOpen ? 'Close menu' : 'Open menu'}
      aria-label={menuOpen ? 'Close menu' : 'Open menu'}
      aria-expanded={menuOpen}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        {#if menuOpen}
          <path d="M6 6l12 12M18 6L6 18" />
        {:else}
          <path d="M4 7h16M4 12h16M4 17h16" />
        {/if}
      </svg>
    </button>

    <div class="nav-body" class:open={menuOpen}>
    <div class="search">
      <div class="search-bar">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
        <input
          class="search-input" type="text" placeholder="Search location… e.g. N11G03, A25 or BSD03"
          bind:this={findInputEl}
          bind:value={findQuery}
          on:input={updateSuggestions}
          on:keydown={onFindKeydown}
          on:focus={() => { if (suggestions.length) suggestionsOpen = true; }}
          on:blur={() => setTimeout(() => { suggestionsOpen = false; }, 120)}
          spellcheck="false" autocomplete="off"
        />
        {#if findQuery}
          <button class="search-clear" on:click={clearSearch} title="Clear search">✕</button>
        {:else}
          <kbd class="search-kbd">/</kbd>
        {/if}
        <button class="search-btn" on:click={() => runSearch()}>Find</button>
      </div>

      {#if suggestionsOpen}
        <ul class="search-suggest">
          {#each suggestions as s, i}
            <li>
              <button
                class="suggestion" class:active={i === activeSuggestion}
                on:mousedown|preventDefault={() => runSearch(s.fullName)}
                on:mouseenter={() => (activeSuggestion = i)}
              >
                <span class="s-name"><strong>{s.fullName.slice(0, qLen)}</strong>{s.fullName.slice(qLen)}</span>
                <span class="s-type" style="--t: {TYPE_COLORS[s.type]}">{s.type}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if findStatus}
        <div class="search-status" class:err={findStatusKind === 'err'}>{findStatus}</div>
      {/if}
    </div>

    <div class="group filters">
      <span class="group-label">Overlays</span>
      {#each ALL_TYPES as type}
        <button
          class="chip"
          class:active={visibleTypes.has(type)}
          style="--chip-color: {TYPE_COLORS[type]}"
          on:click={() => toggle(type)}
          title="{counts[type].toLocaleString()} {type.toLowerCase()}s — toggle overlay"
        >
          <span class="dot"></span>{type}
        </button>
      {/each}
    </div>

    <div class="toolbar">
      <button
        class="toggle tour-btn"
        class:active={tourActive}
        on:click={() => sceneRef?.toggleTour()}
        title={tourActive ? 'Stop the virtual tour' : 'Start the virtual tour'}
      >
        {#if tourActive}
          <svg class="t-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
          Stop tour
        {:else}
          <svg class="t-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>
          Virtual tour
        {/if}
      </button>

      <button
        class="toggle flow-btn"
        class:active={flowActive}
        on:click={() => sceneRef?.toggleFlow()}
        title={flowActive ? 'Close the block-stack walk-through' : 'Walk through FLD-69: policies → putaway → allocation → picking with pod substitution'}
      >
        <svg class="t-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="13" width="7" height="7" rx="1" /><rect x="3" y="4" width="7" height="7" rx="1" /><rect x="14" y="13" width="7" height="7" rx="1" />
          <path d="M14 8h7M17.5 4.5 21 8l-3.5 3.5" />
        </svg>
        Block-stack flow
      </button>

      <span class="divider"></span>

      <div class="group">
        <button
          class="toggle stock-btn"
          class:active={showStock}
          on:click={() => (showStock = !showStock)}
          title="Show demo stock (pods &amp; boxes) in the bins"
        >
          <span class="stock-dot"></span>Demo stock <span class="state">{showStock ? 'on' : 'off'}</span>
        </button>
        <button
          class="toggle shell-btn"
          class:active={showShell}
          on:click={() => (showShell = !showShell)}
          title="Show or hide the building shell — roof, walls, columns and lights"
        >
          <svg class="t-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 11 V20 H19 V11" />
            <path d="M3.5 11.5 L12 4 L20.5 11.5" />
          </svg>
          Building shell <span class="state">{showShell ? 'on' : 'off'}</span>
        </button>
      </div>

      <span class="divider"></span>

      <div class="group">
        <button class="icon-btn" on:click={() => sceneRef?.resetView()} title="Reset view">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 10.5 L12 3 L21 10.5" />
            <path d="M5.5 9.2 V20 H18.5 V9.2" />
          </svg>
        </button>
        <button
          class="icon-btn"
          on:click={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen — exits with Esc'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            {#if isFullscreen}
              <path d="M9 4 V9 H4 M20 9 H15 V4 M15 20 V15 H20 M4 15 H9 V20" />
            {:else}
              <path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15" />
            {/if}
          </svg>
        </button>
      </div>

      <span class="divider"></span>

      <button class="icon-btn" on:click={toggleNav} title="Hide controls (H)" aria-label="Hide controls">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 14l6-6 6 6" />
        </svg>
      </button>
    </div>
    </div>
  </header>

  {#if navCollapsed}
    <button
      class="nav-reveal"
      on:click={toggleNav}
      title="Show controls (H)"
      aria-label="Show controls"
      transition:fly={{ y: -16, duration: 220 }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 10l6 6 6-6" />
      </svg>
    </button>
  {/if}

  <WarehouseScene bind:this={sceneRef} on:ready={onSceneReady} on:tour={(e) => (tourActive = e.detail)} on:flow={(e) => (flowActive = e.detail)} on:stock={() => (showStock = true)} segments={SEGMENTS} {visibleTypes} {showStock} {showShell} />
</main>

<style>
  main {
    --nav-h: 58px;
    /* The toolbar is rendered at this scale (≈ an 82% browser-zoom look) so its
       height and controls read more compactly at 100% zoom. */
    --nav-scale: 0.82;
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #dde3ea;
    /* The header overlays this reserved strip; collapsing animates it to 0 so the
       3D viewport grows to fill. Reserve the scaled header height, not the raw one. */
    padding-top: calc(var(--nav-h) * var(--nav-scale));
    transition: padding-top 0.38s cubic-bezier(0.4, 0, 0.2, 1);
  }
  main.nav-collapsed { padding-top: 0; }

  header {
    position: absolute;
    top: 0;
    left: 0;
    /* Pre-inflate the width so that after the scale-down it spans edge to edge. */
    width: calc(100% / var(--nav-scale));
    height: var(--nav-h);
    transform: scale(var(--nav-scale));
    transform-origin: top left;
    box-sizing: border-box;
    z-index: 30;
    background: #f4f6f8;
    border-bottom: 1px solid #cbd5e1;
    padding: 0 18px;
    display: flex;
    align-items: center;
    gap: 18px;
    color: #0f172a;
    transition: transform 0.38s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.24s ease;
  }
  header.collapsed {
    transform: scale(var(--nav-scale)) translateY(-100%);
    opacity: 0;
    pointer-events: none;
  }

  /* Floating "pull down" tab shown while the nav is collapsed. */
  .nav-reveal {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    z-index: 30;
    display: grid;
    place-items: center;
    width: 46px;
    height: 24px;
    padding: 0;
    border: 1px solid #cbd5e1;
    border-top: none;
    border-radius: 0 0 12px 12px;
    background: rgba(244, 246, 248, 0.92);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: #64748b;
    cursor: pointer;
    box-shadow: 0 6px 16px rgba(15, 23, 42, 0.16);
    transition: color 0.15s, background 0.15s, height 0.15s;
  }
  .nav-reveal:hover { color: #1d4ed8; background: #ffffff; height: 27px; }
  .nav-reveal svg { width: 18px; height: 18px; }
  /* On desktop the wrapper is layout-invisible: its children (search, overlays,
     toolbar) behave exactly as direct header flex items, so the desktop layout is
     unchanged. The responsive media query below turns it into a dropdown panel. */
  .nav-body { display: contents; }

  /* Hamburger — desktop hidden; revealed only at the responsive breakpoint. */
  .hamburger {
    display: none;
    flex: none;
    margin-left: auto;
    width: 36px; height: 36px;
    place-items: center;
    background: transparent;
    border: 1.5px solid #cbd5e1;
    border-radius: 10px;
    color: #475569;
    cursor: pointer;
    transition: all 0.15s;
  }
  .hamburger:hover { border-color: #3b82f6; color: #3b82f6; }
  .hamburger.open { border-color: #3b82f6; color: #3b82f6; background: rgba(59,130,246,0.08); }
  .hamburger svg { width: 20px; height: 20px; }

  .title { display: flex; flex-direction: column; flex: none; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: 0.2px; }
  .subtitle { font-size: 11px; opacity: 0.6; margin-top: 2px; letter-spacing: 0.2px; }

  .search { position: relative; flex: 0 1 320px; min-width: 200px; }
  .search-bar {
    display: flex; align-items: center; gap: 8px;
    background: #ffffff;
    border: 1.5px solid #cbd5e1;
    border-radius: 999px;
    padding: 4px 4px 4px 12px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .search-bar:focus-within {
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
  }
  .search-icon { width: 15px; height: 15px; color: #94a3b8; flex: none; transition: color 0.15s; }
  .search-bar:focus-within .search-icon { color: #3b82f6; }
  .search-input {
    flex: 1; min-width: 0; background: transparent; border: none; outline: none;
    color: #0f172a; font-size: 13px; font-family: monospace; letter-spacing: 0.2px;
  }
  .search-input::placeholder { color: #94a3b8; }
  .search-clear {
    flex: none; width: 20px; height: 20px; border-radius: 50%;
    border: none; background: #e2e8f0; color: #64748b; cursor: pointer;
    font-size: 10px; line-height: 1; display: grid; place-items: center;
    transition: background 0.15s, color 0.15s;
  }
  .search-clear:hover { background: #cbd5e1; color: #0f172a; }
  .search-kbd {
    flex: none; color: #94a3b8; border: 1px solid #cbd5e1; border-radius: 4px;
    font-size: 10px; font-family: monospace; padding: 1px 6px;
  }
  .search-btn {
    flex: none; background: #2563eb; border: none; color: #fff;
    padding: 5px 16px; border-radius: 999px; cursor: pointer;
    font-size: 12px; font-weight: 600; letter-spacing: 0.2px;
    transition: background 0.15s;
  }
  .search-btn:hover { background: #3b82f6; }
  .search-btn:active { background: #1d4ed8; }
  .search-suggest {
    position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 50;
    margin: 0; padding: 6px; list-style: none;
    background: #ffffff;
    border: 1px solid #d6dee6; border-radius: 12px;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
    max-height: 300px; overflow-y: auto;
  }
  .search-suggest li { margin: 0; padding: 0; }
  .suggestion {
    width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 12px;
    background: transparent; border: none; cursor: pointer;
    padding: 7px 10px; border-radius: 8px; color: #475569;
    font-family: monospace; font-size: 12px; text-align: left;
    transition: background 0.1s;
  }
  .suggestion.active { background: rgba(59, 130, 246, 0.12); color: #0f172a; }
  .s-name strong { color: #2563eb; font-weight: 700; }
  .s-type {
    flex: none; font-size: 9px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--t); color: var(--t); letter-spacing: 0.6px;
  }
  /* Match/no-match feedback: a solid floating chip that drops clear of the header
     so it never straddles the header border, with a leading status dot. A white
     base keeps it legible over the busy 3D scene (a translucent tint did not). */
  .search-status {
    position: absolute; top: calc(100% + 11px); left: 0; z-index: 50;
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 11px; font-family: monospace; white-space: nowrap;
    padding: 5px 13px 5px 11px; border-radius: 999px;
    background: #ffffff; color: #15803d;
    border: 1px solid rgba(34, 197, 94, 0.5);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.16);
  }
  .search-status::before {
    content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%;
    background: #22c55e;
  }
  .search-status.err {
    color: #b91c1c; border-color: rgba(239, 68, 68, 0.5);
  }
  .search-status.err::before { background: #ef4444; }

  /* Grouped controls: data tools (overlays) sit by the search; scene toggles and
     view utilities cluster on the right, separated by a divider. */
  .group { display: flex; align-items: center; gap: 8px; }
  .group-label {
    font-size: 9px; letter-spacing: 1.2px;
    text-transform: uppercase; color: #94a3b8; margin-right: 2px;
  }
  .toolbar { margin-left: auto; flex: none; display: flex; align-items: center; gap: 14px; }
  .divider { width: 1px; height: 24px; background: #d6dee6; flex: none; }

  .chip {
    background: transparent;
    border: 1.5px solid #cbd5e1;
    color: #475569;
    padding: 4px 11px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.15s;
  }
  .chip:hover { border-color: var(--chip-color); color: #0f172a; }
  .chip.active { border-color: var(--chip-color); color: var(--chip-color); background: rgba(15,23,42,0.04); }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--chip-color);
  }

  /* State toggles: outline when off, filled-tint when on. */
  .toggle {
    flex: none;
    background: transparent;
    border: 1.5px solid #cbd5e1;
    color: #475569;
    padding: 5px 13px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    transition: all 0.15s;
  }
  .toggle .state { color: #94a3b8; }
  .t-icon { width: 14px; height: 14px; color: #94a3b8; }
  .stock-btn:hover { border-color: #c2843a; color: #0f172a; }
  .stock-btn.active {
    border-color: #c2843a; color: #8a5a1e; background: rgba(194,132,58,0.12);
  }
  .stock-btn.active .state { color: #b06f1f; }
  .shell-btn:hover { border-color: #3b82f6; color: #0f172a; }
  .shell-btn:hover .t-icon { color: #3b82f6; }
  .shell-btn.active {
    border-color: #2563eb; color: #1d4ed8; background: rgba(37, 99, 235, 0.1);
  }
  .shell-btn.active .t-icon,
  .shell-btn.active .state { color: #2563eb; }
  /* Virtual tour — the primary demo action, accented to stand out. */
  .tour-btn { border-color: #2563eb; color: #1d4ed8; font-weight: 600; }
  .tour-btn .t-icon { color: #2563eb; }
  .tour-btn:hover { background: rgba(37, 99, 235, 0.08); }
  .tour-btn.active { background: #2563eb; border-color: #2563eb; color: #fff; }
  .tour-btn.active .t-icon { color: #fff; }
  /* Block-stack walk-through — amber, the colour the flow uses for allocations. */
  .flow-btn { border-color: #d97706; color: #b45309; font-weight: 600; }
  .flow-btn .t-icon { color: #d97706; }
  .flow-btn:hover { background: rgba(217, 119, 6, 0.1); }
  .flow-btn.active { background: #d97706; border-color: #d97706; color: #fff; }
  .flow-btn.active .t-icon { color: #fff; }
  .stock-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: #c2843a;
  }

  /* View utilities: compact icon-only buttons. */
  .icon-btn {
    flex: none;
    width: 32px; height: 32px;
    display: grid; place-items: center;
    background: transparent;
    border: 1.5px solid #cbd5e1;
    border-radius: 999px;
    color: #64748b;
    cursor: pointer;
    transition: all 0.15s;
  }
  .icon-btn:hover { border-color: #3b82f6; color: #3b82f6; }
  .icon-btn svg { width: 16px; height: 16px; }

  /* Mid-width laptops (≤ 1520px): with the block-stack chips and the flow button
     the inline toolbar outgrows the bar, so shrink the whole bar a little more
     and drop the on/off words — every control stays visible and clickable. */
  @media (max-width: 1520px) and (min-width: 1025px) {
    main { --nav-scale: 0.74; }
    header { gap: 12px; padding: 0 12px; }
    .toolbar { gap: 10px; }
    .toggle .state { display: none; }
    .search { flex: 0 1 260px; min-width: 180px; }
  }

  /* ──────────────────────────────────────────────────────────────────────────
     Responsive: mobile & tablet (≤ 1024px). Everything here is scoped to this
     media query, so the desktop/laptop layout above is completely untouched.
     The inline controls collapse into a hamburger-toggled dropdown panel.
     ────────────────────────────────────────────────────────────────────────── */
  @media (max-width: 1024px) {
    /* Header stays a single compact row: title on the left, hamburger on the right.
       Don't scale the header down on small screens — it cramps touch targets. */
    main { --nav-scale: 1; }
    header { gap: 10px; padding: 0 14px; }

    .hamburger { display: grid; }

    /* The controls move into a right-aligned dropdown that overlays the scene.
       Hidden until the hamburger opens it. */
    .nav-body {
      display: none;
      position: absolute;
      top: calc(var(--nav-h) + 6px);
      right: 10px;
      left: 10px;
      max-width: 380px;
      margin-left: auto;
      flex-direction: column;
      align-items: stretch;
      gap: 14px;
      padding: 16px;
      box-sizing: border-box;
      background: #f4f6f8;
      border: 1px solid #cbd5e1;
      border-radius: 14px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.22);
      max-height: calc(100vh - var(--nav-h) - 24px);
      overflow-y: auto;
    }
    .nav-body.open { display: flex; }

    /* Each control group stacks full-width inside the panel. */
    .nav-body .search { flex: none; width: 100%; min-width: 0; }
    .nav-body .filters,
    .nav-body .toolbar {
      margin-left: 0;
      flex-wrap: wrap;
      width: 100%;
      gap: 10px 8px;
    }
    /* Vertical dividers don't make sense once the toolbar wraps. */
    .nav-body .divider { display: none; }
    /* Let the inner groups wrap rather than overflow the panel. */
    .nav-body .toolbar .group { flex-wrap: wrap; }
  }
</style>
