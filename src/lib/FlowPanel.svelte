<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { flowState, FLOW_STAGES } from './blockStackFlow';

  // Presentation panel for the guided FLD-69 walk-through. Pure view: everything it
  // shows comes from the flowState store; every control is an event the scene
  // forwards to the flow engine.
  const dispatch = createEventDispatcher<{
    next: void; restart: void; auto: void; follow: void; close: void; pause: void; pov: void; speed: number; scenario: string;
  }>();
  // True while the scene is in walk mode (the picker's-eye camera).
  export let pov = false;

  const SPEEDS = [1, 2, 4];
  $: st = $flowState;
  $: stageIdx = FLOW_STAGES.indexOf(st.stage);
  $: nextDisabled = st.busy || (st.isLast && false);
  $: truckOut = st.stepIndex >= 2; // the forklift is on the floor from the putaway on
  function cycleSpeed() {
    dispatch('speed', SPEEDS[(SPEEDS.indexOf(st.speed) + 1) % SPEEDS.length]);
  }
</script>

<aside class="flow" transition:fade={{ duration: 160 }}>
  <header class="fp-head">
    <span class="fp-badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="13" width="7" height="7" rx="1" /><rect x="3" y="4" width="7" height="7" rx="1" /><rect x="14" y="13" width="7" height="7" rx="1" />
        <path d="M14 8h7M17.5 4.5 21 8l-3.5 3.5" />
      </svg>
    </span>
    <div class="fp-title">
      <span class="fp-label">Block stack · FLD-69</span>
      <span class="fp-name">{st.stage}</span>
    </div>
    <span class="fp-step">step {st.stepIndex + 1}<span class="fp-dim">/{st.stepCount}</span></span>
    <button class="fp-close" on:click={() => dispatch('close')} title="Close the walk-through" aria-label="Close">✕</button>
  </header>

  <!-- Stage rail: where we are in policies → putaway → allocation → picking → complete -->
  <ol class="fp-rail">
    {#each FLOW_STAGES as s, i}
      <li class:done={i < stageIdx} class:current={i === stageIdx}>
        <span class="rail-dot"></span><span class="rail-name">{s}</span>
      </li>
    {/each}
  </ol>

  <div class="fp-body">
    <h2 class="fp-h">{st.title}</h2>
    <p class="fp-text">{st.body}</p>

    {#if st.notice}
      <div class="fp-notice {st.notice.kind}" transition:fade={{ duration: 120 }}>
        <span class="fn-title">{st.notice.title}</span>
        <span class="fn-text">{st.notice.text}</span>
      </div>
    {/if}

    {#if st.prompt}
      <div class="fp-prompt">
        <span class="fp-pointer" aria-hidden="true">☞</span>{st.prompt}
      </div>
    {/if}

    {#if st.scenarios.length}
      <div class="fp-scen">
        <div class="fs-title">Try a scenario</div>
        <div class="fs-row">
          {#each st.scenarios as sc (sc.id)}
            <button class="fs-btn" disabled={!sc.enabled || st.busy} title={sc.hint} on:click={() => dispatch('scenario', sc.id)}>{sc.label}</button>
          {/each}
        </div>
      </div>
    {/if}

    {#if st.table}
      <div class="fp-table">
        <div class="ft-row ft-head">
          {#each st.table.head as h}<span>{h}</span>{/each}
        </div>
        {#each st.table.rows as r, i}
          <div class="ft-row" class:mark={st.table.mark?.includes(i)}>
            {#each r as c}<span>{c}</span>{/each}
          </div>
        {/each}
      </div>
    {/if}

    {#if st.ledger.length}
      <div class="fp-ledger">
        <div class="fl-title">Ledger</div>
        {#each st.ledger as l}
          <div class="fl-row">
            <span class="fl-subject">{l.subject}</span>
            <span class="fl-before">{l.before}</span>
            <span class="fl-arrow">→</span>
            <span class="fl-after">{l.after}</span>
          </div>
        {/each}
      </div>
    {/if}

    {#if st.facts.length}
      <ul class="fp-facts">
        {#each st.facts as f}<li>{f}</li>{/each}
      </ul>
    {/if}

    {#if st.totals.length}
      <!-- Live ledger for the story zone: allocation and swap only move cases between
           AVAILABLE and ALLOCATED; only the pick changes T. -->
      <div class="fp-totals">
        <div class="tt-row tt-head"><span>Zone {st.totalsZone} · class</span><span>Pallets</span><span>Avail</span><span>Alloc</span><span>T</span></div>
        {#each st.totals as t (t.label)}
          <div class="tt-row" class:story={t.story}>
            <span>{t.label} <i>{t.hash}</i></span><span>{t.pallets}</span><span>{t.available}</span><span>{t.allocated}</span><span>{t.available + t.allocated}</span>
          </div>
        {/each}
        <div class="tt-note">cases · T = AVAILABLE + ALLOCATED</div>
      </div>
    {/if}
  </div>

  <footer class="fp-foot">
    {#if st.status}
      <div class="fp-status"><span class="fp-pulse" class:busy={st.busy && !st.paused} class:paused={st.paused}></span>{st.paused ? 'Paused · ' : ''}{st.status}</div>
    {/if}
    <div class="fp-actions">
      <button class="fp-btn" on:click={() => dispatch('restart')} title="Reset the stock and start again">Restart</button>
      <button class="fp-btn" class:on={st.auto} on:click={() => dispatch('auto')} title="Run the whole flow hands-free">
        Auto-play {st.auto ? 'on' : 'off'}
      </button>
      <button class="fp-btn" on:click={cycleSpeed} title="Playback and truck speed">{st.speed}×</button>
      <button class="fp-btn" class:on={st.follow} on:click={() => dispatch('follow')} title="Camera rides with the truck">Follow</button>
      {#if truckOut}
        <button class="fp-btn" class:on={pov} on:click={() => dispatch('pov')}
          title={pov ? 'Back to the overview camera' : "Stand beside the truck at eye height — drag to look, W/S to walk, Q/E for height"}>
          {pov ? 'Overview' : "Picker's view"}
        </button>
      {/if}
      {#if st.isLast}
        <button class="fp-btn primary" on:click={() => dispatch('restart')}>Restart ↺</button>
      {:else if st.busy}
        <!-- The truck is moving: the main button freezes / releases it (Space does too). -->
        <button class="fp-btn primary" class:paused={st.paused} on:click={() => dispatch('pause')} title="Pause or resume the forklift (Space)">
          {st.paused ? '▶ Resume' : '❚❚ Pause'}
        </button>
      {:else}
        <button class="fp-btn primary" disabled={nextDisabled} on:click={() => dispatch('next')}>
          {st.nextLabel + ' →'}
        </button>
      {/if}
    </div>
  </footer>
</aside>

<style>
  .flow {
    position: absolute;
    top: 14px;
    left: 14px;
    z-index: 12;
    width: 430px;
    max-width: calc(100% - 28px);
    max-height: calc(100% - 28px);
    display: flex;
    flex-direction: column;
    transform: scale(0.82);
    transform-origin: top left;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(9, 14, 26, 0.95));
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1.5px solid #334155;
    border-radius: 16px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    overflow: hidden;
  }
  .fp-head {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 14px 10px 16px;
    background: linear-gradient(90deg, rgba(245, 158, 11, 0.14), rgba(245, 158, 11, 0));
    border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  }
  .fp-badge {
    flex: none; display: grid; place-items: center;
    width: 34px; height: 34px; border-radius: 9px;
    color: #fbbf24; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.4);
  }
  .fp-badge svg { width: 19px; height: 19px; }
  .fp-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .fp-label { font-size: 9.5px; font-weight: 600; letter-spacing: 1.6px; text-transform: uppercase; color: #64748b; }
  .fp-name { font-size: 18px; font-weight: 700; letter-spacing: 0.4px; color: #f8fafc; line-height: 1.05; }
  .fp-step { margin-left: auto; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #cbd5e1; white-space: nowrap; }
  .fp-dim { color: #64748b; }
  .fp-close {
    flex: none; width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
    color: #cbd5e1; background: rgba(148, 163, 184, 0.12); border: 1px solid rgba(148, 163, 184, 0.2);
    font-size: 13px; line-height: 1; transition: background 0.15s, color 0.15s;
  }
  .fp-close:hover { background: rgba(239, 68, 68, 0.2); color: #fecaca; }

  .fp-rail {
    display: flex; margin: 0; padding: 10px 14px 8px; list-style: none; gap: 4px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  }
  .fp-rail li { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px; position: relative; }
  .fp-rail li:not(:last-child)::after {
    content: ''; position: absolute; top: 5px; left: 50%; width: 100%; height: 2px;
    background: #334155; z-index: 0;
  }
  .fp-rail li.done:not(:last-child)::after { background: #f59e0b; }
  .rail-dot {
    position: relative; z-index: 1; width: 12px; height: 12px; border-radius: 50%;
    background: #1e293b; border: 2px solid #475569;
  }
  .fp-rail li.done .rail-dot { background: #f59e0b; border-color: #f59e0b; }
  .fp-rail li.current .rail-dot { background: #fff7ed; border-color: #f59e0b; box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.25); }
  .rail-name { font-size: 9.5px; letter-spacing: 0.6px; text-transform: uppercase; color: #64748b; white-space: nowrap; }
  .fp-rail li.current .rail-name { color: #fbbf24; font-weight: 700; }
  .fp-rail li.done .rail-name { color: #cbd5e1; }

  .fp-body { padding: 12px 16px 6px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #334155 transparent; }
  .fp-body::-webkit-scrollbar { width: 8px; }
  .fp-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 999px; }
  .fp-h { margin: 0 0 6px; font-size: 16px; font-weight: 700; color: #f8fafc; letter-spacing: 0.2px; }
  .fp-text { margin: 0; font-size: 12.5px; line-height: 1.5; color: #cbd5e1; }
  .fp-facts { margin: 10px 0 0; padding-left: 16px; font-size: 11.5px; line-height: 1.45; color: #94a3b8; }
  .fp-facts li { margin: 3px 0; }
  .fp-facts li::marker { color: #f59e0b; }

  .fp-table {
    margin-top: 10px; border: 1px solid rgba(148, 163, 184, 0.16); border-radius: 10px; overflow: hidden;
    font-family: ui-monospace, Menlo, monospace; font-size: 11px;
  }
  .ft-row { display: grid; grid-template-columns: 1.1fr 0.7fr 1.6fr 2.2fr; gap: 8px; padding: 5px 10px; align-items: baseline; }
  .ft-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cbd5e1; }
  .ft-head { background: rgba(148, 163, 184, 0.08); }
  .ft-head span { font-size: 9px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #64748b; }
  .ft-row:not(.ft-head):nth-child(even) { background: rgba(148, 163, 184, 0.04); }
  .ft-row.mark { background: rgba(34, 197, 94, 0.12); }
  .ft-row.mark span { color: #bbf7d0; }

  .fp-ledger { margin-top: 10px; padding: 8px 10px 6px; border-radius: 10px; background: rgba(56, 189, 248, 0.06); border: 1px solid rgba(56, 189, 248, 0.22); }
  .fl-title { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #7dd3fc; margin-bottom: 4px; }
  .fl-row { display: grid; grid-template-columns: minmax(90px, 0.9fr) 1.2fr auto 1.4fr; gap: 6px; padding: 3px 0; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; line-height: 1.35; align-items: baseline; }
  .fl-row + .fl-row { border-top: 1px dashed rgba(148, 163, 184, 0.12); }
  .fl-subject { color: #f1f5f9; font-weight: 700; }
  .fl-before { color: #94a3b8; }
  .fl-arrow { color: #38bdf8; }
  .fl-after { color: #e2e8f0; }

  .fp-notice { margin-top: 10px; padding: 9px 11px; border-radius: 10px; display: flex; flex-direction: column; gap: 3px; }
  .fp-notice.ok { background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.4); }
  .fp-notice.deny { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.45); }
  .fp-notice.info { background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.35); }
  .fn-title { font-size: 12px; font-weight: 700; letter-spacing: 0.2px; }
  .fp-notice.ok .fn-title { color: #86efac; }
  .fp-notice.deny .fn-title { color: #fca5a5; }
  .fp-notice.info .fn-title { color: #7dd3fc; }
  .fn-text { font-size: 11.5px; line-height: 1.45; color: #cbd5e1; }

  .fp-prompt {
    margin-top: 10px; padding: 9px 11px; border-radius: 10px;
    background: rgba(245, 158, 11, 0.1); border: 1px dashed rgba(245, 158, 11, 0.55);
    font-size: 12px; line-height: 1.45; color: #fde68a; display: flex; gap: 8px; align-items: flex-start;
  }
  .fp-pointer { flex: none; font-size: 15px; line-height: 1.1; color: #fbbf24; }

  /* Scenario strip: one click sets up and scans the pallet for that outcome. */
  .fp-scen { margin-top: 10px; }
  .fs-title { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #64748b; margin-bottom: 6px; }
  .fs-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .fs-btn {
    cursor: pointer; padding: 5px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
    color: #e2e8f0; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.35);
    transition: background 0.15s, color 0.15s;
  }
  .fs-btn:hover:not(:disabled) { background: rgba(56, 189, 248, 0.25); color: #f8fafc; }
  .fs-btn:disabled { opacity: 0.4; cursor: default; }

  /* Zone ledger */
  .fp-totals {
    margin-top: 12px; padding: 8px 10px 6px; border-radius: 10px;
    background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.28);
    font-family: ui-monospace, Menlo, monospace; font-size: 10.5px;
  }
  .tt-row { display: grid; grid-template-columns: 2.4fr 0.8fr 0.8fr 0.8fr 0.7fr; gap: 6px; padding: 3px 0; align-items: baseline; color: #cbd5e1; }
  .tt-row span:not(:first-child) { text-align: right; }
  .tt-head span { font-size: 9px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #64748b; }
  .tt-row.story { color: #fde68a; font-weight: 700; }
  .tt-row i { font-style: normal; color: #64748b; font-weight: 400; margin-left: 4px; }
  .tt-row.story i { color: #b45309; }
  .tt-note { margin-top: 4px; font-size: 9px; letter-spacing: 0.4px; color: #64748b; text-align: right; }

  .fp-foot { padding: 8px 14px 12px; border-top: 1px solid rgba(148, 163, 184, 0.14); display: flex; flex-direction: column; gap: 8px; }
  .fp-status { display: flex; align-items: center; gap: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #cbd5e1; }
  .fp-pulse { width: 8px; height: 8px; border-radius: 50%; background: #64748b; flex: none; }
  .fp-pulse.busy { background: #fbbf24; animation: fp-blink 1.1s ease-in-out infinite; }
  .fp-pulse.paused { background: #fbbf24; }
  @keyframes fp-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .fp-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .fp-btn {
    cursor: pointer; padding: 6px 11px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
    color: #cbd5e1; background: rgba(148, 163, 184, 0.1); border: 1px solid rgba(148, 163, 184, 0.28);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .fp-btn:hover { background: rgba(148, 163, 184, 0.2); color: #f8fafc; }
  .fp-btn.on { color: #fbbf24; border-color: rgba(245, 158, 11, 0.6); background: rgba(245, 158, 11, 0.12); }
  .fp-btn.primary { margin-left: auto; color: #1c1200; background: #f59e0b; border-color: #f59e0b; }
  .fp-btn.primary:hover { background: #fbbf24; }
  .fp-btn.primary:disabled { opacity: 0.55; cursor: default; background: #b45309; border-color: #b45309; color: #fde68a; }
  .fp-btn.primary.paused { background: #22c55e; border-color: #22c55e; color: #052e16; }
  .fp-btn.primary.paused:hover { background: #4ade80; }
</style>
