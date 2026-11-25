# BLUEDROP Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Owner-Only Profile & PII Isolation**: A `users/{userId}` document contains PII (`email`, `photoUrl`, `displayName`). Only the authenticated, email-verified user whose `request.auth.uid == userId` may `get`, `create`, or `update` it. `list` on `/users` is strictly denied to prevent user enumeration.
2. **Owner-Only Synced Library**: Every `/users/{userId}/library/{itemId}` entry must have `uid == request.auth.uid` and can only be read, created, updated, or deleted by the verified parent user whose `/users/{userId}` profile exists (`exists(/databases/$(database)/documents/users/$(userId))`).
3. **Immutable Ownership & Timestamps**: `uid` and `createdAt` are immutable once written; `createdAt` and `updatedAt` must equal `request.time`.
4. **Non-PII Collective AI Brain**: `/visual_clip_knowledge/{cardId}` may never contain email or photo URLs; writes require `isSignedIn() && email_verified == true && authorUid == request.auth.uid`. Reads require verified sign-in. Updates are immutable (append-only learning cards); only the author may delete.
5. **Path ID & Payload Bounds**: Every document ID matches `^[a-zA-Z0-9_\\-]+$` (`<= 128` chars), and every string and list has explicit `.size()` boundaries.

## 2. The "Dirty Dozen" Attack Payloads (All Must Return PERMISSION_DENIED)
1. Unauthenticated read/write on `/users/{uid}`.
2. Authenticated user A reading user B's `/users/{userB}` profile (PII leak).
3. Unverified email (`email_verified == false`) attempting to create `/users/{uid}`.
4. Listing `/users` collection to scrape user emails.
5. Creating `/users/{uid}` with extra ghost field `isAdmin: true` (Shadow Field Attack).
6. Creating `/users/{uid}` with forged `uid: "victim"` instead of `request.auth.uid`.
7. Updating `/users/{uid}` to tamper with immutable `createdAt` or `uid`.
8. Creating `/users/{uid}` with client-forged past `createdAt` timestamp instead of `request.time`.
9. Injecting a 2000-character string into `displayName` or `itemId` path (Denial of Wallet / ID Poisoning).
10. Creating `/users/{uid}/library/{itemId}` with `avatarPalette` / array exceeding 6 entries or invalid `kind`.
11. User A attempting to list or write `/users/{userB}/library/{itemId}`.
12. Creating `/visual_clip_knowledge/{cardId}` with `authorUid` spoofed to another UID or with a ghost `email` field.
