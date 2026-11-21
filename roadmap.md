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
- Synth ("PS-8" analog front panel): two oscillators (saw / variable-width pulse / square /
  triangle / sine; octave, semi, fine; osc 2 mix / FM / ring), mixer (osc levels, sub,
  noise), filter (LP/BP/HP, 12/24 dB, cutoff, resonance, ± envelope amount, key tracking,
  velocity) with its own ADSR, amp ADSR, LFO (4 waves, rate, depth, delay, pitch / filter /
  amp / pan), voice (poly/mono, glide, unison up to 7 with spread and width) and output
  (drive, chorus, delay, reverb, pan, volume); envelope graphs, playable 2-octave keyboard,
  categorised preset browser with search, user presets, random patch. 160 factory
  presets in 11 categories (bass, lead, pad, strings, brass, keys, organ, pluck, bells,
  sequence, FX), level-matched (every preset peaks below full scale on a single note).
- Drum Synth ("RD-16" drum-machine panel): master section (tune, decay, tone, punch,
  snappy, noise, hat/tom decay, bell tune, drive, stereo, volume) and 16 instrument
  channels (level, tune, decay, tone, snappy, pan + trigger pad); 37 factory kits in 8
  styles plus user kits; all 592 kit voices stay below full scale at full velocity.
- Step sequencers (SEQ button in both panels):
  - Synth: monophonic analog-style sequencer, up to 32 steps (note, on/off, accent, slide),
    rate 1/8…1/32 incl. triplets, swing, gate, transpose / octave, random-in-key, and step
    input from the on-screen keys, the computer keyboard or MIDI.
  - Drum machine: 16 instruments × up to 32 steps (off / on / accent), drag painting,
    14 starter beats, rate and swing.
  - Both preview at the song tempo and copy to a regular MIDI clip at the playhead
    (×1/×2/×4/×8, first free spot on the track). Patterns are saved with the track.
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
- Per-track MIDI In (device: all / computer keyboard / a specific controller; channel:
  any / 1–16): armed tracks only receive matching notes, so several players (or a split
  keyboard) can record different tracks in the same take. Kept per computer (not synced).
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
- Project sync merges per part instead of per project: each track's settings, mix,
  instrument and content (clips/notes) and the song's mixer buses, tempo map, track order,
  loop and key are separate last-writer-wins units with their own Lamport versions, applied
  in place. One person can record while others mix or edit instruments (even on the same
  track); tracks added / deleted by different people at the same time both survive.
  Arming, input monitoring and audio inputs are per person and never synced.
- "Record together" (band mode): when one person records, everyone who opted in records
  their own armed tracks from the same song position and stops with them; each take is
  aligned to the song as that person heard it. On-demand transfer of missing audio samples, presence (who is on which track/view), text chat, camera/mic
  video tiles, optional "follow others' play/stop". A joiner's previous project is backed
  up to the local library before the session state is adopted.

## Performance and release readiness

The following items are verification and hardening work identified during a static
architecture review. They are **not claims that these problems have been reproduced**.
Keep each item open until it has been tested on real browser/device combinations and
the results are recorded.

### Audio-engine hardening
- [ ] Keep AudioWorklet as the normal recording path and use ScriptProcessor only as a
  compatibility fallback; verify that both paths are never capturing the same stream.
- [ ] Profile recorder buffer copies and allocations during long recordings; consider a
  preallocated ring buffer or buffer pool if profiling shows avoidable GC pressure.
- [ ] Define bounded buffering and backpressure behavior. Detect overruns and surface a
  warning rather than silently losing or truncating recorded audio.
- [ ] Stress the lookahead scheduler during main-thread stalls, background-tab throttling,
  dense MIDI passages, loop boundaries and tempo-map changes; measure late or missed events.
- [ ] Audit voice and audio-node lifecycle: stuck notes, voice stealing, disconnects,
  repeated play/stop, track deletion and project replacement.
- [ ] Check effect parameter changes and effect-graph rebuilds for clicks, especially
  reverb and other effects that recreate internal nodes.
- [ ] Verify AudioContext resume behavior, permission changes, device unplug/replug,
  channel-count changes and differing input/output sample rates.

### Performance and compatibility test matrix
- [ ] Record a reproducible baseline: browser/version, OS, CPU, sample rate, audio device,
  buffer/latency settings and power mode.
- [ ] Measure representative 8/16/32/64-track sessions with instruments, samples,
  automation and insert effects; record CPU, memory and audible dropouts.
- [ ] Test 1/2/4-channel input recording for 10/30/60 minutes; verify duration, channel
  alignment, continuity and absence of missing blocks.
- [ ] Stress the UI while recording and playing; include background tabs and deliberate
  main-thread stalls.
- [ ] Instrument scheduler lateness, recorder overruns, peak memory and dropout counts.
- [ ] Run cold-start and long-session checks in current Chrome, Edge and Firefox.
- [ ] Publish measured, environment-specific limits instead of promising a universal
  maximum track count.

### Professional workflow and audio-quality gaps
- [ ] Add punch-in/out ranges and input-FX monitoring/recording workflow.
- [ ] Add a loopback-based recording-latency calibration flow; retain manual offset as
  an override and document device-specific behavior.
- [ ] Add multitrack MIDI export and stem export.
- [ ] Add sidechain routing and bus/master/instrument automation.
- [ ] Add loudness (LUFS) and true-peak metering.
- [ ] Review the current limiter implementation with level-matched tests. Do not describe
  it as transparent lookahead or true-peak limiting unless those properties are verified.
- [ ] Document the absence of native VST3/AU hosting. A future browser instrument/FX module
  API is a separate extension mechanism, not native plugin compatibility.

### Release gates
- [ ] Functional: core editing, instruments, mixer, automation, import/export and
  collaboration smoke tests pass.
- [ ] Audio integrity: long recordings and exports are checked for dropouts, clipping,
  channel alignment and timing drift.
- [ ] Performance: publish repeatable measurements and known operating limits.
- [ ] Compatibility: record tested browser/OS/device combinations and known exclusions.
- [ ] Data safety: verify project/sample backup, restore and destructive-edit recovery.
- [ ] Release certification: complete manual hardware/device checks and document results;
  passing automated or simulated tests alone does not certify a release.

## Known limitations

- **Collab conflicts are resolved per part.** Two people changing the *same* part at the
  same moment (e.g. both editing clips on one track, or both moving one fader) still
  resolve last-writer-wins for that part.
- **Band mode is not real-time jamming:** internet latency (typically 50–300 ms) is too high
  to hear each other in time while playing; everyone plays against their own playback and
  the takes line up on the timeline.
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

### Near term — reliability before feature expansion
1. **Recorder efficiency and integrity:** confirm one active capture path, profile copies
   and allocations, add bounded buffering, overrun detection and long-recording tests.
2. **Performance harness:** add repeatable multi-track playback/recording scenarios and
   publish measured CPU, memory, scheduler-lateness and dropout results.
3. **Audio lifecycle and device resilience:** audit voices/nodes and test context resume,
   permissions, device changes, channel layouts and sample rates.
4. **Recording workflow:** add punch-in/out and improve latency calibration; assess
   input-FX monitoring.
5. **Mixing/mastering verification:** validate limiter behavior and add LUFS/true-peak
   metering before making mastering-quality claims.

### Mid term — production workflow
6. Multitrack MIDI export and stem export.
7. Sidechain routing; bus, master and instrument automation.
8. Collab v3: finer per-clip/per-parameter merges, soft locks and remote cursors.
9. TURN fallback for networks where peer-to-peer WebRTC fails.
10. Tempo ramps, warp markers and MIDI take comping.
11. Browser instrument/FX module API; explicitly separate this from native VST3/AU hosting.
12. Mobile/touch layout for the console and pads.

### Longer term — service-backed capabilities
13. User management, project ownership, invite-only rooms with roles and persistent cloud
    projects (requires a backend; Supabase or Firebase remain candidates).
14. Shared cloud sample library with content-hash deduplication.

### Ideas
- Play step patterns in sync with the song transport (pattern clips), and a step grid for
  the Sampler.
- MIDI learn for knobs/faders; MCU/HUI control-surface support via Web MIDI.
- Session recording of the collaboration chat into the project.
