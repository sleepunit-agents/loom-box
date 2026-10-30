// Every test's temp dirs, under one root that's removed when the test process exits. A test made its own temp home and
// left it: /tmp on loom's machine is memory, and 1,694 of box.test's 68 MB homes (6.8 GB) had piled up there by
// 2026-10-30, with the container at its memory cap and the kernel killing its processes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'loom-box-test-'));
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });

/** A fresh temp dir for this test file, gone when it exits. */
export const scratch = (prefix) => mkdtempSync(join(root, prefix));
