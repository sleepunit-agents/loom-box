# Watching step transport

The runtime sends a bounded live snapshot, not a lossless event stream. Each body contributes its newest 100 cards within 256 KB, then all bodies share a 900 KB report budget. Older unseen cards can be omitted when large diffs or bursts exceed these limits; subsequent unchanged reports do not guarantee recovery. This keeps delivery responsive and the newest work visible. `newestWithin` and `fitCards` tests pin the bounds and newest-first selection. A lossless acknowledged stream needs separate transport work.

Final reports already have a 40000-character per-body limit. They additionally share a 300 KB JSON budget per sync report; when exceeded each is shortened evenly and explicitly marked as cut. This trades full report text for keeping a house report deliverable beside session packing. `fitFinals` tests cover multi-body and escaped text byte limits.

Transcript reads are bounded too: the session tail is at most 16 MiB, helper tails 2 MiB each, up to 20 helpers from the first 500 metadata directory entries, ranked by transcript modification time. Helpers outside that sampling window can be omitted. Codex events lack timestamps; first observation times are kept for 64 runs (1000 ids each), and are reset after eviction or replacement. These bounds take precedence over a globally exact newest-100 claim.
