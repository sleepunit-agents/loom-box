// Exact fixture units only. Stop before reset-failed, including after an
// assertion fails; never enumerate or reset production administration units.
import { spawnSync } from 'node:child_process';
import { administrationUnit } from '../src/administration-supervisor.mjs';
const fixtures = new Set();
export function trackAdministrationFixture(root, id) {
  fixtures.add(() => administrationUnit(root, id(), true));
}
export function cleanupAdministrationFixture() {
  const units = [...fixtures].map(unit => unit());
  fixtures.clear();
  if (process.env.LOOM_ADMIN_TEST_SUPERVISOR !== 'systemd') return;
  const manager = process.getuid() === 0 ? [] : ['--user'];
  for (const unit of new Set(units)) {
    const options = { encoding: 'utf8', timeout: 5000 };
    spawnSync('systemctl', [...manager, 'stop', unit], options);
    // A successful transient unit may already have been collected.
    const reset = spawnSync('systemctl', [...manager, 'reset-failed', unit], options);
    if (reset.error) throw reset.error;
    const state = spawnSync('systemctl', [...manager, 'show', unit, '--property=ActiveState', '--value'], options);
    if (state.error) throw state.error;
    if (['active', 'activating', 'deactivating', 'failed'].includes(state.stdout.trim())) {
      throw Error('Fixture unit was not cleaned up: ' + unit);
    }
  }
}
