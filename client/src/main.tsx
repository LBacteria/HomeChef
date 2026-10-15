import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './styles.css'
import './home.css'

// 前端入口。
const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('找不到 #root 挂载点')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
