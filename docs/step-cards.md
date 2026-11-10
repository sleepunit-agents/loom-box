# Watching step transport

The runtime sends a bounded live snapshot, not a lossless event stream. Each body contributes its newest 100 cards within 256 KB, then all bodies share a 900 KB report budget. Older unseen cards can be omitted when large diffs or bursts exceed these limits; subsequent unchanged reports do not guarantee recovery. This keeps delivery responsive and the newest work visible. `newestWithin` and `fitCards` tests pin the bounds and newest-first selection. A lossless acknowledged stream needs separate transport work.

Final reports already have a 40000-character per-body limit. They additionally share a 300 KB JSON budget per sync report; when exceeded each is shortened evenly and explicitly marked as cut. This trades full report text for keeping a house report deliverable beside session packing. `fitFinals` tests cover multi-body and escaped text byte limits.
