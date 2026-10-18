"use client";

/**
 * Firebase browser SDK (client-safe). Only the public web configuration is
 * used here — Admin SDK credentials never reach this code.
 */
import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as fbSignOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth";

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function initFirebaseClient(config: FirebaseWebConfig): Auth {
  if (auth) return auth;
  if (!getApps().length) {
    app = initializeApp(config);
  } else {
    app = getApps()[0];
  }
  auth = getAuth(app);
  return auth;
}

export async function fetchFirebaseWebConfig(): Promise<{ configured: boolean; config: FirebaseWebConfig | null }> {
  const res = await fetch("/api/v1/app/config");
  const body = await res.json();
  return {
    configured: Boolean(body?.data?.firebaseWebConfigured),
    config: body?.data?.firebase ?? null,
  };
}

export async function signInWithGoogle(): Promise<User> {
  const a = auth ?? (() => {
    throw new Error("Firebase client not initialized");
  })();
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(a, provider);
  return cred.user;
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  const a = auth ?? (() => {
    throw new Error("Firebase client not initialized");
  })();
  const cred = await signInWithEmailAndPassword(a, email, password);
  return cred.user;
}

export async function signOut(): Promise<void> {
  if (auth) await fbSignOut(auth);
}

export function watchAuth(cb: (user: User | null) => void): () => void {
  const a = auth ?? (() => {
    throw new Error("Firebase client not initialized");
  })();
  return onAuthStateChanged(a, cb);
}
