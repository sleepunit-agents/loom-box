import { StateError } from './state.mjs';

export function administrationCapability(value) {
  if (value === null) return null;
  const fail = () => { throw new StateError('invalid administrative execution capability', 400); };
  if (value?.v !== 1 || !/^linux-[0-9a-f]{64}$/.test(value.host ?? '') ||
      !value.identities || typeof value.identities !== 'object' || Array.isArray(value.identities)) fail();
  const identities = {};
  for (const [name, identity] of Object.entries(value.identities)) {
    if (!['runner', 'root'].includes(name) || !Number.isInteger(identity?.uid) || !Number.isInteger(identity?.gid) ||
        identity.uid < 0 || identity.gid < 0 || identity.uid > 2147483647 || identity.gid > 2147483647 ||
        (name === 'root' ? identity.uid !== 0 : identity.uid === 0)) fail();
    identities[name] = { uid: identity.uid, gid: identity.gid };
  }
  return Object.keys(identities).length ? { v: 1, host: value.host, identities } : null;
}
