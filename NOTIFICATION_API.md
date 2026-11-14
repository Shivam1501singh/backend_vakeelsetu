# VakeelSetu - Push Notification Integration Guide for App Developers

This document explains how Mobile (Flutter / React Native / Android / iOS) and Web developers should integrate with the VakeelSetu Backend Push Notification Service powered by **Firebase Cloud Messaging (FCM)**.

---

## 1. Quick Integration Checklist for App Developers

| Property | Value / Requirement |
| :--- | :--- |
| **Backend Base URL** | `https://your-api-domain/api/notifications` *(Alias: `/api/device-tokens`)* |
| **FCM Project ID** | `vakeel-setu-4c34c` |
| **Android Channel ID** | `vakeelsetu_notifications` *(Required for Android 8.0+)* |
| **Channel Name** | VakeelSetu Notifications |
| **Importance / Priority** | High / Priority 1 |
| **Sound** | `default` |
| **Click Action** | `FLUTTER_NOTIFICATION_CLICK` (or standard deep link handler) |

> ⚠️ **Important for Android Developers:**  
> Ensure your app creates an Android Notification Channel named **`vakeelsetu_notifications`** upon app launch. Otherwise, notifications may not pop up in the foreground or notification shade on Android 8.0+.

---

## 2. Notification Flow & App Lifecycle

```
[App Launched] 
       │
       ▼
[Request FCM Permission & Fetch Device Token]
       │
       ▼
[POST /api/notifications/register-token]  <-- Registered as GUEST or with Email
       │
       ▼
[User Logs In (Client / Advocate)]
       │
       ▼
[POST /api/notifications/register-token]  <-- Send with Bearer JWT (Links token to User ID)
       │
       ▼
[On Token Refresh Event (Firebase)]
       │
       ▼
[Re-send POST /api/notifications/register-token]
       │
       ▼
[User Logs Out]
       │
       ▼
[POST /api/notifications/unregister-token] <-- Removes token from active delivery list
```

---

## 3. API Endpoints

### 3.1 Register / Update Device Token

Call this API:
1. Immediately after obtaining the FCM token on app launch (guest mode).
2. Immediately after successful login/signup (to bind the token to the logged-in user).
3. Whenever Firebase fires the `onTokenRefresh` listener.

- **Endpoint:** `POST /api/notifications/register-token`
- **Headers:**
  - `Content-Type: application/json`
  - `Authorization: Bearer <ACCESS_TOKEN>` *(Optional: If logged in, pass token. Backend automatically maps `userId`, `email`, and `userType` from token)*

#### Request Body:
```json
{
  "token": "eX_ample_fcm_device_token_string_from_firebase...",
  "deviceType": "android",
  "userType": "USER",
  "userId": "optional-user-uuid",
  "email": "user@example.com"
}
```

#### Field Details:
| Field | Type | Required | Values / Description |
| :--- | :--- | :--- | :--- |
| `token` | `string` | **Yes** | The FCM registration token received from Firebase SDK. |
| `deviceType` | `string` | No | `android` (default), `ios`, or `web` |
| `userType` | `string` | No | `USER`, `ADVOCATE`, `ADMIN`, or `GUEST` (default: `USER`) |
| `userId` | `string` | No | User UUID (Auto-extracted if `Authorization` header is present). |
| `email` | `string` | No | User email (Auto-extracted if `Authorization` header is present). |

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Device token registered successfully",
  "data": {
    "id": "c1f7b8a0-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "userType": "USER",
    "deviceType": "android",
    "isActive": true
  }
}
```

---

### 3.2 Unregister Device Token (On Logout)

Call this API when the user logs out so that future notifications for this account are not delivered to this device.

- **Endpoint:** `POST /api/notifications/unregister-token`
- **Headers:**
  - `Content-Type: application/json`

#### Request Body:
```json
{
  "token": "eX_ample_fcm_device_token_string_from_firebase..."
}
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Device token unregistered successfully"
}
```

---

### 3.3 Test Push Notification (For Developers & QA)

Use this endpoint to instantly verify that your app receives notifications on a specific device token without having to trigger a booking or payment flow.

- **Endpoint:** `POST /api/notifications/test`
- **Headers:**
  - `Content-Type: application/json`

#### Request Body (Option A - Direct Token):
```json
{
  "token": "eX_ample_fcm_device_token_string_from_firebase...",
  "title": "VakeelSetu Test Notification",
  "body": "Hello Developer! Push notification is working perfectly.",
  "data": {
    "type": "TEST",
    "screen": "HOME",
    "customId": "12345"
  }
}
```

#### Request Body (Option B - By User Email):
```json
{
  "email": "client@example.com",
  "title": "Appointment Alert",
  "body": "Your legal consultation has been confirmed."
}
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "deliveredCount": 1,
  "tokensTargeted": 1,
  "message": "Test push notification sent successfully"
}
```

---

### 3.4 Notification Logs (Admin / Debugging)

- **Endpoint:** `GET /api/notifications/logs?page=1&limit=20`
- **Headers:**
  - `Authorization: Bearer <ADMIN_ACCESS_TOKEN>`

Returns paginated history of dispatched notifications, recipient emails, delivery status (`DELIVERED`, `FAILED`, `SIMULATED`), and timestamps.

---

## 4. Notification Payload Format Received by the App

When backend sends a notification, your mobile app receives the following structure:

### 4.1 Visual Notification (Foreground/Background Banner)
```json
{
  "title": "Appointment Confirmed",
  "body": "Your consultation with Adv. Rajesh Sharma is confirmed for tomorrow at 10:00 AM."
}
```

### 4.2 Data Payload (Key-Value Strings for In-App Routing / Navigation)
Every key and value in `data` is sent as a `string`:
```json
{
  "type": "BOOKING_CONFIRMED",
  "bookingId": "9d8b7a6c-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "advocateId": "4a3b2c1d-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "screen": "BOOKING_DETAILS"
}
```

### Recommended In-App Handling:
```dart
// Example Flutter Firebase Messaging handler
FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
  final data = message.data;
  if (data['screen'] == 'BOOKING_DETAILS') {
    Navigator.pushNamed(context, '/booking-details', arguments: data['bookingId']);
  }
});
```

---

## 5. Automated Events Triggered by Backend

The backend automatically sends push notifications during these lifecycle events:
1. **Client Booking Confirmation:** Triggered upon successful booking/payment.
2. **Advocate New Appointment Alert:** Triggered to notify advocate of a new appointment.
3. **Consultancy Status Updates:** Triggered on schedule/consultancy changes.

---

## 6. Common Issues & Troubleshooting

1. **Notification not appearing when app is in foreground?**
   - By default, Firebase suppresses system banner alerts while the app is in the foreground. Mobile developers must implement a foreground presentation handler (e.g. `flutter_local_notifications` or heads-up display options).
2. **Notification sound or channel missing on Android?**
   - Check if you created the notification channel with ID `vakeelsetu_notifications` before the message was received.
3. **`deliveredCount: 0` or invalid token?**
   - If the user reinstalled the app, the old FCM token becomes invalid. Ensure the app calls `/register-token` on every fresh install or `onTokenRefresh`.
   - The backend automatically detects stale tokens (`registration-token-not-registered`) and marks them inactive in the database.

