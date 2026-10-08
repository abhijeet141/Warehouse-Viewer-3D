<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import WarehouseScene from './lib/WarehouseScene.svelte';
  import { SEGMENTS_SUNDANCE } from './data/segmentsWarehouse5';
  import { SEGMENTS_BLOCK_STACK, type LaneStock } from './data/blockStack';
  import { DB_DEFINITION_CODE, loadDbBlockStack, type DbLoadResult } from './data/dbBlockStack';
  import { DbApiError, probeCredentials, readStoredCredentials, storeCredentials, type DbCredentials } from './data/dbApi';
  import type { Segment, SegmentType } from './types';

  // The Sundance racking model plus the block-stack floor storage laid out beside
  // it. The block stack comes from one of two sources: the seeded demo layout, or
  // (DB mode) the real segment definition, zones, lanes and pallets read from the
  // local FloWMS services — read-only, through the dev proxy.
  type DataMode = 'demo' | 'db';
  // A reload lands in DB mode — the user's real block stack; the demo is one click away.
  const DEFAULT_MODE: DataMode = 'db';
  let dataMode: DataMode = DEFAULT_MODE;
  let booting = DEFAULT_MODE === 'db';      // the first DB read: the scene is built once it lands
  let dbData: DbLoadResult | null = null;   // last successful DB read
  let dbBusy = false;                       // a read is in flight
  let dbProgress = '';
  let dbError = '';
  let dbDialogOpen = false;
  let dbInfoOpen = readInfoOpen();          // the summary card while in DB mode
  $: rememberInfoOpen(dbInfoOpen);
  let dbTokenInput = '';
  let dbFingerprintInput = '';
  let dbCreds: DbCredentials | null = readStoredCredentials();
  let sceneKey = 0;                         // bumping it rebuilds the scene on the other data set
  let sceneBuilding = false;                // between a rebuild and its first rendered frame

  $: SEGMENTS = (dataMode === 'db' && dbData
    ? [...SEGMENTS_SUNDANCE, ...dbData.segments]
    : [...SEGMENTS_SUNDANCE, ...SEGMENTS_BLOCK_STACK]) as Segment[];
  // The scene builds its lane stock from this; null means the seeded demo pallets.
  $: stockSource = dataMode === 'db' && dbData ? dbStockSource(dbData) : null;

  function dbStockSource(data: DbLoadResult): (lanes: Segment[]) => Map<string, LaneStock> {
    return (lanes) => new Map(lanes.filter((l) => l.lane).map((l) => [l.fullName, data.stock.get(l.fullName) ?? { lane: l, pods: [], classKey: null }]));
  }

  const INFO_KEY = 'wv.db.info';
  function readInfoOpen(): boolean {
    try { return localStorage.getItem(INFO_KEY) !== 'closed'; } catch { return true; }
  }
  function rememberInfoOpen(open: boolean) {
    try { localStorage.setItem(INFO_KEY, open ? 'open' : 'closed'); } catch { /* fine without */ }
  }

  function switchScene() {
    sceneBuilding = true;
    sceneKey++;
  }

  async function loadDb(creds: DbCredentials | null) {
    dbBusy = true;
    dbError = '';
    dbProgress = 'Connecting…';
    try {
      await probeCredentials(creds);
      const data = await loadDbBlockStack(creds, (m) => (dbProgress = m));
      dbData = data;
      dbCreds = creds;
      storeCredentials(creds);
      dataMode = 'db';
      dbDialogOpen = false;
      switchScene();
    } catch (e) {
      dbError = e instanceof DbApiError ? `${e.status ? e.status + ' · ' : ''}${e.message}` : (e as Error).message;
      if (e instanceof DbApiError && (e.status === 401 || e.status === 403)) {
        dbCreds = null;
        storeCredentials(null);
        dbDialogOpen = true;
      }
    } finally {
      dbBusy = false;
      dbProgress = '';
    }
  }

  // Startup in DB mode: read first and build the scene once, with the result, while
  // the page loader is still up. Stored credentials are used, else the proxy's own; a
  // rejection opens the connect dialog over the demo scene instead.
  async function bootDb() {
    const loaderSub = document.querySelector<HTMLElement>('#loader .ld-sub');
    const say = (m: string) => { dbProgress = m; if (loaderSub) loaderSub.textContent = m; };
    const hadCreds = !!dbCreds;
    dbBusy = true;
    try {
      say('Connecting to the local FloWMS…');
      await probeCredentials(dbCreds);
      dbData = await loadDbBlockStack(dbCreds, say);
      dataMode = 'db';
    } catch (e) {
      dataMode = 'demo';
      const msg = e instanceof DbApiError ? `${e.status ? e.status + ' · ' : ''}${e.message}` : (e as Error).message;
      if (e instanceof DbApiError && (e.status === 401 || e.status === 403)) {
        dbCreds = null;
        storeCredentials(null);
        dbError = hadCreds ? msg : ''; // no credentials at all is not an error, just a question
        dbDialogOpen = true;
      } else {
        dbError = msg;
      }
    } finally {
      dbBusy = false;
      dbProgress = '';
      booting = false;
    }
  }

  // Header button. In DB mode: back to the demo (the last read is kept for the next
  // switch; Refresh re-reads). Otherwise: show the last read, or read now with the
  // stored token — or the proxy's own credentials — asking for a token only when
  // the services reject the call.
  async function toggleDbMode() {
    if (dbBusy) return;
    if (dataMode === 'db') { dataMode = 'demo'; switchScene(); return; }
    if (dbData) { dataMode = 'db'; switchScene(); return; }
    if (!dbCreds) {
      try {
        await probeCredentials(null);
      } catch (e) {
        dbError = e instanceof DbApiError && e.status === 401 ? '' : (e as Error).message;
        dbDialogOpen = true;
        return;
      }
    }
    await loadDb(dbCreds);
  }

  function connectDb() {
    const token = dbTokenInput.trim().replace(/^Bearer\s+/i, '');
    const fingerprint = dbFingerprintInput.trim().replace(/^atFingerprint=/i, '');
    if (!token || !fingerprint) { dbError = 'Both the access token and the atFingerprint cookie value are needed.'; return; }
    dbTokenInput = '';
    dbFingerprintInput = '';
    void loadDb({ token, fingerprint });
  }
  function refreshDb() { if (!dbBusy) void loadDb(dbCreds); }
  function forgetDb() { dbCreds = null; storeCredentials(null); }

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
    sceneBuilding = false;
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
    if (booting) void bootDb();
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
        {#if dataMode === 'db' && dbData}
          {@const s = dbData.summary}
          <span class="db-tag">DB</span> {s.definition.code} · {s.zones} zones · {s.lanes} lanes · {s.pallets} pallets in {s.lanesUsed} lanes · {counts.AISLE} aisles · {counts.SPACE.toLocaleString()} spaces
        {:else}
          {counts.AISLE} aisles · {counts.BAY} bays · {counts.LEVEL} levels · {counts.SPACE.toLocaleString()} spaces · {counts.BLOCK} block-stack zones · {counts.LANE} lanes
        {/if}
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
          class="search-input" type="text" placeholder="Search location… e.g. N11G03, A25 or BSA03"
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
        disabled={dataMode === 'db'}
        on:click={() => sceneRef?.toggleFlow()}
        title={dataMode === 'db' ? 'The walk-through runs on the demo fixture lanes — switch DB mode off to use it' : flowActive ? 'Close the block-stack walk-through' : 'Walk through FLD-69: policies → putaway → allocation → picking with pallet substitution'}
      >
        <svg class="t-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="13" width="7" height="7" rx="1" /><rect x="3" y="4" width="7" height="7" rx="1" /><rect x="14" y="13" width="7" height="7" rx="1" />
          <path d="M14 8h7M17.5 4.5 21 8l-3.5 3.5" />
        </svg>
        Block-stack flow
      </button>

      <!-- DB mode: the real block stack from the local location_service (read-only). -->
      <button
        class="toggle db-btn"
        class:active={dataMode === 'db'}
        class:busy={dbBusy}
        disabled={dbBusy}
        on:click={toggleDbMode}
        title={dataMode === 'db' ? 'Back to the seeded demo block stack' : 'Show your real block stack — segment definition, zones, lanes and pallets — read from the local FloWMS services'}
      >
        <svg class="t-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
        </svg>
        {dbBusy ? 'Reading DB…' : 'DB mode'} <span class="state">{dataMode === 'db' ? 'on' : 'off'}</span>
      </button>
      {#if dataMode === 'db'}
        <button class="icon-btn" on:click={refreshDb} disabled={dbBusy} title="Re-read the block stack from the database">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></svg>
        </button>
        <button class="icon-btn" class:on={dbInfoOpen} on:click={() => (dbInfoOpen = !dbInfoOpen)} title={dbInfoOpen ? 'Hide the DB summary' : 'Show the DB summary'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
        </button>
      {/if}

      <span class="divider"></span>

      <div class="group">
        <button
          class="toggle stock-btn"
          class:active={showStock}
          on:click={() => (showStock = !showStock)}
          title="Show demo stock (pallets &amp; boxes) in the bins"
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

  {#if dbDialogOpen}
    <!-- Credentials for the local services. They stay in this tab's session storage;
         every request the viewer makes is a GET. -->
    <div class="db-modal" role="dialog" aria-modal="true" aria-labelledby="db-title" transition:fade={{ duration: 120 }}>
      <div class="db-card">
        <div class="db-head">
          <h2 id="db-title">Connect to the local FloWMS</h2>
          <button class="db-x" on:click={() => (dbDialogOpen = false)} aria-label="Close">✕</button>
        </div>
        <p class="db-intro">
          DB mode reads your block stack — segment definition <code>{DB_DEFINITION_CODE}</code>, its areas and lanes, zones,
          stock-mix policies and the pallets standing in the lanes — from the services started by launch.ps1.
          <strong>Read-only:</strong> only GET requests are made; nothing is inserted or updated.
        </p>
        <label class="db-field">
          <span>Access token</span>
          <textarea rows="3" bind:value={dbTokenInput} placeholder="eyJhbGciOi… (the Bearer token from Postman)" spellcheck="false"></textarea>
        </label>
        <label class="db-field">
          <span>atFingerprint cookie</span>
          <input type="text" bind:value={dbFingerprintInput} placeholder="01a0…" spellcheck="false" autocomplete="off" />
        </label>
        <p class="db-note">
          Kept in this tab's session storage only — never written to disk, never sent anywhere but localhost.
          Alternatively drop <code>flowms-viewer-auth.json</code> ({'{'}"token", "fingerprint"{'}'}) in your temp folder and the dev server signs the requests itself.
        </p>
        {#if dbError}<div class="db-error">{dbError}</div>{/if}
        {#if dbBusy}<div class="db-progress">{dbProgress}</div>{/if}
        <div class="db-actions">
          {#if dbCreds}<button class="db-secondary" on:click={forgetDb}>Forget stored token</button>{/if}
          <span class="db-spacer"></span>
          <button class="db-secondary" on:click={() => (dbDialogOpen = false)}>Cancel</button>
          <button class="db-primary" on:click={connectDb} disabled={dbBusy}>{dbBusy ? 'Reading…' : 'Connect & read'}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if !dbDialogOpen && (dbBusy || sceneBuilding || dbError)}
    <div class="db-toast" class:err={!!dbError && !dbBusy} transition:fade={{ duration: 120 }}>
      {#if dbBusy}{dbProgress || 'Reading the database…'}
      {:else if sceneBuilding}Building the 3D view…
      {:else}{dbError} <button class="db-toast-x" on:click={() => (dbError = '')} aria-label="Dismiss">✕</button>{/if}
    </div>
  {/if}

  {#if dataMode === 'db' && dbData && dbInfoOpen}
    {@const s = dbData.summary}
    <!-- What was read: the definition, its counts and the policy each zone resolves to. -->
    <aside class="db-info" transition:fly={{ y: 10, duration: 200 }}>
      <div class="db-info-head">
        <span class="db-tag">DB</span>
        <span class="db-info-title">{s.definition.name} <span class="db-info-code">{s.definition.code}</span></span>
        <button class="db-x" on:click={() => (dbInfoOpen = false)} aria-label="Hide the DB summary">✕</button>
      </div>
      <div class="db-info-grid">
        <span>Warehouse</span><span>{s.warehouseId} · read {s.fetchedAt.toLocaleTimeString()}</span>
        <span>Types</span><span>{s.areaType} → {s.laneType}</span>
        <span>Zones</span><span>{s.zones} · {s.lanes} lanes · {s.lanesUsed} in use</span>
        <span>Pallets</span><span>{s.pallets} · {s.podLines} pod lines</span>
      </div>
      <table class="db-policies">
        <thead><tr><th>Policy</th><th>Hash keys</th><th>Zones</th></tr></thead>
        <tbody>
          {#each s.policies as p}
            <tr>
              <td><span class="db-pol">{p.code}</span><span class="db-dim">{p.scope} scope · {p.candidates} candidates</span></td>
              <td>{p.keys.join(', ')}</td>
              <td class="db-zones">{p.zones.join(' ')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if s.pickTrail.jobs.length || s.pickTrail.locations.length}
        <div class="db-line">
          <span class="db-dim">Pick trail:</span>
          {#if s.pickTrail.jobs.length}{s.pickTrail.jobs.map((j) => `${j.count} ${j.status.toLowerCase()}`).join(' · ')} pick job{s.pickTrail.jobs.reduce((n, j) => n + j.count, 0) === 1 ? '' : 's'} on block-stack pallets{:else}no pick jobs on block-stack pallets{/if}{#if s.pickTrail.inBucket} · {s.pickTrail.inBucket} in a bucket{/if}
          {#if s.pickTrail.locations.length}· pick locations {s.pickTrail.locations.map((l) => `${l.name} (${l.pallets})`).join(', ')}{/if}
        </div>
      {/if}
      {#if s.emptyZones.length}<div class="db-line db-dim">No stock yet: {s.emptyZones.join(', ')}</div>{/if}
      {#if s.driftLanes.length}<div class="db-line db-warn">currentPodCount ≠ pallets found: {s.driftLanes.join('; ')}</div>{/if}
      {#if s.overfullLanes.length}<div class="db-line db-warn">Over capacity: {s.overfullLanes.join(', ')}</div>{/if}
      <div class="db-line db-dim">The DB holds no coordinates for these segments, so the floor plan is synthesised: zones in zonePreference order along the drive aisles, each lane a single stack up to maximumPods high. Hover a lane or pallet for its record.</div>
    </aside>
  {/if}

  {#if !booting}
  {#key sceneKey}
    <WarehouseScene bind:this={sceneRef} on:ready={onSceneReady} on:tour={(e) => (tourActive = e.detail)} on:flow={(e) => (flowActive = e.detail)} on:stock={() => (showStock = true)} segments={SEGMENTS} {stockSource} {visibleTypes} {showStock} {showShell} />
  {/key}
  {/if}
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

  .toggle:disabled, .icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .icon-btn.on { border-color: #059669; color: #047857; background: rgba(5, 150, 105, 0.1); }

  /* DB mode — emerald, so the live data set is never mistaken for the demo. */
  .db-btn { border-color: #059669; color: #047857; font-weight: 600; }
  .db-btn .t-icon { color: #059669; }
  .db-btn:hover:not(:disabled) { background: rgba(5, 150, 105, 0.1); }
  .db-btn.active { background: #059669; border-color: #059669; color: #fff; }
  .db-btn.active .t-icon, .db-btn.active .state { color: #d1fae5; }
  .db-btn.busy { opacity: 0.8; }
  .db-tag {
    display: inline-block; padding: 0 6px; margin-right: 2px; border-radius: 4px;
    background: #059669; color: #fff; font-size: 9px; font-weight: 700; letter-spacing: 0.8px; line-height: 15px; vertical-align: 1px;
  }

  .db-modal {
    position: absolute; inset: 0; z-index: 60;
    display: grid; place-items: center;
    background: rgba(15, 23, 42, 0.45);
    backdrop-filter: blur(3px);
  }
  .db-card {
    width: min(560px, calc(100vw - 32px)); box-sizing: border-box;
    background: #ffffff; color: #0f172a;
    border-radius: 16px; padding: 20px 22px 18px;
    box-shadow: 0 30px 80px rgba(15, 23, 42, 0.35);
    font-size: 13px;
  }
  .db-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .db-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .db-x {
    flex: none; width: 26px; height: 26px; border-radius: 50%; border: none;
    background: #e2e8f0; color: #64748b; cursor: pointer; font-size: 11px; display: grid; place-items: center;
  }
  .db-x:hover { background: #cbd5e1; color: #0f172a; }
  .db-intro { margin: 10px 0 14px; color: #334155; line-height: 1.45; }
  .db-intro code, .db-note code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
  .db-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
  .db-field span { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #64748b; }
  .db-field textarea, .db-field input {
    width: 100%; box-sizing: border-box; border: 1.5px solid #cbd5e1; border-radius: 10px;
    padding: 8px 10px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: #0f172a;
    background: #f8fafc; resize: vertical; outline: none;
  }
  .db-field textarea:focus, .db-field input:focus { border-color: #059669; box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.15); }
  .db-note { margin: 0 0 12px; font-size: 11px; color: #64748b; line-height: 1.45; }
  .db-error {
    margin: 0 0 12px; padding: 8px 12px; border-radius: 10px; font-size: 12px;
    background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.4); color: #b91c1c;
  }
  .db-progress { margin: 0 0 12px; font-size: 12px; color: #047857; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .db-actions { display: flex; align-items: center; gap: 10px; }
  .db-spacer { flex: 1; }
  .db-secondary, .db-primary {
    border-radius: 999px; padding: 7px 16px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1.5px solid #cbd5e1;
    background: transparent; color: #475569;
  }
  .db-secondary:hover { border-color: #94a3b8; color: #0f172a; }
  .db-primary { background: #059669; border-color: #059669; color: #fff; }
  .db-primary:hover:not(:disabled) { background: #047857; }
  .db-primary:disabled { opacity: 0.6; cursor: wait; }

  .db-toast {
    position: absolute; top: calc(var(--nav-h) * var(--nav-scale) + 12px); left: 50%; transform: translateX(-50%); z-index: 40;
    display: inline-flex; align-items: center; gap: 10px;
    padding: 7px 14px; border-radius: 999px; font-size: 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace;
    background: #ffffff; color: #047857; border: 1px solid rgba(5, 150, 105, 0.45);
    box-shadow: 0 8px 22px rgba(15, 23, 42, 0.18); white-space: nowrap; max-width: calc(100vw - 40px); overflow: hidden; text-overflow: ellipsis;
  }
  .db-toast.err { color: #b91c1c; border-color: rgba(239, 68, 68, 0.5); }
  .db-toast-x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 11px; padding: 0 2px; }

  .db-info {
    position: absolute; top: calc(var(--nav-h) * var(--nav-scale) + 12px); left: 14px; z-index: 20;
    width: 430px; max-width: calc(100vw - 28px); box-sizing: border-box;
    padding: 12px 14px 12px; border-radius: 14px;
    background: rgba(15, 23, 42, 0.86); color: #e2e8f0; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(148, 163, 184, 0.25); box-shadow: 0 16px 40px rgba(15, 23, 42, 0.35);
    font-size: 11px; line-height: 1.4;
  }
  .db-info-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .db-info-title { flex: 1; font-size: 13px; font-weight: 600; color: #f8fafc; }
  .db-info-code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; color: #94a3b8; font-weight: 500; margin-left: 4px; }
  .db-info .db-x { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
  .db-info .db-x:hover { background: rgba(148, 163, 184, 0.35); color: #fff; }
  .db-info-grid { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin-bottom: 8px; }
  .db-info-grid span:nth-child(odd) { font-size: 9px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: #64748b; align-self: baseline; }
  .db-policies { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  .db-policies th { text-align: left; font-size: 9px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: #64748b; padding: 4px 6px 4px 0; border-bottom: 1px solid rgba(148, 163, 184, 0.25); }
  .db-policies td { padding: 5px 6px 5px 0; vertical-align: top; border-bottom: 1px solid rgba(148, 163, 184, 0.12); }
  .db-pol { display: block; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #6ee7b7; }
  .db-zones { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #cbd5e1; }
  .db-dim { color: #94a3b8; }
  .db-warn { color: #fb7185; }
  .db-line { margin-top: 7px; }

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
