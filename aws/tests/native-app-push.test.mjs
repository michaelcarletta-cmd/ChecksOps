// The iOS/Android app can receive push notifications (@capacitor/push-notifications). It is off
// until a build lists the platform in VITE_NATIVE_PUSH_PLATFORMS: iOS needs the Push capability
// and entitlement, Android needs Firebase (registering without it crashes), both need the server's
// push-register-device function. After sign-in it asks permission, registers, sends the token and
// opens only in-app paths from a tapped notification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PUSH_REGISTER_FUNCTION,
  enabledPushPlatforms,
  safeNotificationLink,
  startNativePush,
} from '../../src/lib/nativePush.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function fakeApp({ platform = 'ios', permission = 'prompt', afterRequest = 'granted' } = {}) {
  const calls = [];
  const handlers = {};
  const plugin = {
    checkPermissions: async () => { calls.push('check'); return { receive: permission }; },
    requestPermissions: async () => { calls.push('request'); return { receive: afterRequest }; },
    register: async () => { calls.push('register'); },
    addListener: async (event, fn) => { handlers[event] = fn; return { remove: () => { calls.push(`remove:${event}`); } }; },
  };
  const win = { Capacitor: { isNativePlatform: () => true, getPlatform: () => platform, Plugins: { PushNotifications: plugin } } };
  return { win, calls, handlers };
}

test('push is off unless the build lists the platform', () => {
  assert.deepEqual([...enabledPushPlatforms(undefined)], []);
  assert.deepEqual([...enabledPushPlatforms('')], []);
  assert.deepEqual([...enabledPushPlatforms(' iOS , android,web ')].sort(), ['android', 'ios']);
  for (const file of ['codemagic.yaml', '.env.aws.example']) {
    assert.doesNotMatch(read(file), /VITE_NATIVE_PUSH_PLATFORMS/, `${file} does not turn push on yet`);
  }
});

test('only in-app paths open from a notification', () => {
  assert.equal(safeNotificationLink({ link: '/checks/abc?tab=messages' }), '/checks/abc?tab=messages');
  for (const bad of ['https://evil.example', '//evil.example/x', '/\\evil.example', 'checks/1', '/a b', '/x\n', 5, null]) {
    assert.equal(safeNotificationLink({ link: bad }), null, String(bad));
  }
  assert.equal(safeNotificationLink(undefined), null);
  assert.equal(safeNotificationLink({ link: `/${'a'.repeat(600)}` }), null);
});

test('nothing happens on the website, on a platform that is off, or without the plugin', async () => {
  const opts = { registerDevice: async () => assert.fail('no register'), openLink: () => assert.fail('no open') };
  await startNativePush({ ...opts, win: {}, enabled: new Set(['ios']) });
  const off = fakeApp({ platform: 'android' });
  await startNativePush({ ...opts, win: off.win, enabled: new Set(['ios']) });
  assert.deepEqual(off.calls, [], 'android is not asked when only ios is on');
  const noPlugin = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} } };
  await startNativePush({ ...opts, win: noPlugin, enabled: new Set(['ios']) });
});

test('asks once, registers, sends the token and opens a tapped notification', async () => {
  const app = fakeApp({ platform: 'ios', permission: 'prompt', afterRequest: 'granted' });
  const sent = [];
  const opened = [];
  const stop = await startNativePush({
    win: app.win,
    enabled: new Set(['ios']),
    registerDevice: async (token, platform) => { sent.push([token, platform]); },
    openLink: (p) => opened.push(p),
  });
  assert.deepEqual(app.calls, ['check', 'request', 'register']);
  app.handlers.registration({ value: 'tok-1' });
  app.handlers.pushNotificationActionPerformed({ notification: { data: { link: '/checks/42' } } });
  app.handlers.pushNotificationActionPerformed({ notification: { data: { link: 'https://evil.example' } } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [['tok-1', 'ios']]);
  assert.deepEqual(opened, ['/checks/42']);
  stop();
  assert.equal(app.calls.filter((c) => c.startsWith('remove:')).length, 3);
});

test('a refused permission registers nothing', async () => {
  const app = fakeApp({ platform: 'android', permission: 'prompt', afterRequest: 'denied' });
  await startNativePush({ win: app.win, enabled: new Set(['android']), registerDevice: async () => assert.fail(), openLink: () => {} });
  assert.deepEqual(app.calls, ['check', 'request']);
  const denied = fakeApp({ permission: 'denied' });
  await startNativePush({ win: denied.win, enabled: new Set(['ios']), registerDevice: async () => assert.fail(), openLink: () => {} });
  assert.deepEqual(denied.calls, ['check'], 'a past "no" is not asked again');
});

test('the app shell wires push in: plugin, iOS token hand-off, signed-in registration', () => {
  const pkg = JSON.parse(read('mobile/package.json'));
  assert.equal(pkg.dependencies['@capacitor/push-notifications'], '8.1.3');
  assert.match(read('mobile/ios/App/CapApp-SPM/Package.swift'), /\.product\(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"\)/);
  assert.match(read('mobile/android/capacitor.settings.gradle'), /include ':capacitor-push-notifications'/);
  assert.match(read('mobile/android/app/capacitor.build.gradle'), /implementation project\(':capacitor-push-notifications'\)/);
  const delegate = read('mobile/ios/App/App/AppDelegate.swift');
  assert.match(delegate, /didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data\) \{\s*NotificationCenter\.default\.post\(name: \.capacitorDidRegisterForRemoteNotifications, object: deviceToken\)/);
  assert.match(delegate, /didFailToRegisterForRemoteNotificationsWithError error: Error\) \{\s*NotificationCenter\.default\.post\(name: \.capacitorDidFailToRegisterForRemoteNotifications, object: error\)/);
  // No entitlement yet: adding aps-environment before the App ID has Push breaks signing.
  assert.doesNotMatch(read('mobile/ios/App/App.xcodeproj/project.pbxproj'), /CODE_SIGN_ENTITLEMENTS/);
  assert.equal(PUSH_REGISTER_FUNCTION, 'push-register-device');
  const component = read('src/components/NativePushRegistration.tsx');
  assert.match(component, /if \(!userId\) return;/, 'only after sign-in');
  assert.match(component, /supabase\.functions\.invoke\(PUSH_REGISTER_FUNCTION, \{ body: \{ token, platform \} \}\)/);
  assert.match(read('src/App.tsx'), /<AuthProvider>\s*<RemoteChangeCursor \/>\s*<NativePushRegistration \/>/);
});
