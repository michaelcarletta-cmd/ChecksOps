/**
 * Inspect the actual Lambda candidate composition being deployed.
 * Source-only accepted-contract test results are not sufficient: a Signature
 * overlay can keep a live workflow-rpc that never gained SQL44 routing while
 * unrelated source tests still pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';

const MARKERS_REL = 'ops/deployment-guard/accepted-composition-markers.json';

export function defaultMarkersPath(root) {
  return path.join(root, MARKERS_REL);
}

export function loadAcceptedCompositionMarkers(root) {
  return JSON.parse(fs.readFileSync(defaultMarkersPath(root), 'utf8'));
}

export function fixtureCandidateContents(markers) {
  const contents = {};
  for (const marker of markers.markers || []) {
    const groups = marker.all_of || [{
      member: (marker.members || [])[0],
      patterns: marker.patterns || [],
    }];
    for (const group of groups) {
      const member = group.member;
      if (!member) continue;
      const extra = (group.patterns || []).join('\n');
      contents[member] = `${contents[member] || ''}\n${extra}\n`;
    }
  }
  return contents;
}

function memberText(candidateContents, member) {
  if (!candidateContents || typeof candidateContents !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(candidateContents, member)) {
    return String(candidateContents[member] ?? '');
  }
  const base = path.posix.basename(member);
  if (Object.prototype.hasOwnProperty.call(candidateContents, base)) {
    return String(candidateContents[base] ?? '');
  }
  return null;
}

export function evaluateAcceptedComposition({
  candidate_contents: candidateContents,
  markers,
  required = true,
} = {}) {
  if (!markers || !Array.isArray(markers.markers)) {
    return failMany([errorEntry(
      CODES.REGRESSION_DETECTED,
      'accepted composition markers are missing; cannot verify the candidate being deployed',
    )], CODES.REGRESSION_DETECTED);
  }

  if (required && (candidateContents == null || typeof candidateContents !== 'object')) {
    return failMany([errorEntry(
      CODES.REGRESSION_DETECTED,
      'lambda candidate_contents are required; source tests alone cannot prove accepted behaviors survived the overlay',
    )], CODES.REGRESSION_DETECTED);
  }

  const errors = [];
  const checked = [];

  for (const marker of markers.markers) {
    const groups = marker.all_of || [{
      member: (marker.members || [])[0],
      patterns: marker.patterns || [],
    }];
    for (const group of groups) {
      const member = group.member;
      const text = memberText(candidateContents, member);
      if (text == null) {
        errors.push(errorEntry(
          CODES.REGRESSION_DETECTED,
          `accepted behavior ${marker.id} (${marker.title}) cannot be verified; candidate member ${member} was not supplied`,
          { marker_id: marker.id, member },
        ));
        continue;
      }
      for (const pattern of group.patterns || []) {
        if (!text.includes(pattern)) {
          errors.push(errorEntry(
            CODES.REGRESSION_DETECTED,
            `accepted behavior ${marker.id} (${marker.title}) disappeared from candidate ${member}`,
            { marker_id: marker.id, member, pattern },
          ));
        }
      }
    }
    checked.push(marker.id);
  }

  if (errors.length) return failMany(errors, CODES.REGRESSION_DETECTED);
  return ok({ checked, members: Object.keys(candidateContents || {}).sort() });
}

export function markersFromRepo(root) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const inferred = root || path.resolve(__dirname, '../../..');
  return loadAcceptedCompositionMarkers(inferred);
}
