declare module 'firebase/app' {
  export function initializeApp(config: any): any;
  export function getApps(): any[];
  export type FirebaseApp = any;
}
declare module 'firebase/auth' {
  export function getAuth(app?: any): any;
  export function signInWithCustomToken(auth: any, token: string): Promise<any>;
  export function signOut(auth: any): Promise<void>;
  export function onAuthStateChanged(auth: any, callback: (user: any) => void): () => void;
  export type User = any;
  export function signInWithEmailAndPassword(...args: any[]): any;
  export function signInWithPopup(...args: any[]): any;
  export class GoogleAuthProvider { constructor(); }
  export type Auth = any;
}
