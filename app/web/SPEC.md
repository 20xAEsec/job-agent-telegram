# JobAgent desktop: reconstruction spec

The page `dashboard.html` is transcribed from this spec. To reskin, change the values here and in the page together.

## 1. Intent

A calm, private control room for one person's job search. A dim aurora veil moves slowly behind cockpit-glass panels.
The light stays in the empty space around the panels and never competes with text. Switching sections moves the camera
to a new pose ("kinetic"), so each section feels like its own place in the same sky.

## 2. Palette (CSS tokens on `:root`; the scene reads them back at boot)

| token | value | use |
|---|---|---|
| `--col-core` | `#ffffff` | aurora creases (hottest) |
| `--col-inner` | `#c8f4ff` | links, current values |
| `--col-mid` | `#35c8f0` | aurora body, kickers, focus ring, bars |
| `--col-outer` | `#0d3f6b` | aurora tails |
| `--col-spark` | `#e6fbff` | motes |
| `--col-accent` | `#9dffd6` | badges, "good", primary button edge |
| `--bg` | `#000` | page (additive light needs pure black) |
| `--panel` / `--panel-solid` | `rgba(3,11,20,.76)` / `rgba(3,10,18,.95)` | glass / sticky bars, small items |
| `--well` | `rgba(2,9,16,.55)` | items inside panels |
| warn / bad | `#fcd38a` / `#ff8fa3` | |

Type: system fonts only (CSP blocks Google Fonts). Titles `Segoe UI Variable Display` weight 250 with a white→ice→steel
gradient and a `rgba(53,200,240,.28)` glow; kickers 11px, `.28em` tracking, uppercase, `--col-mid`.

## 3. Layers

`canvas#bg` (fixed, 100vw × 100lvh, aria-hidden) → `#scrim` (radial vignette + top/bottom fades, pointer-events none)
→ `.app` (sidebar 252px + main) → drawer / modal / toast. Blur (22px, saturate 1.4) only on panels, sidebar, drawer.
`@supports not (backdrop-filter)` → `--panel-solid`.

## 4. Scene: aurora veil (three@0.143.0, `WebGL1Renderer`, served from `/vendor/three/`)

- Seed `0x9E3779B9`, one `mulberry32`, consumed in order: per sheet (phase jitter, x offset, z roll), then motes (x, y, z, seed, size).
- Camera FOV 48, near 0.1, far 80. `rig` (translate only) → `group` (rotates).
- 4 sheets, `PlaneGeometry(18, 8, 160, 72)` (low power `100 × 44`), `frustumCulled = false`:

  | amp | z | y | ry | rx | phase | alpha |
  |---|---|---|---|---|---|---|
  | 0.55 | −2.6 | 0.9 | 0.10 | −0.12 | 0.0 | 0.95 |
  | 0.90 | −1.5 | 0.2 | −0.20 | −0.05 | 1.7 | 0.72 |
  | 1.25 | −3.8 | 1.4 | 0.32 | −0.18 | 3.1 | 0.62 |
  | 1.40 | −0.7 | −0.7 | −0.08 | 0.06 | 4.4 | 0.40 |

- Sheet vertex: `t = uTime*0.11 + uPhase; q = position.xy*0.22; w1 = sin(q.x*1.7 + t*1.3)*cos(q.y*1.1 - t);
  w2 = sin(q.x*3.1 - t*0.7 + w1*1.4); h = w1*0.8 + w2*0.35; p.z += h*uAmp*(1 + uEnergy*0.8)`; varyings `vHeight = h`, `vEdge = |w2|`.
- Sheet fragment: `crease = pow(1 - clamp(vEdge,0,1), 3); c = mix(outer, mid, clamp(vHeight*.5+.5,0,1)); c = mix(c, core, crease*.65);
  fade = smoothstep(.5,.15,|vUv.y-.5|) * smoothstep(.5,.2,|vUv.x-.5|); rgb = c*uBrightness*(0.1 + crease*0.95); a = fade*uAlpha*0.5`.
- Motes: 220 (low power 120), x ±8, y −3.5…4, z −5…1.5, size `0.35 + rnd³*2.2`, `gl_PointSize = aSize*dpr*(18/−mv.z)`, twinkle `0.55 + 0.45 sin(t*1.3 + seed*2π)`, soft disc `a²*0.6`.
- All materials: `AdditiveBlending, transparent, depthTest:false, depthWrite:false`.
- Post: RenderPass → UnrealBloom(strength 0.6, radius 0.55, threshold 0) → lens pass (vignette `mix(.6,1,smoothstep(1.05,.25,|c*(1,1.25)|))`, gamma 1/2.2, grain ±2.5/255). No `bloomPass.setSize` after `composer.setSize`.
- Brightness: `BASE 0.55 × pose.dim × (0.7 on screens narrower than 1.15:1) × appear(1.6 s) × (1 + 0.35·sin(travel·π))`.

## 5. Motion (kinetic)

On `jobagent:view` the camera travels 1.9 s (easeInOutCubic) to the section pose; light swells mid-flight.

| view | position | target | group ry | dim |
|---|---|---|---|---|
| overview | 0, 0, 6.2 | 0.7, 0.5, −2 | 0 | 0.62 |
| review | 1.5, −0.6, 5.0 | 1.9, 0.3, −2 | 0.30 | 0.36 |
| jobs | −1.7, 0.7, 7.3 | −0.5, 0.6, −2 | −0.38 | 0.40 |
| questions | 0.9, 1.3, 5.6 | 0.5, 1.1, −2 | 0.18 | 0.42 |
| profile | −1.1, −0.9, 6.0 | −0.2, −0.1, −2 | −0.24 | 0.45 |
| settings | 2.3, 0.3, 7.7 | 1.0, 0.3, −2 | 0.52 | 0.36 |
| insights | 0.2, −1.5, 6.6 | 0.3, −0.3, −2 | 0.08 | 0.55 |
| health | −2.3, −0.2, 6.4 | −0.8, 0.1, −2 | −0.58 | 0.55 |

Plus: spin 0.02 rad/s; scroll pulls the camera back 0.9 and down 0.7; pointer parallax ±0.35 / ±0.22 (not on touch);
pointer speed raises `uEnergy`. Rig offset: wide `(0.9, 0.5, 0)`, narrow `(0, 1.3, 0)`. UI entrances: `.rise`, 0.85 s,
`cubic-bezier(.22,1,.36,1)`, 70 ms stagger, only on navigation (never on the live refresh).

## 6. Guards (keep, with their reasons)

- dpr `min(devicePixelRatio, lowPower ? 1 : 1.5)`: soft light gains nothing above 1.5 and costs 2.25× the fragments.
- Size from `canvas.clientWidth/Height`, never `innerHeight`: `100lvh` does not change when a phone's URL bar hides.
- Resize debounced 120 ms. `dt` clamped to 0.05 s (tab refocus). Skip frames while `document.hidden`.
- `prefers-reduced-motion`: render one frame and stop; view changes jump to the pose and render once.
- Any WebGL error: `data-scene="off"` and the CSS gradient background stays. The app works without the scene.
- `data-scene="ready"` on `<html>` when running (the screenshot harness waits for it).

## 7. Layout

Sidebar (brand, 8 sections with badges, status card, Pause / Search now) + main column (kicker, title, hairline,
always-visible "Paste a job link" box). Under 900px the sidebar becomes a top bar with a scrolling icon nav (label only
on the current section). Under 560px the review action bar stops being sticky. 16px gutters; no horizontal page scroll.

## 8. Checking it

`cd app && bun run dev/dash.ts` prints a link to a fixture dashboard; then
`uv run --project agent python app/dev/dash_shot.py <link>` screenshots every section at 1600×900 and 390×844 into
`app/dev/out/`, clicks through the main actions, and prints any page errors. Look at the images: text must stay
legible over the brightest part of the light, and the light should sit in the empty space, not behind the copy.
