# Kotha Bolbo Storage Android SDK

This is a small Kotlin client for the Kotha Bolbo Storage Server API. It uses Firebase Authentication for each user's identity and the app-scoped `storageApiKey` from the downloaded JSON to bind requests to the registered app.

## 1. Add the config

In the admin dashboard, open **Applications → Download JSON**. Put the downloaded file at:

```
app/src/main/assets/kotha-bolbo-storage-server.json
```

The file contains Firebase web config, the registered app/package identity, `storageApiUrl`, and `storageApiKey`. Do not put Firebase Admin credentials or Google Drive OAuth tokens in an Android app.

## 2. Add dependencies

Use the versions already compatible with your app:

```kotlin
implementation(platform("com.google.firebase:firebase-bom:<your-firebase-bom-version>"))
implementation("com.google.firebase:firebase-auth")
implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:<your-coroutines-version>")
implementation("com.squareup.okhttp3:okhttp:<your-okhttp-version>")
```

The app must already configure Firebase and sign the user in. The SDK does not sign users in or replace Firebase Authentication.

## 3. Create the client

```kotlin
val configText = assets.open("kotha-bolbo-storage-server.json")
    .bufferedReader()
    .use { it.readText() }

val storage = KothaBolboStorage(
    config = org.json.JSONObject(configText),
    firebaseAuth = com.google.firebase.auth.FirebaseAuth.getInstance()
)
```

## 4. Available operations

Call from a coroutine:

- `upload(file, category, mimeType, displayName)` — creates an upload ticket, uploads the bytes to the provider, then confirms the upload.
- `listFiles(page, pageSize)` — returns the current user's app-scoped file metadata.
- `downloadTo(fileId, destinationFile)` — downloads a file to a local file.
- `delete(fileId)` — deletes the file and updates server-side quota.

Supported categories: `chat`, `voice`, `photo`, `video`, `other`.

## Important

This SDK has to be compiled and exercised in the consuming Android project before production use. The API also needs working Firebase server configuration, Realtime Database, and at least one connected/verified Google Drive account for upload tests. An app-scoped key identifies the registered application; Firebase ID tokens identify individual signed-in users.
