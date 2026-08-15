import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App.tsx'
import { startServiceWorker } from './ui/serviceWorker.ts'
import './styles.css'

const root = document.querySelector('#root')
if (!root) throw new Error('#root is missing from index.html')

// After the tree is described, before it is painted: registration is a network
// request and it should not compete with the first render.
startServiceWorker()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
