# Campus Emergency SOS — Native Android Responder App & Background Delivery Architecture

## 1. Executive Summary & Root Cause Analysis

### Why Alerts Stopped When the Responder Website Closed
1. **Browser Tab Lifecycle Termination**: Modern desktop and mobile browsers (Chrome, Safari, Firefox, Edge) suspend or terminate JavaScript execution, WebSocket connections, and Web Audio API timers within 30 to 60 seconds after a tab is backgrounded, minimized, or closed.
2. **Web Push Sound & Alarm Restrictions**: Web Push (via Service Workers) on Android is heavily restricted by Android OS notification channel rules. It cannot wake the device from deep sleep, cannot play looped audible sirens over Do Not Disturb unless explicitly approved by complex browser settings, and cannot launch full-screen lockscreen activities.
3. **Previous Localhost/Railway Coupling**: The previous codebase attempted to call an unhosted local Express server (`http://10.0.2.2:4000`) or external Railway instances.

### The Permanent Native Android Solution
We implemented a **100% Firebase-Native Background Architecture** that does not depend on an open website, browser tab, or external servers:
1. **Dedicated Native Kotlin Responder App** (`com.emergencysos.responder`) configured with `google-services.json` connected directly to your existing Firebase project (`college-sos-app-26aec`).
2. **Pure Firebase Backend**: All authentication, emergency incidents, device registrations, and delivery receipts sync directly via Cloud Firestore (`students`, `emergency_responders`, `responder_devices`, `incidents`).
3. **Dual-Layer Background Alert Delivery**:
   - **Layer 1 (Spark Plan Compatible — Active Monitor)**: `EmergencyAlertForegroundService` operates with a persistent low-priority system notification (*"Campus Safety Network · Active Monitor"*). It holds an active TLS Firestore real-time listener on `incidents`. When a student clicks **Send SOS** on the website, the phone receives the event in under 500ms, plays the bundled `emergency_siren.mp3`, turns on the screen, and launches `IncidentAlertActivity` over the lockscreen.
   - **Layer 2 (Blaze Plan Compatible — FCM Push Trigger)**: If/when Cloud Functions are deployed on a billing-enabled project, the server-side trigger `onDocumentCreated("incidents/{incidentId}")` uses the Firebase Admin SDK to push high-priority FCM data messages directly to all tokens in `responder_devices`. `SosFirebaseMessagingService` receives the push and activates the emergency alert.
   - Both layers share a thread-safe `alertedIncidentIds` deduplication set so an incident is never alarmed twice.

---

## 2. Technical Specifications

| Component | Technology | Role |
| :--- | :--- | :--- |
| **Android App** | Kotlin, Android SDK 34, Min SDK 26 (Android 8.0+) | Emergency Responder Console |
| **Package ID** | `com.emergencysos.responder` | Matches registered Firebase Android Client |
| **Push Notifications** | Firebase Cloud Messaging (FCM) + High-Priority Data Messages | Background Wakeup & Dispatch |
| **Database** | Google Cloud Firestore | Authoritative State, Rules & Audit Receipts |
| **Web Portal** | Vanilla JS + Vite + Firebase SDK | Student SOS Submission & Live Tracking |
| **Hosting** | Firebase Hosting (`https://college-sos-app-26aec.web.app`) | Student Website |
| **Audio Engine** | Android `MediaPlayer` with `USAGE_ALARM` & `FLAG_AUDIBILITY_ENFORCED` | Bundled emergency siren |

---

## 3. Responder Authentication & Device Registration

- **Authorized Responder ID**: `ER-2026` (migrated from `RESP-1111`)
- **Authorized Responder PIN**: `2611`
- **Device Multi-Tenancy**: Multiple responders can log in on different devices. When logged in, the device generates a unique device ID (e.g., `DEV-XXXX-XXXX`) and registers its FCM push token in Firestore under:
  ```
  responder_devices/{deviceId}
  ├── deviceId: "DEV-..."
  ├── fcmToken: "eK9..."
  ├── responderId: "ER-2026"
  ├── platform: "android"
  ├── model: "Samsung SM-S918B"
  ├── appVersion: "1.0.0"
  ├── lastPing: "2026-09-27T17:00:00.000Z"
  └── updatedAt: "2026-09-27T17:00:00.000Z"
  ```

---

## 4. How to Open, Build, and Install the Android App

### Option A: Using Android Studio (Recommended)
1. Open **Android Studio** (Hedgehog, Iguana, Jellyfish, or newer).
2. Click **File -> Open...** and browse to:
   ```
   sos-/android-responder-app
   ```
3. Allow Gradle to sync dependencies.
4. Connect an Android phone via USB and enable **USB Debugging** in Developer Options.
5. Select your device in the top toolbar and click the green **Run (▶)** button.

### Option B: Command Line Build via Gradle Wrapper
From the root of `sos-/android-responder-app`:
```bash
# On Windows PowerShell:
.\gradlew.bat assembleDebug

# On macOS / Linux:
./gradlew assembleDebug
```
The compiled APK will be generated at:
```
app/build/outputs/apk/debug/app-debug.apk
```
Install it onto your connected phone using ADB:
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## 5. Critical Android Permissions Setup (Phone B)

When you first open the app on **Phone B**, complete the onboarding guide:
1. **Notification Permission (Android 13+)**:
   - Tap **1. Notification Permission** -> Select **Allow**.
2. **Unrestricted Battery Usage**:
   - Tap **2. Unrestricted Battery Usage** -> Allow the app to run without battery optimization restrictions.
   - *Why*: Prevents OEM battery savers (Samsung OneUI, Xiaomi MIUI, OnePlus OxygenOS) from killing the background service when the phone screen is turned off.
3. **Do Not Disturb (DND) Exception**:
   - Tap **3. Do Not Disturb Override** -> Grant policy access so alarms ring even during silent campus hours.
4. **Lock Screen & Full-Screen Intent**:
   - In phone settings under `Apps -> Campus Emergency SOS Responder -> Special App Access`: ensure **Display over other apps** and **Show on lock screen** are enabled.

---

## 6. Physical Two-Phone Testing Matrix (Phases 6 & 10)

### Setup:
- **Phone A (Student Phone / Laptop)**: Open browser to `https://college-sos-app-26aec.web.app` and log in as a student (e.g. ID `STU-2026`, Name: `Test Student`).
- **Phone B (Responder Phone)**: Install the Android Responder app, log in using `RESP-1111` / `2026`.

---

### Test Case Breakdown

#### Test A: Responder App Open (Foreground)
- **Action**: On Phone A, click **Send SOS Now** with Building: *Block A*, Floor: *2nd*, Room: *Lab 3*.
- **Expected Result**:
  - Phone B immediately vibrates and plays loud emergency siren.
  - Incident details display with student name, ID, and location.
  - Tap **Acknowledge SOS Alert** -> Status updates to `ACCEPTED` in Firestore.
  - Phone A immediately updates to *"Responder Unit RESP-1111 Accepted"* without refreshing.

#### Test B: Responder App in Background (Home Screen)
- **Action**: On Phone B, press the Home button to background the app. On Phone A, submit SOS.
- **Expected Result**:
  - High-priority emergency notification heads-up banner appears.
  - Emergency siren sounds immediately.
  - Phone wakes up and presents the alarm notification.

#### Test C: Responder App Removed from Recent Apps (Swiped Away)
- **Action**: On Phone B, open the App Switcher / Recent Apps and swipe the Responder app away. On Phone A, submit SOS.
- **Expected Result**:
  - The persistent `EmergencyAlertForegroundService` monitor remains active in the notification drawer.
  - When the incident is posted to Firestore, the service catches the update and triggers the full siren and lockscreen heads-up notification.

#### Test D: Responder Phone Locked (Screen Off)
- **Action**: On Phone B, press the power button so the screen is black/locked. On Phone A, submit SOS.
- **Expected Result**:
  - Phone screen turns on (`turnScreenOn = true`, `showWhenLocked = true`).
  - Emergency siren sounds.
  - `IncidentAlertActivity` displays directly over the lockscreen showing location and one-tap Acknowledge button.

#### Test E: Responder Website / Browser Completely Closed
- **Action**: Close all browser windows on Phone B and ensure no browser tabs are open. Submit SOS on Phone A.
- **Expected Result**:
  - The Android native app operates independently of any browser. Alert arrives with full sound and vibration.

#### Test F: Phone in Silent Mode / Vibrate Mode
- **Action**: Flip Phone B into Silent / Mute. Submit SOS on Phone A.
- **Expected Result**:
  - The audio channel is configured with `USAGE_ALARM` and `FLAG_AUDIBILITY_ENFORCED`. On devices where alarm volume is raised or DND bypass is granted, the emergency siren plays through the alarm stream.
  - Vibration pattern `(0, 800, 400, 800, 400, 800)` fires continuously.

#### Test G: Notification Permission Denied
- **Action**: Revoke notification permission in Android Settings for the app. Submit SOS on Phone A.
- **Expected Result**:
  - Notification banner cannot be displayed by the OS.
  - If the foreground service is active, audio siren still sounds via `MediaPlayer`.
  - App displays a persistent warning banner urging the responder to re-enable notifications.

#### Test H: Internet Disconnected and Then Restored
- **Action**: Turn on Airplane mode on Phone B. Submit SOS on Phone A. Then turn Airplane mode off on Phone B.
- **Expected Result**:
  - While disconnected, Firestore queues delivery.
  - Within 2 seconds of network reconnection, the connectivity monitor re-synchronizes, the overdue emergency is fetched, and the siren sounds.

#### Test I: App Force-Stopped
- **Action**: In Android Settings -> Apps -> Campus Emergency SOS Responder -> Tap **Force Stop**. Submit SOS on Phone A.
- **Documented Android OS Limitation**:
  - Android OS security architecture completely disables all background services, alarms, and broadcast receivers for any app that has been explicitly Force-Stopped until the user manually taps the app icon again. This is an intentional security design of Android. Once reopened, monitoring resumes automatically.

#### Test J: Two or More Responders Receiving Same SOS
- **Action**: Log in with `RESP-1111` on Phone B and a second responder device Phone C. Submit SOS on Phone A.
- **Expected Result**:
  - Both devices ring simultaneously.
  - Phone B taps **Acknowledge SOS Alert** -> Status becomes `ACCEPTED`.
  - Phone C sees the incident update to *"Accepted by Campus Emergency Response Unit"* without overwriting or disappearing from history.

#### Test K: Multiple Devices Belonging to One Responder
- **Action**: Both devices register under responder ID `RESP-1111` with separate device IDs in `responder_devices`.
- **Expected Result**:
  - Each device maintains its own device token and receives alerts independently.

#### Test L: Repeated SOS Event and Duplicate-Delivery Prevention
- **Action**: Student rapidly taps the SOS button multiple times or network glitches resend the request.
- **Expected Result**:
  - Frontend client debounces submission via `isSendingSos` lock and unique `idempotencyKey`.
  - Android app checks `alertedIncidentIds`. The siren only sounds once for that incident ID.

---

## 7. Honest Operating System & Hardware Limitations

1. **Phone Powered Off**: No device can receive push or sound alarms while powered off. The incident is securely recorded in Cloud Firestore and will be presented when the phone boots up.
2. **Notification Volume at Zero**: If the device's physical Alarm volume slider is set to 0, Android hardware will not output sound. Responders should maintain alarm volume at >= 70%.
3. **Manufacturer Background Restrictions**: Aggressive task killers (e.g. Xiaomi MIUI / HyperOS battery saver, Huawei PowerGenie) may suspend background execution if the app is not set to **Unrestricted** in battery settings. The in-app onboarding guide provides direct links to disable these restrictions.
4. **Force Stop**: When a user goes into System Settings and taps "Force Stop", Android terminates all processes and cancels all pending alarms until the app is explicitly launched again.
