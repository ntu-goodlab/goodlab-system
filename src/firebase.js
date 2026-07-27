/**
 * GOODLAB — Firebase 初始化模組
 * Phase 4：集中管理 Firebase 連線，所有其他模組從此處引入 db、auth 等。
 */
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc, updateDoc, writeBatch, runTransaction, arrayUnion, query, where } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from 'firebase/auth';

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);
const provider = new GoogleAuthProvider();

// 統一匯出，讓其他模組可以直接引用
export {
    db, auth, provider,
    collection, onSnapshot, doc, setDoc, deleteDoc, updateDoc, writeBatch, runTransaction, arrayUnion, query, where,
    signInWithPopup, onAuthStateChanged, signOut
};
