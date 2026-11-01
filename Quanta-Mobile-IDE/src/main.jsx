import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import './index.css'
import App from './App.jsx'

const defaultClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const savedClientId = localStorage.getItem('googleClientId') || defaultClientId;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={savedClientId}>
      <App />
    </GoogleOAuthProvider>
  </StrictMode>,
)
