import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('iOS scene covers the web view while inactive and uncovers it when active', () => {
  const scene = read('mobile/ios/App/App/SceneDelegate.swift');
  const resign = scene.match(/func sceneWillResignActive\(_ scene: UIScene\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  const active = scene.match(/func sceneDidBecomeActive\(_ scene: UIScene\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.match(resign, /window\.addSubview\(cover\)/);
  assert.match(resign, /privacyCover = cover/);
  assert.match(resign, /guard privacyCover == nil/);
  assert.match(active, /privacyCover\?\.removeFromSuperview\(\)/);
  assert.match(active, /privacyCover = nil/);
  // The Capacitor scene hooks are still forwarded.
  assert.equal(scene.match(/SceneDelegateProxy\.shared\.scene\(/g)?.length, 3);
});

test('CodeQL workflow defaults to read-only and the analyze job keeps its own scopes', () => {
  const workflow = read('.github/workflows/codeql.yml');
  assert.match(workflow, /\npermissions:\n  contents: read\n\njobs:\n/);
  assert.doesNotMatch(workflow, /write-all/);
  assert.match(workflow, /\n    permissions:\n[\s\S]*?security-events: write/);
});
