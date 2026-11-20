# WAW — Roadmap

WAW is a static, browser-only DAW (served from GitHub Pages for testing). This
document tracks what exists, what is known to be limited, and what comes next.

## Architecture (current)

| File | Responsibility |
| --- | --- |
| `app.js` | Core app: tracks/clips data model, sequencer, MIDI piano roll, transport + lookahead scheduler, recording, undo/redo, projects |
| `js/fx.js` | Insert-effect library (schema-driven parameters) |
| `js/worklets.js` | AudioWorklet processors: gate, bitcrusher, recorder |
| `js/mixer.js` | Mixing engine (channel strips, aux buses, master) + SSL-style console UI, knobs, faders, meters |
| `js/synth.js` | Shared synth voice (realtime, scheduled and offline) + preset bank |
| `js/drums.js` | Drum Synth: analog-modelled, sample-free drum voices |
| `js/samples.js` | Sample store (IndexedDB, decoding, peaks, destructive edits) |
| `js/sampler.js` | 16-pad MPC-style sampler instrument + pad editor |
| `js/audio.js` | Audio tracks: input devices, monitoring, recording, audio clips, clip editor |
| `js/workspace.js` | Track management, shortcuts, transport display, drag & drop, voicing, MIDI input settings |
| `js/collab.js` | Real-time collaboration (WebRTC via Trystero/Nostr), chat, video |
| `js/tempo.js` | Tempo map (tempo + time-signature changes), markers, arranger sections |
| `js/automation.js` | Automation lanes, read/touch/latch/write, realtime + offline playback |
| `js/warp.js` | Audio warping (WSOLA time-stretch), tempo detection, audio quantize |
| `js/comp.js` | Take lanes and comping for cycle recordings |
| `css/waw-ext.css` | Styles for all of the above |

Script and stylesheet URLs carry a content hash (`app.js?v=…`) so browsers never mix old
and new files after an update. `tools/stamp_assets.py` writes the stamps; the
"Stamp asset versions" GitHub Action re-runs it on every push to `main`.

The same mixer graph is built for realtime playback and for `OfflineAudioContext`
WAV export, so what you hear is what you export.

## Done

### Stability / performance
- Fixed: Alt+N added three tracks; velocity lane editing did nothing; note paste threw;
  legacy loop-bar handlers threw on every click; slow loop drags never created a loop.
- Undo/redo records the state *before* an edit (drags, velocity, recording, clip moves,
  mixer knobs/faders) and refreshes all views; history is no longer written to
  `localStorage` on every edit.
- BPM changes rescale every track, clip and loop (not only the active track).
- Lookahead scheduler (≈200 ms) instead of creating every note's audio graph at once;
  sample-accurate, gap-free loop cycles; works in background tabs.
- Mute/solo/volume/pan/inserts apply live while playing.
- Noise buffers cached; only visible canvases are redrawn during playback.
- HTML injection via track/clip/project names fixed (escaped everywhere).
- Editor edits are heard immediately on Play (previously only after leaving the editor).

### Mixing (SSL-style console)
- Per channel: trim, phase, HPF/LPF, 4-band EQ (HF/LF shelf↔bell, HMF/LMF with Q),
  compressor (threshold/ratio/attack/release/make-up) + gate/expander, EQ↔DYN order,
  unlimited insert FX chain (drag to reorder, bypass), 4 aux sends (pre/post),
  pan, mono, solo-in-place, cut, record arm, fader with SSL-like law, stereo peak meters
  with peak hold, clip LEDs and gain-reduction meter.
- 4 FX return buses (Reverb, Delay, Plate, Chorus by default) with their own insert chains.
- Master bus with insert chain, mono check, meter + one-click mastering chain.
- FX: Parametric EQ, Compressor, Bus Compressor, Limiter, Gate, Reverb, Delay (sync,
  ping-pong), Chorus, Phaser, Saturator, Auto Filter, Tremolo/Auto-pan, Bitcrusher,
  Stereo Width (M/S, mono bass), Utility.

### Instruments
- Synth: unison (up to 7, detune/width), sub osc, osc 2 mix/FM/ring-mod with octave and
  semitone, filter types + 12/24 dB slopes, key tracking, velocity → amp/filter,
  LFO shapes and targets (pitch/filter/amp/pan), mono/legato glide, 35 presets.
- Drum Synth: 16 voices modelled after analog circuits (bridged-T resonators, six-oscillator
  metal bank for hats/cymbal, two-oscillator cowbell, multi-trigger clap), per-voice
  tune/decay/level, stereo spread. No samples.
- Pad controller mapping (Sampler + Drum Synth): MIDI Learn and Key Learn per pad, saved in
  the browser; notes are translated to the pad's own note so recordings stay portable.
- Sampler: 16 pads (MIDI 36–51 by default, keys Z–V/A–F/Q–R/1–4 by default), per-pad region, tune/fine, gain,
  pan, attack/release, filter, one-shot/gate/loop, reverse, choke groups, velocity
  sensitivity; load/drag-drop/record audio, normalize, crop, fades, chop to 16 pads
  (equal or by transients), render the Drum Synth into a kit.

### Audio & workflow
- Audio tracks: input device/channel selection, latency offset, input meter, record arm,
  input monitoring through the channel strip, latency-compensated recording,
  cycle recording keeps the last pass, import + drag & drop of audio files,
  non-destructive trim (offset), clip gain, fades, split, clip mute, audio clip editor,
  send clip to a sampler pad, WAV export of a clip.
- Track menu: add Synth/Drum Synth/Sampler/Audio, rename, color, duplicate, move, delete,
  per-track FX chain popup.
- Shortcuts: Ctrl+C/X/V/D/E on clips, Ctrl+A/C/X/V/D/Q and arrow nudge/transpose on notes,
  Home/End, Space, Alt+N, Alt+1..9.
- Transport: bars.beats.ticks + time display, return to start, tap tempo, header master meter.
- MIDI input device + channel filter; chord voicing (inversion, per-tone octave) works.
- Projects embed their audio when exported as JSON.

### Audio input (per track)
- Every audio track has its own input: device, channels (auto / stereo / mono 1..N),
  input gain (-24..+40 dB), optional browser auto-gain + noise suppression, level meter
  with a "no signal" hint. Devices are shared between tracks and closed when unused;
  several armed tracks record their own inputs at the same time.

### Timeline
- Tempo map: tempo changes and time-signature changes (any n/d) in a global lane;
  content keeps its bar/beat position when the map changes. Grid, ruler, snapping,
  quantize, metronome, bars.beats display and MIDI export (tempo + meter meta events)
  follow the map.
- Markers / arranger sections: loop a section, duplicate it (inserted after), delete it
  (closing the gap), insert bars; markers can be dragged and renamed.

### Automation
- Lanes for volume, pan, sends A–D and every numeric insert-FX parameter (A button on
  the track). Draw/drag/delete points (snapped; Alt = free).
- Modes: Off, Read, Touch (writes while a control is held), Latch (from the touch until
  stop), Write (all lanes from play start; drops to Touch afterwards). One undo per pass.
- WAV export renders volume/pan/send automation as exact ramps and FX parameters in
  1/40 s steps.

### Warping, audio quantize, comping
- Warp an audio clip to the song tempo (source BPM detected automatically); stretched
  with WSOLA so the pitch is kept, cached per tempo; varispeed until the render is ready.
- Quantize audio: slices the clip at its transients and moves each slice onto the grid.
- Cycle recording keeps every complete pass as a take; take lanes under the track let
  you click a take (whole clip) or swipe a range (comp); comp boundaries crossfade.
  Flatten renders the comp into one clip.

### Collaboration (v1)
- Serverless WebRTC rooms via [Trystero](https://github.com/dmotz/trystero) over public
  Nostr relays (handshakes encrypted with the room code). Link format `…#room=<code>`.
- Full-project sync on every edit (Lamport version, highest wins), on-demand transfer of
  missing audio samples, presence (who is on which track/view), text chat, camera/mic
  video tiles, optional "follow others' play/stop". A joiner's previous project is backed
  up to the local library before the session state is adopted.

## Known limitations

- **Collab conflict handling is last-writer-wins on the whole project.** Two people
  editing at the same moment can overwrite each other's change (the later one wins).
- **Collab is best-effort:** depends on public relays and on WebRTC NAT traversal
  (no TURN server), so some corporate networks will not connect. No authentication —
  anyone with the link can join and edit. Suitable for small rooms (≈2–6 people).
- Transport sync between collaborators is approximate (no shared clock).
- Tempo changes are steps (no tempo ramps). A warped clip uses the tempo at its start
  (a tempo change inside a warped clip is not followed within the clip).
- Automation covers track channels; bus and master automation are not available yet.
  Plugin parameters that rebuild internally (e.g. reverb size) can click when automated.
- Inserting a time-signature change keeps content on its beat position, so bar numbers
  after the change shift (same as most DAWs).
- Real USB-microphone capture was verified only with simulated devices in this
  environment; please report the input meter readings if a device stays silent.
- Recording latency compensation uses the browser-reported latency plus a manual offset;
  calibrate per device in the sidebar (Audio Input → Latency offset).
- Samples live in the browser's IndexedDB; clearing site data deletes them unless the
  project was exported as JSON.
- MIDI export is a single track/channel (drums are not moved to channel 10).

## Next

### Near term
1. **Collab v2 — CRDT document model.** Move project state to a CRDT
   (e.g. [Yjs](https://yjs.dev) over the existing Trystero transport) so concurrent edits
   merge per track/clip/parameter instead of whole-project last-writer-wins. Add per-object
   soft locks ("Bob is editing Clip 3") and remote cursors in the piano roll.
2. **TURN fallback** for networks where peer-to-peer fails (configurable ICE servers).
3. Tempo ramps and warp markers (elastic audio inside a clip).
4. Bus/master automation; automation for instrument (synth/drum/sampler) parameters.
5. Audio input: per-track input FX before recording, punch-in/out ranges.
6. Comping for MIDI takes.

### Mid term
7. **User management** (when a backend exists): accounts, project ownership,
   invite-only rooms with roles (owner/editor/viewer), persistent cloud projects.
   Candidate stacks: Supabase (Postgres + Realtime + Auth) or Firebase.
8. Shared cloud sample library with deduplication (content hashes).
9. Multitrack MIDI export (one track per WAW track, drums on channel 10) and stem export.
10. Sidechain inputs for compressors (needs an AudioWorklet compressor).
11. Plugin-style instrument API so new instruments/FX can be added as modules.
12. Mobile/touch layout for the console and pads.

### Ideas
- Pattern-based step sequencer view for the Drum Synth and Sampler.
- MIDI learn for knobs/faders; MCU/HUI control-surface support via Web MIDI.
- Spectrum analyzer / loudness (LUFS) meter on the master.
- Session recording of the collaboration chat into the project.
