import { CODES, fail, ok } from './errors.mjs';

const MEMBER_RE = /^(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;

export function validateZipMemberName(name, label = 'ZIP member') {
  if (typeof name !== 'string' || !name) {
    return fail(CODES.INVALID_MANIFEST, `${label} name is required`);
  }
  if (name.includes('\0')) {
    return fail(CODES.UNRELATED_MUTATION, `${label} name is malformed`, { member: name });
  }
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(name)) {
    return fail(CODES.UNRELATED_MUTATION, `${label} must not be an absolute ZIP path`, { member: name });
  }
  if (name.includes('\\') || name.includes('..') || name.split('/').includes('..') || name.split('/').includes('')) {
    return fail(CODES.UNRELATED_MUTATION, `${label} must not traverse or use empty path segments`, { member: name });
  }
  if (name.endsWith('/')) {
    return fail(CODES.UNRELATED_MUTATION, `${label} must not be a directory entry`, { member: name });
  }
  if (!MEMBER_RE.test(name)) {
    return fail(CODES.UNRELATED_MUTATION, `${label} is not a normal Lambda ZIP member name`, { member: name });
  }
  return ok({ member: name });
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) {
    return fail(CODES.INVALID_MANIFEST, `${label} must be an array`);
  }
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const named = validateZipMemberName(value, label);
    if (!named.ok) return named;
    if (seen.has(named.details.member)) {
      return fail(CODES.INVALID_MANIFEST, `${label} contains a duplicate destination`, {
        member: named.details.member,
      });
    }
    seen.add(named.details.member);
    out.push(named.details.member);
  }
  return ok({ members: out });
}

export function validateOwnedMemberOps(ops, ownedComponents = []) {
  if (ops == null) {
    return fail(CODES.INVALID_MANIFEST, 'owned_member_ops is required when that receipt field is present');
  }
  if (!ops || typeof ops !== 'object' || Array.isArray(ops)) {
    return fail(CODES.INVALID_MANIFEST, 'owned_member_ops must be an object with replace and add arrays');
  }
  const extraKeys = Object.keys(ops).filter((key) => key !== 'replace' && key !== 'add');
  if (extraKeys.length) {
    return fail(CODES.INVALID_MANIFEST, 'owned_member_ops may only contain replace and add', {
      extra_keys: extraKeys,
    });
  }
  if (!Array.isArray(ops.replace) || !Array.isArray(ops.add)) {
    return fail(CODES.INVALID_MANIFEST, 'owned_member_ops.replace and owned_member_ops.add must both be arrays');
  }
  const replace = uniqueStrings(ops.replace, 'owned_member_ops.replace');
  if (!replace.ok) return replace;
  const add = uniqueStrings(ops.add, 'owned_member_ops.add');
  if (!add.ok) return add;
  const replaceSet = new Set(replace.details.members);
  for (const member of add.details.members) {
    if (replaceSet.has(member)) {
      return fail(
        CODES.INVALID_MANIFEST,
        'owned_member_ops destination cannot be listed as both replace and add',
        { member },
      );
    }
  }
  const all = [...replace.details.members, ...add.details.members];
  const owned = Array.isArray(ownedComponents) ? ownedComponents.map(String) : [];
  const ownedSet = new Set(owned);
  const allSet = new Set(all);
  const missingFromOwned = all.filter((member) => !ownedSet.has(member));
  const missingFromOps = owned.filter((member) => !allSet.has(member));
  if (missingFromOwned.length || missingFromOps.length) {
    return fail(
      CODES.INVALID_MANIFEST,
      'owned_member_ops replace+add must equal receipt owned_components',
      { missing_from_owned_components: missingFromOwned, missing_from_owned_member_ops: missingFromOps },
    );
  }
  return ok({
    replace: replace.details.members,
    add: add.details.members,
    all,
    explicit: true,
  });
}

export function classifyOwnedMembers(receipt = {}) {
  const owned = [...(receipt.owned_components || [])];
  if (!owned.length) {
    return fail(CODES.INVALID_MANIFEST, 'receipt must list owned ZIP members');
  }
  if (!Object.prototype.hasOwnProperty.call(receipt, 'owned_member_ops')) {
    const names = uniqueStrings(owned, 'owned_components');
    if (!names.ok) return names;
    return ok({
      replace: names.details.members,
      add: [],
      all: names.details.members,
      explicit: false,
    });
  }
  return validateOwnedMemberOps(receipt.owned_member_ops, owned);
}

export function evaluateOwnedMemberPresence({ liveMembers = {}, replace = [], add = [] } = {}) {
  for (const member of replace) {
    if (!Object.prototype.hasOwnProperty.call(liveMembers, member)) {
      return fail(
        CODES.DEPLOYMENT_COLLISION,
        'receipt-owned ZIP member is absent from the current live Lambda ZIP',
        { member, action: 'replace' },
      );
    }
  }
  for (const member of add) {
    if (Object.prototype.hasOwnProperty.call(liveMembers, member)) {
      return fail(
        CODES.DEPLOYMENT_COLLISION,
        'receipt-authorized add member already exists in the current live Lambda ZIP',
        { member, action: 'add' },
      );
    }
  }
  return ok({ replace: [...replace], add: [...add] });
}
