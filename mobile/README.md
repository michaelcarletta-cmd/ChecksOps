# ChecksOps mobile (iOS and Android)

A Capacitor shell that packages the ChecksOps website into iOS and Android apps.

- App ID (Apple Bundle ID and Google Application ID): `com.checksops.app`. It is permanent
  once a build is uploaded to either store.
- Web assets: `../dist`, the output of `bun run build:aws` in the repo root. Builds use the
  staging configuration (`.env.aws.example`), so the apps talk to the staging API and Cognito pool.
- iOS uses Swift Package Manager (no CocoaPods). Builds run on Codemagic, so no Mac is needed.
- This folder has its own `package.json` and `package-lock.json`; the website's dependencies
  and lockfiles are not touched.

## Build locally (Android Studio, optional)

```bash
bun run build:aws
```

```bash
cd mobile && npm ci && npx cap sync && npx cap open android
```

## Build on Codemagic

`codemagic.yaml` in the repo root defines `android-staging-build` (signed APK and AAB, no
upload), `android-staging` and `ios-staging`. None has a trigger: a build starts only when someone presses Start in Codemagic. The one-time setup
(App Store Connect API key, iOS signing, Android upload keystore, Play service account) is
listed at the top of that file.

- iOS: the build is signed and sent to TestFlight. Install it on an iPhone with the TestFlight app.
- Android: `android-staging-build` needs only the keystore. Its `.apk` installs directly on a
  phone; its `.aab` is the first upload, done by hand in the Play Console (internal testing).
  After that, `android-staging` uploads each build to the internal track as a draft.

## Icons and splash screens

`assets/icon-source.png` is the owner's artwork. The other files in `assets/` are made from it:
`icon-only.png` (iOS and legacy Android) drops the baked-in bevelled frame, shrinks the design to
86% and fades its edges into the texture's near-black (#0e0e0c), keeping the wordmark band sharp,
so the platform masks round the corners without clipping the first or last letter. It is opaque
RGB (Apple rejects transparency). On Android the same image is the adaptive background layer
and the foreground is empty. The splash screens show the full badge, frame and all, on black.
To regenerate every size after changing them:

```bash
cd mobile && npx @capacitor/assets@3.0.5 generate --ios --android --iconBackgroundColor '#0e0e0c' --splashBackgroundColor '#000000' --splashBackgroundColorDark '#000000'
```

The tool reformats `android/app/src/main/AndroidManifest.xml` without changing it; discard that
diff (`git checkout -- android/app/src/main/AndroidManifest.xml`).

## Not done yet

- Sign-in, CORS and passkeys for the app's origins (`capacitor://localhost` on iOS,
  `https://localhost` on Android) are untested. Any production change for them goes through
  the guarded workflows after the security hardening work lands.
- No native plugins (camera, push, Face ID) yet.
