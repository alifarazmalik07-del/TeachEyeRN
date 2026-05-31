import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyB-OmLDkI7l8TfSV9p2N9y4rHPpTLh-TU4",
  authDomain: "tech-eye-a22c5.firebaseapp.com",
  databaseURL: "https://tech-eye-a22c5-default-rtdb.firebaseio.com",
  projectId: "tech-eye-a22c5",
  storageBucket: "tech-eye-a22c5.firebasestorage.app",
  messagingSenderId: "841924591301",
  appId: "1:841924591301:web:8edcda1d48959d2e04faac"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export default app;
