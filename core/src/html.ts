// The shell every server-rendered page shares: consent, invite and room.
// It follows taasky-portal/DESIGN.md in the night register: the plum frame
// round a near-black sheet lit by a champagne beam, grain, hairlines instead
// of boxes, Instrument Serif headlines whose second line is italic champagne,
// mono eyebrows, one champagne button per view. Fonts and images are served
// from public/ by Workers static assets.
//
// Pages are plain HTML with one small script at most; anything another party
// wrote — client names, schema labels, terms — goes through escapeHtml.

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

const STYLE = `
  @font-face { font-family: "Inter"; src: url(/fonts/Inter.woff2) format("woff2"); font-weight: 100 900; font-display: swap; }
  @font-face { font-family: "Instrument Serif"; src: url(/fonts/InstrumentSerif.woff2) format("woff2"); font-display: swap; }
  @font-face { font-family: "Instrument Serif"; font-style: italic; src: url(/fonts/InstrumentSerif-Italic.woff2) format("woff2"); font-display: swap; }
  @font-face { font-family: "JetBrains Mono"; src: url(/fonts/JetBrainsMono.woff2) format("woff2"); font-weight: 100 800; font-display: swap; }

  :root {
    color-scheme: dark;
    --frame: #4a2f4a; --night: #1a0f1a; --night-raised: #241624; --night-rule: #3a2738;
    --moon: #f3ece2; --moon-muted: #bfb1b7; --moon-subtle: #8d7d87;
    --champagne: #d9b98a; --champagne-bright: #ecd3a8;
    --accent: #4f3bd6; --accent-soft: #6f5ce8; --success: #0f7a52; --danger: #b03a2e; --amber: #9a6b12;
    --ease: cubic-bezier(.22, 1, .36, 1);
    --you: 242,160,70; --them: 120,110,240;
    --sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --serif: "Instrument Serif", "Iowan Old Style", Georgia, serif;
    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    --glow: linear-gradient(90deg, transparent, color-mix(in oklab, var(--champagne) 55%, transparent) 30%, color-mix(in oklab, var(--champagne) 55%, transparent) 70%, transparent);
  }
  * { box-sizing: border-box; }
  html { background: var(--frame); }
  body { margin: 0; font: 17px/1.65 var(--sans); color: var(--moon); background: var(--frame);
         -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  ::selection { background: color-mix(in oklab, var(--accent) 35%, transparent); }
  :focus-visible { outline: 2px solid var(--accent-soft); outline-offset: 3px; }

  /* The sheet: night, a champagne beam from the upper right, plum from below, grain over all. */
  .sheet { position: relative; isolation: isolate; overflow-x: clip; min-height: calc(100vh - 20px); margin: 10px;
           display: flex; flex-direction: column;
           background:
             radial-gradient(60% 55% at 78% 22%, color-mix(in oklab, var(--champagne) 22%, transparent), transparent 70%),
             radial-gradient(70% 60% at 12% 92%, #4a2f4a, transparent 70%),
             var(--night); }
  .sheet::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
                   background-image: ${GRAIN}; opacity: .08; mix-blend-mode: overlay; }
  .wrap { width: 100%; max-width: 1400px; margin: 0 auto; padding-left: clamp(24px, 4vw, 40px); padding-right: clamp(24px, 4vw, 40px); }
  .narrow { max-width: calc(40rem + 80px); }

  /* The header: night, 74px, sticky, a hairline under it. */
  .top { position: sticky; top: 0; z-index: 10; border-bottom: 1px solid var(--night-rule);
         background: color-mix(in oklab, var(--night) 82%, transparent); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
  .local-mode { background: #ffd23f; color: #1d1600; text-align: center; font-size: 15px; line-height: 1.4; padding: .55rem 1rem; }
  .local-mode b { letter-spacing: .08em; margin-right: .6rem; }
  .top .wrap { height: 74px; display: flex; align-items: center; justify-content: space-between; }
  a.brand { display: flex; align-items: center; gap: .7rem; color: var(--moon); text-decoration: none; font-size: 1.15rem; letter-spacing: -.01em; }
  main { flex: 1; padding-top: clamp(3rem, 8vh, 6rem); padding-bottom: clamp(4rem, 10vh, 6rem); }
  footer .wrap { border-top: 1px solid var(--night-rule); padding-top: 1.4rem; padding-bottom: 1.8rem; display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
                 font: 11px/1.6 var(--mono); text-transform: uppercase; letter-spacing: .2em; color: var(--moon-subtle); }
  footer a { color: inherit; }
  footer .links { display: flex; gap: 1.6rem; }

  .eyebrow { font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .22em; color: var(--champagne); margin: 0 0 1.4rem; }
  .eyebrow.quiet { color: var(--moon-subtle); }
  /* The headline pattern: two lines, the second italic champagne. Never bold. */
  h1 { font: 400 clamp(2.9rem, 5.4vw, 4.6rem)/.98 var(--serif); letter-spacing: -.02em; margin: 0 0 1.6rem; color: var(--moon); text-wrap: balance; }
  h1 em, h2 em { display: block; font-style: italic; color: var(--champagne-bright); }
  h2 { font: 400 clamp(2rem, 3vw, 2.6rem)/1.04 var(--serif); letter-spacing: -.015em; margin: 0 0 1.2rem; }
  p { margin: .75rem 0; color: var(--moon-muted); }
  .lede { font-size: clamp(1.05rem, 1.3vw, 1.2rem); line-height: 1.65; max-width: 34rem; }
  .aside { color: var(--moon-subtle); font-size: .95rem; margin-top: -.4rem; max-width: 34rem; }
  strong { color: var(--moon); font-weight: 500; }
  small { font-size: .88rem; color: var(--moon-subtle); }
  a { color: var(--champagne-bright); text-underline-offset: 3px; }
  code { font: .85em var(--mono); background: var(--night-raised); border: 1px solid var(--night-rule); padding: .1em .45em; border-radius: 6px; color: var(--champagne-bright); }
  .notice { border-left: 2px solid var(--champagne); padding: .2rem 0 .2rem 1rem; color: var(--moon); margin: 1.5rem 0; max-width: 34rem; }
  .rule-glow { height: 1px; border: 0; margin: 3rem 0; background: var(--glow); }

  /* Reading layout: a prose column and a sticky aside, a vertical hairline between. */
  .split { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); align-items: start; }
  .split > section { padding-right: clamp(2.5rem, 5vw, 5rem); }
  .split > aside { position: sticky; top: calc(74px + 2rem); padding-left: clamp(2.5rem, 5vw, 5rem); border-left: 1px solid var(--night-rule); }
  @media (max-width: 920px) {
    .split { grid-template-columns: minmax(0, 1fr); }
    .split > section { padding-right: 0; }
    .split > aside { position: static; padding-left: 0; border-left: 0; border-top: 1px solid var(--night-rule); margin-top: 3rem; padding-top: 3rem; }
  }

  /* Plates: photographs numbered like a book. */
  figure { margin: 0; }
  figure .plate { overflow: hidden; border: 1px solid var(--night-rule); background: #000; box-shadow: 0 60px 140px -60px rgba(0,0,0,.9); }
  figure img { display: block; width: 100%; height: auto; aspect-ratio: 3 / 2; object-fit: cover; animation: settle 1.8s var(--ease) both; }
  @media (min-width: 921px) { aside > figure:only-child img { aspect-ratio: 4 / 5; } }
  figcaption { margin-top: .9rem; display: flex; justify-content: space-between; gap: 1rem;
               font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .18em; color: var(--moon-subtle); }

  /* Facts: label in eyebrow mono, value in serif, under a glowing rule. */
  .facts { margin: 0 0 2rem; }
  .facts > div { padding: 1.1rem 0 1.15rem; background: var(--glow) top / 100% 1px no-repeat; }
  .facts > div:last-child { background: var(--glow) top / 100% 1px no-repeat, var(--glow) bottom / 100% 1px no-repeat; }
  .facts dt { font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .22em; color: var(--moon-subtle); margin-bottom: .45rem; }
  .facts dd { margin: 0; font: 400 clamp(1.55rem, 2.2vw, 1.9rem)/1.15 var(--serif); color: var(--moon); overflow-wrap: anywhere; }
  .facts dd .to { color: var(--moon-subtle); }
  /* A reconciliation as a review: the conclusion and points left, the call right. */
  .review { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 0; align-items: start; padding: 1.5rem 0 3rem; }
  .review-main { padding-right: clamp(1.5rem, 3vw, 2.5rem); border-right: 1px solid var(--night-rule); min-width: 0; }
  .review-main .topic { font: 12px/1.5 var(--mono); color: var(--moon-subtle); margin: 0 0 .6rem; }
  .review-main h1 { font: 700 clamp(1.5rem, 2.4vw, 1.85rem)/1.3 var(--sans); letter-spacing: 0; margin: 0 0 1.2rem; max-width: 46rem; text-wrap: pretty; }
  .review-main h2 { font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .18em; color: var(--moon-subtle); margin: 1.8rem 0 .6rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 1.2rem; }
  .chip { font: 12px/1 var(--mono); padding: .45rem .7rem; border-radius: 6px; }
  .chip.agreed { background: color-mix(in oklab, var(--success) 25%, transparent); color: #7fd1a6; }
  .chip.disputed { background: color-mix(in oklab, var(--danger) 25%, transparent); color: #f08a7e; }
  .chip.open, .chip.proposed { background: color-mix(in oklab, var(--amber) 30%, transparent); color: #e3b55a; }
  .points { list-style: none; margin: 0; padding: 0; border: 1px solid var(--night-rule); border-radius: 10px; overflow: hidden; }
  .points li { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: .2rem 1rem; padding: .8rem 1.1rem; border-top: 1px solid var(--night-rule); font-size: 15px; line-height: 1.5; }
  .points li:first-child { border-top: 0; }
  .points li.disputed { background: var(--night-raised); }
  .points .fid { font: 12px/1.9 var(--mono); grid-row: span 2; }
  .points .agreed .fid { color: #7fd1a6; } .points .disputed .fid { color: #f08a7e; } .points .open .fid, .points .proposed .fid { color: #e3b55a; }
  .points .why { grid-column: 2; color: var(--moon-subtle); font-size: 14px; }
  .next { margin: 0; padding-left: 1.2rem; font-size: 15px; }
  .review-side { padding-left: clamp(1.25rem, 2.5vw, 1.75rem); display: flex; flex-direction: column; gap: 1.8rem; font-size: 14px; }
  .review-side .eyebrow { margin: 0 0 .7rem; }
  .review-side .card-ask { margin: 0; padding: 1.2rem; border: 1px solid color-mix(in oklab, var(--champagne) 35%, var(--night-rule)); border-radius: 12px; background: color-mix(in oklab, var(--champagne) 6%, transparent); }
  .review-side .card-ask.quiet, .review-side .card-ask.settled { border-color: var(--night-rule); background: transparent; }
  .review-side .card-ask .actions { display: flex; flex-direction: column; gap: .5rem; }
  .review-side .card-ask .actions button { width: 100%; }
  .who, .went { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .55rem; }
  .who li, .went li { padding-left: 1.1rem; position: relative; color: var(--moon-muted); }
  .who li::before, .went li::before { content: ""; position: absolute; left: 0; top: .5em; width: 8px; height: 8px; border-radius: 50%; background: rgb(var(--you)); }
  .who li.them::before, .went li.them::before { background: rgb(var(--them)); }
  .went time { color: var(--moon-subtle); margin-right: .3rem; }
  .went small { display: block; color: var(--moon-subtle); }
  @media (max-width: 920px) {
    .review { grid-template-columns: minmax(0, 1fr); gap: 2rem; }
    .review-main { padding-right: 0; border-right: 0; }
    .review-side { padding-left: 0; }
  }
  @media (max-width: 480px) { .points li { grid-template-columns: minmax(0, 1fr); } .points .fid { grid-row: auto; } .points .why { grid-column: 1; } }
  .picture { text-align: center; padding: 1.4rem 0 1.8rem; }
  .picture .topic { font: 11px/1.5 var(--mono); text-transform: uppercase; letter-spacing: .18em; color: var(--moon-subtle); margin: 0 0 .9rem; }
  .picture .verdict { font: 700 clamp(1.3rem, 2.4vw, 1.75rem)/1.3 var(--sans); color: var(--moon); margin: 0 auto; max-width: 34ch; text-wrap: balance; }
  .picture .verdict.long { font: 600 1.05rem/1.5 var(--sans); text-align: left; max-width: 60ch; text-wrap: pretty; }
  .picture .verdict.pending { font-weight: 400; color: var(--moon-subtle); }
  .findings-box { margin: 0 0 1.6rem; background: var(--glow) top / 100% 1px no-repeat; padding-top: 1rem; }
  .findings-box summary { cursor: pointer; font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .22em; color: var(--champagne); padding: .2rem 0; }
  .findings-box[open] summary { margin-bottom: .9rem; }
  .findings-box dd { margin: 0; }
  .facts dd.findings { font: 400 1rem/1.5 var(--sans); }
  .facts dd.findings ol { list-style: none; margin: 0; padding: 0; display: grid; gap: .7rem; }
  .facts dd.findings .fid { font: 11px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--champagne); margin-right: .35rem; }
  .facts dd.findings li.agreed .fid { color: var(--moon-subtle); }
  .facts dd.findings small { display: block; font-size: .85rem; color: var(--moon-subtle); }
  ul.fields { list-style: none; padding: 0; margin: 2rem 0; max-width: 34rem; }
  ul.fields li { padding: .85rem 0; font: 400 1.6rem/1.2 var(--serif); color: var(--moon); background: var(--glow) top / 100% 1px no-repeat; }
  ul.fields li:last-child { background: var(--glow) top / 100% 1px no-repeat, var(--glow) bottom / 100% 1px no-repeat; }

  form { display: grid; gap: 1rem; margin: 0; }
  label, legend { display: grid; gap: .45rem; font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .2em; color: var(--moon-subtle); }
  label small { text-transform: none; letter-spacing: 0; font-family: var(--sans); }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: .55rem; }
  input, select { font: 15px/1.2 var(--sans); letter-spacing: 0; text-transform: none; color: var(--moon); background: var(--night-raised); width: 100%;
                  height: 48px; padding: 0 .95rem; border: 1px solid var(--night-rule); border-radius: 12px; }
  input:hover, select:hover { border-color: color-mix(in oklab, var(--moon) 25%, transparent); }
  input:focus, select:focus { border-color: var(--accent-soft); outline: none; box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 30%, transparent); }
  label.check { display: flex; align-items: center; gap: .7rem; font: 15px/1.4 var(--sans); letter-spacing: 0; text-transform: none; color: var(--moon); }
  label.check input { width: 20px; height: 20px; padding: 0; accent-color: var(--accent); }
  .with { font: 15px/1.4 var(--sans); color: var(--moon); margin: -.6rem 0 1.4rem; }
  .with .mark { font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .18em; color: var(--champagne); margin-left: .5rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; }
  @media (max-width: 480px) { .row { grid-template-columns: 1fr; } }

  /* Pills. Smoked glass by default; champagne for the one lit action in view. */
  button, .button { position: relative; isolation: isolate; overflow: hidden; display: inline-flex; align-items: center;
           justify-content: center; gap: .55rem; height: 3rem; padding: 0 1.75rem; border-radius: 999px; width: 100%;
           font: 500 15px/1 var(--sans); letter-spacing: -.005em; cursor: pointer; text-decoration: none; white-space: nowrap;
           color: var(--moon); border: 1px solid color-mix(in oklab, var(--moon) 20%, transparent); background: color-mix(in oklab, var(--moon) 4%, transparent);
           -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
           transition: box-shadow .3s, border-color .3s, color .3s, background-color .3s, transform .15s; }
  button:hover, .button:hover { border-color: color-mix(in oklab, var(--champagne) 60%, transparent); color: var(--champagne-bright); background-color: color-mix(in oklab, var(--moon) 8%, transparent); }
  button:active, .button:active { transform: scale(.98); }
  .inline { width: auto; }
  .primary { border: 0; color: var(--night);
             background: linear-gradient(180deg, #f1dcb6 0%, #d9b98a 55%, #c29d6b 100%);
             box-shadow: inset 0 1px 0 rgba(255,255,255,.6), inset 0 -1px 0 rgba(90,58,30,.25), 0 0 0 1px rgba(236,211,168,.35), 0 12px 40px -12px rgba(217,185,138,.6); }
  .primary:hover { color: var(--night); box-shadow: inset 0 1px 0 rgba(255,255,255,.7), inset 0 -1px 0 rgba(90,58,30,.25), 0 0 0 1px rgba(236,211,168,.55), 0 16px 50px -10px rgba(217,185,138,.75); }
  .primary::after { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
             background: linear-gradient(105deg, transparent 30%, rgba(255,255,255,.35) 48%, rgba(255,255,255,.05) 56%, transparent 70%);
             transform: translateX(-120%); transition: transform .9s var(--ease); }
  .primary:hover::after { transform: translateX(120%); }
  .arrow { display: inline-block; transition: transform .3s var(--ease); }
  button:hover .arrow, .button:hover .arrow { transform: translateX(2px); }
  .ghost { width: auto; height: auto; padding: .4rem 0; border: 0; background: none; -webkit-backdrop-filter: none; backdrop-filter: none; color: var(--moon-subtle);
           font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .2em; justify-content: flex-start; }
  .ghost:hover { background: none; color: #e07a6e; }
  .actions { display: grid; gap: .7rem; }
  .options { display: grid; gap: .6rem; }
  .options button { height: auto; min-height: 3rem; padding: .85rem 1.25rem; white-space: normal; text-align: center; line-height: 1.35; }
  .cta { max-width: 24rem; margin: 2.25rem 0 1rem; }

  details { margin-top: .7rem; }
  details > summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: .5rem; height: 3rem;
                      border-radius: 999px; border: 1px solid color-mix(in oklab, var(--moon) 20%, transparent); color: var(--moon); font: 500 15px/1 var(--sans); }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::after { content: "+"; color: var(--moon-subtle); }
  details[open] > summary::after { content: "–"; }
  details > summary:hover { color: var(--champagne-bright); border-color: color-mix(in oklab, var(--champagne) 60%, transparent); }
  details[open] > summary { margin-bottom: 1.6rem; }

  /* Two agents as two spheres, ribbons of light between them. Whoever moves
     next is lit and ringed, the other rests in shadow, and light runs along
     the ribbons toward the one who has to answer. On agreement both light,
     the ribbons turn to solid champagne and the meeting point blooms. */
  .duo { position: relative; display: grid; grid-template-columns: auto 1fr auto; align-items: start; gap: 1.25rem;
         margin: 3rem 0 0; max-width: 36rem; --near: 0;
         /* The spheres draw in from the edges as the room moves (duo's near). */
         padding-inline: calc(var(--near) * min(4.5rem, 9vw)); transition: padding-inline 1.4s var(--ease); }
  .party { position: relative; display: grid; justify-items: center; gap: .9rem; font: 11px/1 var(--mono);
           text-transform: uppercase; letter-spacing: .22em; color: var(--moon-subtle); transition: color .9s var(--ease), opacity .9s var(--ease); }
  .sphere { position: relative; width: 72px; height: 72px; border-radius: 50%;
            transition: box-shadow 1.2s var(--ease), transform 1.2s var(--ease), filter 1.2s var(--ease); }
  .you .sphere { background: radial-gradient(circle at 34% 30%, #fff1d2, #f6be6a 26%, #d9761f 62%, #4a1c05 100%); }
  .them .sphere { background: radial-gradient(circle at 34% 30%, #eef0ff, #a7a9f6 26%, #5246d0 62%, #120d3c 100%); }
  .sphere::before, .sphere::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; opacity: 0; pointer-events: none; }

  .party.rest { opacity: .55; }
  .party.rest .sphere { filter: saturate(.35) brightness(.5); transform: scale(.82); }
  .party.live { color: var(--champagne-bright); }
  .party.live .sphere { transform: scale(1.12); animation: breathe 3.2s ease-in-out infinite; }
  .you.live .sphere { box-shadow: 0 0 0 1px rgba(var(--you),.6), 0 0 38px 6px rgba(var(--you),.75), 0 0 110px 34px rgba(var(--you),.35); }
  .them.live .sphere { box-shadow: 0 0 0 1px rgba(var(--them),.6), 0 0 38px 6px rgba(var(--them),.8), 0 0 110px 34px rgba(var(--them),.38); }
  /* Rings that keep leaving the live sphere, like a call that wants an answer. */
  .you.live .sphere::before, .you.live .sphere::after { border: 1.5px solid rgba(var(--you),.85); animation: ring 2.6s var(--ease) infinite; }
  .them.live .sphere::before, .them.live .sphere::after { border: 1.5px solid rgba(var(--them),.9); animation: ring 2.6s var(--ease) infinite; }
  .party.live .sphere::after { animation-delay: 1.3s; }
  .party .tag { display: none; font-size: 10px; color: var(--night); background: var(--champagne-bright); padding: .35rem .6rem; border-radius: 999px; letter-spacing: .18em; }
  .duo:not(.agreed) .party.live .tag { display: block; }

  .wave { width: 100%; height: 50px; overflow: visible; align-self: start; margin-top: 11px; }
  .wave path { fill: none; stroke-linecap: round; stroke-width: 1.4; opacity: .5; }
  .wave path.run { stroke-width: 2.2; stroke-dasharray: 3 14; opacity: .95; filter: drop-shadow(0 0 4px rgba(236,211,168,.9)); }
  .duo[data-live="you"] .wave path.run { animation: toYou 1.6s linear infinite; }
  .duo[data-live="them"] .wave path.run { animation: toThem 1.6s linear infinite; }
  .duo[data-live="none"] .wave path.run, .duo[data-live="pass"] .wave path.run { display: none; }

  /* Handing over the turn, on a live page: the mover lets go, a comet of
     light runs along both ribbons to the other side, and that sphere flares
     as it catches it. */
  .wave path.comet { stroke-width: 3.5; opacity: 0; stroke-dasharray: 22 200; filter: drop-shadow(0 0 5px rgba(255,243,220,.95)) drop-shadow(0 0 14px rgba(236,211,168,.7)); }
  .duo.passing[data-pass="toThem"] .wave path.comet { animation: cometToThem .9s cubic-bezier(.55, 0, .25, 1) both; }
  .duo.passing[data-pass="toYou"] .wave path.comet { animation: cometToYou .9s cubic-bezier(.55, 0, .25, 1) both; }
  .duo.passing .wave g:first-child path { animation: hum .9s ease-in-out; }
  .duo.passing .sphere { transition-duration: .9s; transition-timing-function: ease-in-out; }
  .duo.passing .you.rest .sphere::after { opacity: 0; border: 1.5px solid rgba(var(--you),.9); animation: ring 1s var(--ease) 1; }
  .duo.passing .them.rest .sphere::after { opacity: 0; border: 1.5px solid rgba(var(--them),.9); animation: ring 1s var(--ease) 1; }
  .party.caught .sphere { animation: flare 1.1s var(--ease), breathe 3.2s ease-in-out 1.1s infinite; }
  .duo:not(.agreed) .party.live .tag { animation: tagIn .7s var(--ease) .15s both; }
  @keyframes cometToThem { 0% { stroke-dashoffset: 22; opacity: 1; } 85% { opacity: 1; } 100% { stroke-dashoffset: -100; opacity: 0; } }
  @keyframes cometToYou { 0% { stroke-dashoffset: -100; opacity: 1; } 85% { opacity: 1; } 100% { stroke-dashoffset: 22; opacity: 0; } }
  @keyframes hum { 50% { opacity: .9; } }
  @keyframes flare { 0% { transform: scale(.82); filter: brightness(2.2) saturate(1.3); } 45% { transform: scale(1.28); filter: brightness(1.5); } 100% { transform: scale(1.12); filter: none; } }
  @keyframes tagIn { from { opacity: 0; transform: translateY(6px) scale(.92); } }

  /* Text that changes on a live page blurs out upward and the new text
     resolves in from below, instead of jumping. */
  main .leaving { animation: leave .24s ease-in both; }
  main .arriving { animation: resolve .85s var(--ease) both; }
  @keyframes leave { to { opacity: 0; transform: translateY(-8px); filter: blur(6px); } }
  @keyframes resolve { from { opacity: 0; transform: translateY(12px); filter: blur(8px); } }
  .duo[data-live="none"] .wave path { opacity: .2; }

  /* Agreement: both lit, the braid solid, a bloom where the ribbons meet. */
  .duo.agreed .party { color: var(--champagne-bright); opacity: 1; }
  .duo.agreed .sphere { transform: scale(1.1); animation: agree 1.4s var(--ease) both; }
  .duo.agreed .you .sphere { box-shadow: 0 0 0 1px rgba(var(--you),.7), 0 0 46px 10px rgba(var(--you),.8), 0 0 140px 44px rgba(var(--you),.35); }
  .duo.agreed .them .sphere { box-shadow: 0 0 0 1px rgba(var(--them),.7), 0 0 46px 10px rgba(var(--them),.85), 0 0 140px 44px rgba(var(--them),.4); }
  .duo.agreed .wave path { opacity: 1; stroke-width: 2; filter: drop-shadow(0 0 6px rgba(236,211,168,.95)); stroke-dasharray: 600; stroke-dashoffset: 600; animation: draw 1.6s var(--ease) .3s forwards; }
  .duo.agreed .wave path.run { display: none; }
  .bloom { position: absolute; left: 50%; top: 36px; width: 220px; height: 220px; transform: translate(-50%, -50%) scale(.2); border-radius: 50%; opacity: 0; pointer-events: none;
           background: radial-gradient(circle, rgba(255,246,226,.95) 0, rgba(236,211,168,.6) 10%, rgba(236,211,168,.18) 34%, transparent 65%); }
  .duo.agreed .bloom { animation: bloom 1.8s var(--ease) 1.2s forwards, glow 4.5s ease-in-out 3s infinite; }
  .duo .status { grid-column: 1 / -1; text-align: center; font: 12px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .26em; color: var(--moon-subtle); margin-top: 1rem; }
  .duo:not([data-live="none"]) .status { display: none; }
  .duo.agreed .status { color: var(--champagne-bright); font-size: 13px; }

  @keyframes ring { 0% { opacity: .9; transform: scale(1); } 100% { opacity: 0; transform: scale(2.3); } }
  @keyframes toYou { to { stroke-dashoffset: 34; } }
  @keyframes toThem { to { stroke-dashoffset: -34; } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes agree { 0% { filter: brightness(.5) saturate(.4); transform: scale(.85); } 60% { filter: brightness(1.5); transform: scale(1.2); } 100% { transform: scale(1.1); } }
  @keyframes bloom { to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
  @keyframes glow { 50% { opacity: .7; transform: translate(-50%, -50%) scale(.9); } }

  /* The terms as one framed sheet: a hairline frame with a second, fainter
     one inset, like a printed agreement. Agreed, the frame warms and the
     seal is pressed onto its lower corner. */
  .terms { position: relative; isolation: isolate; max-width: 34rem; margin: 0 0 2.5rem; padding: 1.5rem 1.75rem 1.25rem; border-radius: 18px;
           border: 1px solid color-mix(in oklab, var(--champagne) 40%, transparent);
           background: linear-gradient(180deg, rgba(243,236,226,.05), rgba(243,236,226,.012)), var(--night);
           box-shadow: inset 0 0 0 5px var(--night), inset 0 0 0 6px color-mix(in oklab, var(--champagne) 14%, transparent), 0 50px 110px -55px rgba(0,0,0,.95); }
  .terms-head, .terms-foot { display: flex; justify-content: space-between; gap: 1rem; font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .22em; color: var(--champagne); }
  .terms-head { margin-bottom: .9rem; }
  .terms-head span + span { color: var(--moon-subtle); }
  .terms-foot { margin-top: 1rem; color: var(--moon-subtle); min-height: 1.4em; }
  .terms .facts { margin: 0; }
  .terms .facts > div:last-child { background: var(--glow) top / 100% 1px no-repeat, var(--glow) bottom / 100% 1px no-repeat; }
  .terms h2 { margin-top: .5rem; }
  .terms.sealed { margin-bottom: 4.5rem; border-color: color-mix(in oklab, var(--champagne-bright) 70%, transparent);
                  box-shadow: inset 0 0 0 5px var(--night), inset 0 0 0 6px color-mix(in oklab, var(--champagne) 30%, transparent),
                              0 0 70px -18px rgba(236,211,168,.35), 0 50px 110px -55px rgba(0,0,0,.95);
                  animation: warm 1.2s var(--ease) 1.9s both; }
  .terms.sealed .terms-foot { color: var(--champagne-bright); }
  .terms.sealed::after { content: ""; position: absolute; right: -90px; bottom: -110px; width: 280px; height: 280px; pointer-events: none; z-index: -1;
                         background: radial-gradient(circle, rgba(236,211,168,.34), rgba(236,211,168,.08) 42%, transparent 68%);
                         animation: fade 1.2s var(--ease) 2.2s both; }
  .seal { position: absolute; right: -34px; bottom: -48px; z-index: 1; width: clamp(130px, 13vw, 168px); height: auto; pointer-events: none;
          transform: rotate(-14deg); filter: brightness(1.25) saturate(1.15) drop-shadow(0 20px 26px rgba(0,0,0,.7)) drop-shadow(0 0 2px rgba(236,211,168,.6));
          animation: stamp .7s cubic-bezier(.5, 0, .2, 1.4) 1.9s both; }
  @keyframes stamp { from { opacity: 0; transform: rotate(-30deg) scale(2.2); } 70% { opacity: 1; } to { opacity: 1; transform: rotate(-14deg) scale(1); } }
  @keyframes warm { from { border-color: color-mix(in oklab, var(--champagne) 40%, transparent); } }
  @media (max-width: 480px) { .terms { padding: 1.25rem 1.25rem 1.1rem; } .seal { right: -8px; bottom: -44px; width: 112px; } .terms.sealed::after { right: -40px; width: 200px; height: 200px; } }

  /* A live page: a term that just changed surfaces from below and glows
     champagne before settling; the frame catches the light once. */
  .facts dd.changed { animation: changed 1.8s var(--ease) both; }
  .terms.updated { animation: catch 1.6s var(--ease); }
  @keyframes changed { 0% { opacity: 0; transform: translateY(.45em); filter: blur(6px); }
                       35% { opacity: 1; transform: none; filter: none; color: var(--champagne-bright); text-shadow: 0 0 24px rgba(236,211,168,.8); }
                       100% { color: var(--moon); text-shadow: 0 0 0 transparent; } }
  @keyframes catch { 30% { border-color: var(--champagne-bright); box-shadow: inset 0 0 0 5px var(--night), inset 0 0 0 6px color-mix(in oklab, var(--champagne) 40%, transparent), 0 0 80px -16px rgba(236,211,168,.45), 0 50px 110px -55px rgba(0,0,0,.95); } }

  /* The moves: a thread down the left, a sphere-coloured bead per move. A
     move that arrives while the page is open slides in and its bead rings. */
  .moves { margin: 3rem 0 0; max-width: 36rem; }
  .moves ol { position: relative; list-style: none; padding: 0; margin: 0; }
  .moves ol::before { content: ""; position: absolute; left: 5px; top: 1.1rem; bottom: 1.1rem; width: 1px;
                      background: linear-gradient(180deg, rgba(var(--you),.5), rgba(236,211,168,.45), rgba(var(--them),.5)); }
  .moves li { position: relative; display: grid; grid-template-columns: 11px minmax(0, 1fr) auto; gap: 1rem; align-items: start; padding: .75rem 0; }
  .moves .dot { position: relative; width: 11px; height: 11px; margin-top: .5rem; border-radius: 50%; }
  .moves .you .dot { background: radial-gradient(circle at 34% 30%, #fff1d2, #f6be6a 40%, #d9761f); box-shadow: 0 0 12px 1px rgba(var(--you),.7); }
  .moves .them .dot { background: radial-gradient(circle at 34% 30%, #eef0ff, #a7a9f6 40%, #5246d0); box-shadow: 0 0 12px 1px rgba(var(--them),.75); }
  .moves .verb { margin: 0; font: 400 1.4rem/1.25 var(--serif); color: var(--moon); }
  .moves .what { margin: .2rem 0 0; font-size: .95rem; line-height: 1.5; color: var(--moon-muted); }
  .moves .what .label { font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .18em; color: var(--moon-subtle); margin-right: .3rem; }
  .moves .what .sep { color: var(--moon-subtle); }
  .moves .when { margin-top: .45rem; font: 11px/1.4 var(--mono); letter-spacing: .12em; color: var(--moon-subtle); white-space: nowrap; }
  .moves li.fresh { animation: arrive 1s var(--ease) both; }
  .moves li.fresh .verb { animation: changed 2s var(--ease) both; animation-delay: inherit; }
  .moves li.fresh .dot::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1.5px solid currentColor; opacity: 0;
                                animation: ring 1.4s var(--ease) 2; animation-delay: inherit; }
  .moves li.fresh.you .dot { color: rgb(var(--you)); }
  .moves li.fresh.them .dot { color: rgb(var(--them)); }
  @keyframes arrive { from { opacity: 0; transform: translateX(-14px); } }

  ul.agents { list-style: none; padding: 0; margin: 2rem 0; }
  ul.agents li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .9rem 0;
                 background: var(--glow) top / 100% 1px no-repeat; }
  ul.agents li:last-child { background: var(--glow) top / 100% 1px no-repeat, var(--glow) bottom / 100% 1px no-repeat; }
  ul.agents li div { display: grid; gap: .15rem; }
  ul.agents form { display: block; }
  .choices { display: grid; gap: 1.2rem; margin-top: 2.5rem; }
  .choices section { display: grid; gap: .6rem; padding: 1.4rem 1.5rem; border: 1px solid var(--night-rule); }
  .choices h2 { font-size: 1.6rem; margin: 0; }
  .choices p { margin: 0; }
  .side-note { margin-top: 3rem; padding-top: 1.75rem; border-top: 1px solid var(--night-rule); max-width: 34rem; display: grid; gap: .9rem; justify-items: start; }
  .side-note p { margin: 0; }
  .calendar { margin-top: 2rem; display: grid; gap: .8rem; justify-items: start; }
  .calendar-links { display: flex; flex-wrap: wrap; gap: .6rem; }

  /* The account: a book of chapters. A wide hero with the two spheres, then
     each chapter as a numeral and title on the left, its content on the right.
     Scoped to body.acct so the room, invite and consent pages stay as they are. */
  .acct main { padding-top: clamp(2.5rem, 6vh, 4.5rem); }
  .acct-hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: clamp(2.5rem, 6vw, 6rem); align-items: center; padding-bottom: clamp(3rem, 7vh, 5rem); }
  .acct-hero h1 { font-size: clamp(3.4rem, 7vw, 6.4rem); line-height: .94; margin-bottom: 1.8rem; }
  .acct-hero .lede { max-width: 30rem; }
  .acct-hero figure { max-width: 30rem; justify-self: end; width: 100%; }
  .acct-hero figure img { aspect-ratio: 4 / 5; }
  .tally { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); max-width: 30rem; margin: 2.6rem 0 0; }
  .tally > div { padding: 1rem 1.2rem 0 0; background: var(--glow) top / 100% 1px no-repeat; }
  .tally > div + div { padding-left: 1.2rem; border-left: 1px solid var(--night-rule); }
  .tally dt { font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .22em; color: var(--moon-subtle); }
  .tally dd { margin: .35rem 0 0; font: 400 clamp(2.4rem, 4vw, 3.4rem)/1 var(--serif); color: var(--moon); }
  .tally dd.lit { color: var(--champagne-bright); text-shadow: 0 0 28px rgba(236,211,168,.45); }

  .chapter { display: grid; grid-template-columns: minmax(0, 18rem) minmax(0, 1fr); gap: clamp(2rem, 5vw, 5rem);
             padding: clamp(3rem, 7vh, 4.5rem) 0; border-top: 1px solid var(--night-rule); }
  .chapter > header { position: sticky; top: calc(74px + 2rem); align-self: start; }
  .chapter .num { display: block; font: italic 400 clamp(3rem, 5vw, 4.4rem)/.9 var(--serif); color: var(--champagne);
                  text-shadow: 0 0 34px rgba(217,185,138,.35); margin-bottom: 1rem; }
  .chapter h2 { margin-bottom: .8rem; }
  .chapter header p { font-size: .95rem; max-width: 17rem; }
  .chapter .body { min-width: 0; max-width: 60rem; }
  .chapter .body > p:first-child { margin-top: 0; }

  /* Deals and agents as cards: a dark glass sheet, hairline frame, a bead for the state. */
  .cards { list-style: none; padding: 0; margin: 0; display: grid; gap: .8rem; }
  .cards li { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 1.1rem;
              padding: 1.15rem 1.35rem; border-radius: 18px; border: 1px solid var(--night-rule);
              background: linear-gradient(180deg, rgba(243,236,226,.045), rgba(243,236,226,.012)), color-mix(in oklab, var(--night) 70%, transparent);
              transition: border-color .3s, box-shadow .3s, transform .3s var(--ease); }
  .cards li:hover { border-color: color-mix(in oklab, var(--champagne) 45%, transparent); box-shadow: 0 30px 70px -40px rgba(0,0,0,.9), 0 0 40px -20px rgba(236,211,168,.25); transform: translateY(-1px); }
  .cards li > div { display: grid; gap: .2rem; min-width: 0; }
  .cards strong { font: 400 1.5rem/1.15 var(--serif); color: var(--moon); overflow-wrap: anywhere; }
  .cards small { font: 11px/1.5 var(--mono); text-transform: uppercase; letter-spacing: .14em; color: var(--moon-subtle); }
  .cards form { display: block; }
  .cards a.open { font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .2em; color: var(--champagne-bright); text-decoration: none; white-space: nowrap; }
  .cards a.open::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
  .bead { width: 12px; height: 12px; border-radius: 50%; }
  .bead.agreed { background: radial-gradient(circle at 34% 30%, #fff6e2, #ecd3a8 45%, #b8925c); box-shadow: 0 0 14px 2px rgba(236,211,168,.7); }
  .bead.awaiting { background: radial-gradient(circle at 34% 30%, #fff1d2, #f6be6a 40%, #d9761f); box-shadow: 0 0 14px 2px rgba(var(--you),.7); animation: breathe 3.2s ease-in-out infinite; }
  .bead.draft { background: radial-gradient(circle at 34% 30%, #eef0ff, #a7a9f6 40%, #5246d0); box-shadow: 0 0 14px 2px rgba(var(--them),.7); }
  .bead.closed, .bead.expired { background: var(--moon-subtle); opacity: .5; }
  .bead.agent { width: 26px; height: 26px; background: linear-gradient(90deg, #f6be6a 0 50%, #6f5ce8 50% 100%); box-shadow: inset 0 0 0 1px rgba(255,255,255,.15), 0 0 18px -2px rgba(var(--you),.45); }
  .bead.key { width: 26px; height: 26px; background: radial-gradient(circle at 34% 30%, #fff6e2, #d9b98a 50%, #6b4e2c); box-shadow: 0 0 18px -2px rgba(236,211,168,.5); }
  .empty { padding: 1.6rem 1.4rem; border: 1px dashed var(--night-rule); border-radius: 18px; color: var(--moon-muted); margin: 0; }

  /* The name card: a small invitation, as they would get it. */
  .seen { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1.2rem; align-items: center; max-width: 30rem;
          margin: 0 0 1.6rem; padding: 1.5rem 1.6rem; border-radius: 18px; border: 1px solid color-mix(in oklab, var(--champagne) 40%, transparent);
          background: linear-gradient(180deg, rgba(243,236,226,.05), rgba(243,236,226,.012)), var(--night);
          box-shadow: inset 0 0 0 5px var(--night), inset 0 0 0 6px color-mix(in oklab, var(--champagne) 14%, transparent), 0 50px 110px -55px rgba(0,0,0,.95); }
  .seen .label { grid-column: 1 / -1; font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .22em; color: var(--champagne); }
  .seen .sphere { width: 54px; height: 54px; border-radius: 50%; background: radial-gradient(circle at 34% 30%, #fff1d2, #f6be6a 26%, #d9761f 62%, #4a1c05 100%);
                  box-shadow: 0 0 0 1px rgba(var(--you),.5), 0 0 30px 4px rgba(var(--you),.5); }
  .seen.off .sphere { filter: saturate(.3) brightness(.6); box-shadow: none; }
  .seen .who { font: 400 2rem/1.1 var(--serif); color: var(--moon); overflow-wrap: anywhere; }
  .seen .who .mark { display: inline-block; vertical-align: middle; margin-left: .6rem; font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .18em;
                     color: var(--champagne-bright); border: 1px solid color-mix(in oklab, var(--champagne) 50%, transparent); border-radius: 999px; padding: .35rem .6rem; }
  .acct .chapter form.cta { margin-top: 1.6rem; max-width: 26rem; }

  /* The Plus band: framed lit from inside, three promises under numerals. */
  .plus { position: relative; isolation: isolate; overflow: hidden; margin: clamp(2rem, 5vh, 3rem) 0; padding: clamp(2.2rem, 5vw, 4rem); border-radius: 26px;
          border: 1px solid color-mix(in oklab, var(--champagne) 45%, transparent);
          background: radial-gradient(70% 90% at 85% 0%, color-mix(in oklab, var(--champagne) 20%, transparent), transparent 65%),
                      radial-gradient(60% 80% at 0% 100%, rgba(var(--them),.22), transparent 70%), var(--night);
          box-shadow: inset 0 0 0 7px var(--night), inset 0 0 0 8px color-mix(in oklab, var(--champagne) 16%, transparent), 0 60px 140px -60px rgba(0,0,0,.95); }
  .plus h2 { font-size: clamp(2.6rem, 5vw, 4.2rem); line-height: .98; margin-bottom: 1rem; }
  .plus > p { max-width: 34rem; }
  .plus ol { list-style: none; padding: 0; margin: 2.4rem 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: clamp(1.2rem, 3vw, 2.4rem); counter-reset: plus; }
  .plus li { counter-increment: plus; padding-top: 1.2rem; background: var(--glow) top / 100% 1px no-repeat; color: var(--moon-muted); font-size: .98rem; }
  .plus li::before { content: counter(plus, upper-roman); display: block; font: italic 400 2rem/1 var(--serif); color: var(--champagne); margin-bottom: .8rem; }
  .plus li strong { display: block; font: 400 1.45rem/1.15 var(--serif); margin-bottom: .45rem; }
  .plus form, .plus .on { max-width: 20rem; }
  .plus .on { display: inline-flex; align-items: center; gap: .7rem; color: var(--champagne-bright); }
  .plus .on::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--champagne-bright); box-shadow: 0 0 14px 2px rgba(236,211,168,.7); }

  /* Two ways to add an agent, side by side. */
  .ways { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  .ways > div { display: grid; align-content: start; gap: .7rem; padding: 1.5rem; border-radius: 18px; border: 1px solid var(--night-rule);
                background: linear-gradient(180deg, rgba(243,236,226,.04), rgba(243,236,226,.01)); }
  .ways h3 { font: 400 1.5rem/1.15 var(--serif); margin: 0; color: var(--moon); }
  .ways p { margin: 0; font-size: .95rem; }
  .ways .addr { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .ways form.cta { margin: .4rem 0 0; max-width: none; }
  /* The bound Telegram: the plane, the @handle in serif, a lit "Connected". */
  .tg { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 1.1rem; max-width: 34rem; margin: 0 0 1rem;
        padding: 1.2rem 1.4rem; border-radius: 18px; border: 1px solid color-mix(in oklab, var(--champagne) 40%, transparent);
        background: linear-gradient(180deg, rgba(243,236,226,.05), rgba(243,236,226,.012)), var(--night);
        box-shadow: inset 0 0 0 5px var(--night), inset 0 0 0 6px color-mix(in oklab, var(--champagne) 14%, transparent), 0 40px 90px -50px rgba(0,0,0,.95); }
  .tg > div { display: grid; gap: .15rem; min-width: 0; }
  .tg-mark { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; color: var(--night);
             background: radial-gradient(circle at 34% 30%, #fff6e2, #ecd3a8 45%, #b8925c); box-shadow: 0 0 26px -2px rgba(236,211,168,.55); }
  .tg-who { font: 400 1.9rem/1.1 var(--serif); color: var(--moon); overflow-wrap: anywhere; }
  .tg small { font: 11px/1.5 var(--mono); text-transform: uppercase; letter-spacing: .14em; color: var(--moon-subtle); }
  .connected { display: inline-flex; align-items: center; gap: .5rem; font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .2em; color: #8fe0b8;
               padding: .5rem .75rem; border-radius: 999px; border: 1px solid rgba(15,122,82,.6); background: rgba(15,122,82,.14); white-space: nowrap; }
  .connected::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #3ee08f; box-shadow: 0 0 10px 2px rgba(62,224,143,.6); animation: breathe 3.2s ease-in-out infinite; }
  @media (max-width: 480px) { .tg { grid-template-columns: auto minmax(0, 1fr); } .tg .connected { grid-column: 2; justify-self: start; } }
  .signout { display: flex; justify-content: flex-end; padding-top: 1rem; }

  @media (max-width: 920px) {
    .acct-hero, .chapter { grid-template-columns: minmax(0, 1fr); }
    .acct-hero figure { justify-self: start; max-width: 24rem; }
    .chapter { gap: 1.5rem; }
    .chapter > header { position: static; }
    .chapter .num { font-size: 2.6rem; }
    .plus ol, .ways { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 480px) {
    .cards li { grid-template-columns: auto minmax(0, 1fr); }
    .cards li > :last-child { grid-column: 2; justify-self: start; }
    .tally dd { font-size: 2.2rem; }
  }

  /* Slow, eased, once. */
  @keyframes rise { from { opacity: 0; transform: translateY(18px); } }
  @keyframes settle { from { opacity: 0; transform: scale(1.06); } }
  @keyframes breathe { 50% { transform: scale(1.2); } }
  main section > *, main aside > * { animation: rise .9s var(--ease) both; }
  main section > :nth-child(2), main aside > :nth-child(2) { animation-delay: .08s; }
  main section > :nth-child(3), main aside > :nth-child(3) { animation-delay: .16s; }
  main section > :nth-child(n+4), main aside > :nth-child(n+4) { animation-delay: .24s; }
  @media (prefers-reduced-motion: reduce) {
    main section > *, main aside > *, figure img { animation: fade .9s both; }
    .duo { transition: none; }
    .party.live .sphere, .sphere::before, .sphere::after, .wave path, .bloom, .duo.agreed .sphere, .seal, .terms.sealed, .facts dd.changed, .terms.updated, .moves li.fresh, .moves li.fresh *, .wave path.comet, .party.caught .sphere, .party .tag, main .leaving, main .arriving { animation: none !important; } .bloom { opacity: 1; transform: translate(-50%, -50%); } .duo.agreed .wave path { stroke-dashoffset: 0; } .primary::after { display: none; } .arrow { transition: none; } .bead.awaiting, .connected::before { animation: none; }
  }
  @keyframes fade { from { opacity: 0; } }
`;

/** The mark: two agents as two halves of one sphere (taasky-portal Logo.tsx). */
const LOGO = `<svg width="30" height="30" viewBox="3.3 3.55 24.9 24.9" aria-hidden="true">
<defs><linearGradient id="la" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#ffc24d"/><stop offset="1" stop-color="#ff7a1a"/></linearGradient>
<linearGradient id="lb" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#8f9bff"/><stop offset="1" stop-color="#4338ca"/></linearGradient>
<clipPath id="ll"><path d="M15.6-4Q20.4 16 15.6 36H-4V-4Z"/></clipPath><clipPath id="lr"><path d="M15.6-4Q20.4 16 15.6 36H36V-4Z"/></clipPath>
<mask id="lm"><rect x="-4" y="-4" width="40" height="40" fill="#fff"/><path d="M15.6-4Q20.4 16 15.6 36" stroke="#000" stroke-width="1.8" fill="none"/></mask></defs>
<g mask="url(#lm)"><circle cx="15" cy="16" r="11.6" fill="url(#la)" clip-path="url(#ll)"/><circle cx="17.6" cy="16" r="10.5" fill="url(#lb)" clip-path="url(#lr)"/></g></svg>`;

/**
 * You and them as DESIGN.md draws two agents: an amber sphere and an indigo
 * one, ribbons of light between. `live` is whose move it is; "both" lights
 * both, as on agreement.
 */
export function duo(
  live: "you" | "them" | "both" | "none",
  status: string,
  near = 0,
  /** `them`: the name the other side shows. `people`: a person answering, so turns, not moves. */
  opts: { them?: string; people?: boolean } = {},
): string {
  const state = (side: "you" | "them") =>
    live === side || live === "both" ? " live" : live === "none" ? "" : " rest";
  const name = opts.them ? escapeHtml(opts.them) : null;
  const tag = (side: "you" | "them") =>
    `<span class="tag">${
      opts.people
        ? side === "you"
          ? "Your turn"
          : `Waiting for ${name ?? "them"}`
        : side === "you"
          ? "Your move"
          : "Their move"
    }</span>`;
  const ribbons =
    '<path d="M0 25 C 37.5 5, 37.5 45, 75 25 S 112.5 5, 150 25 S 187.5 45, 225 25 S 262.5 5, 300 25"/>' +
    '<path d="M0 25 C 37.5 45, 37.5 5, 75 25 S 112.5 45, 150 25 S 187.5 5, 225 25 S 262.5 45, 300 25"/>';
  return `<div class="duo${live === "both" ? " agreed" : ""}" data-live="${live === "both" ? "none" : live}" style="--near:${near.toFixed(2)}">
  <span class="bloom" aria-hidden="true"></span>
  <div class="party you${state("you")}" aria-hidden="true"><span class="sphere"></span>You${tag("you")}</div>
  <svg class="wave" viewBox="0 0 300 50" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="wg" x1="0" x2="1"><stop offset="0" stop-color="#f6be6a"/><stop offset=".5" stop-color="#ecd3a8"/><stop offset="1" stop-color="#a7a9f6"/></linearGradient></defs>
    <g stroke="url(#wg)">${ribbons}</g>
    <g stroke="url(#wg)" class="runs">${ribbons.replaceAll("<path ", '<path class="run" ')}</g>
    <g stroke="#fff3dc" class="comets">${ribbons.replaceAll("<path ", '<path class="comet" pathLength="100" ')}</g>
  </svg>
  <div class="party them${state("them")}" aria-hidden="true"><span class="sphere"></span>${name ?? "Them"}${tag("them")}</div>
  <p class="status">${escapeHtml(status)}</p>
</div>`;
}

export interface PageOptions {
  /** Without JavaScript only; pages that poll do it in a script. */
  refreshSeconds?: number;
  /** Single column, for short pages: consent, errors. */
  narrow?: boolean;
  /**
   * The card a messenger shows for the link. Messenger servers fetch and keep
   * it, so it must be the same for every link: never terms or names.
   */
  preview?: { title: string; description: string; image: string };
  /** A class on <body>, for styles only one kind of page uses. */
  bodyClass?: string;
}

function previewTags(preview: PageOptions["preview"]): string {
  if (!preview) return "";
  const t = escapeHtml(preview.title);
  const d = escapeHtml(preview.description);
  const i = escapeHtml(preview.image);
  return `
<meta property="og:type" content="website"><meta property="og:site_name" content="Taasky">
<meta property="og:title" content="${t}"><meta property="og:description" content="${d}">
<meta property="og:image" content="${i}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="description" content="${d}">`;
}

/** A photograph from public/img, set as a numbered plate. */
export function plate(src: string, alt: string, figure: string, caption: string): string {
  return `<figure><div class="plate"><img src="${src}" alt="${escapeHtml(alt)}" width="1024" height="688"></div>
  <figcaption><span>${escapeHtml(figure)}</span><span>${escapeHtml(caption)}</span></figcaption></figure>`;
}

let localMode = false;

/**
 * `taasky local`: one person, no Telegram, no analytics, on loopback. Set from
 * the environment on every request; every page then says so up top.
 */
export function setLocalMode(on: boolean): void {
  localMode = on;
}

const LOCAL_BANNER = `<div class="local-mode"><b>LOCAL MODE</b>Nothing goes to a server: your rooms stay in a file on this computer.</div>`;

export function page(title: string, body: string, opts: PageOptions = {}): string {
  const refresh = opts.refreshSeconds
    ? `<noscript><meta http-equiv="refresh" content="${opts.refreshSeconds}"></noscript>`
    : "";
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#4a2f4a">${refresh}${previewTags(opts.preview)}
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/InstrumentSerif.woff2" as="font" type="font/woff2" crossorigin>
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body${opts.bodyClass ? ` class="${opts.bodyClass}"` : ""}><div class="sheet">
<header class="top">${localMode ? LOCAL_BANNER : ""}<div class="wrap"><a class="brand" href="https://taasky.ai">${LOGO}<span>Taasky</span></a>
<a class="button inline" href="https://taasky.ai" style="height:2.5rem;padding:0 1.2rem;font-size:14px">What is Taasky?</a></div></header>
<main class="wrap${opts.narrow ? " narrow" : ""}">${body}</main>
<footer><div class="wrap"><span>Your agent settles things with anyone. You say yes.</span><span class="links"><a href="https://taasky.ai/terms/">Terms</a><a href="https://taasky.ai/privacy/">Privacy</a><a href="https://taasky.ai">taasky.ai</a></span></div></footer>
</div></body></html>`;
}

export function htmlResponse(html: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Personal pages carry a secret in the URL: keep them out of caches and referrers.
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      ...headers,
    },
  });
}

/** One small script: the copy buttons. */
export const COPY_SCRIPT = `<script>
for (const b of document.querySelectorAll("button[data-copy]")) {
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    await navigator.clipboard.writeText(b.dataset.copy);
    const was = b.textContent; b.textContent = "Copied"; setTimeout(() => (b.textContent = was), 1500);
  });
}
</script>`;
