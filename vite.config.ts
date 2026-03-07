import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import http from 'http'
import https from 'https'
import { URL } from 'url'

const defaultTarget = process.env.HIVE_API_URL || 'http://localhost:3000'

/**
 * Dynamic proxy plugin for Hive.
 * - Proxies /api/* to the current target server (strips /api prefix)
 * - GET  /__hive__/config  — returns current target
 * - POST /__hive__/config  — changes target at runtime (no restart needed)
 */
function hiveDynamicProxy(): Plugin {
  let currentTarget = defaultTarget

  return {
    name: 'hive-dynamic-proxy',
    configureServer(server) {
      // Config endpoint: get/set the proxy target at runtime
      server.middlewares.use('/__hive__/config', (req, res) => {
        res.setHeader('Content-Type', 'application/json')

        if (req.method === 'GET') {
          res.end(JSON.stringify({ target: currentTarget, default: defaultTarget }))
          return
        }

        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk: string) => { body += chunk })
          req.on('end', () => {
            try {
              const { target } = JSON.parse(body)
              if (target) {
                currentTarget = target.replace(/\/+$/, '')
                console.log(`[hive] Proxy target changed to: ${currentTarget}`)
                res.end(JSON.stringify({ target: currentTarget, ok: true }))
              } else {
                res.statusCode = 400
                res.end(JSON.stringify({ error: 'Missing target' }))
              }
            } catch {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Invalid JSON' }))
            }
          })
          return
        }

        res.statusCode = 405
        res.end(JSON.stringify({ error: 'Method not allowed' }))
      })

      // Dynamic proxy for /api/* requests
      server.middlewares.use('/api', (req, res) => {
        const targetUrl = new URL(currentTarget)
        // Strip /api prefix from the path
        const path = (req.url || '').replace(/^\/api/, '') || '/'

        const isHttps = targetUrl.protocol === 'https:'
        const transport = isHttps ? https : http

        const proxyReq = transport.request(
          {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (isHttps ? 443 : 80),
            path,
            method: req.method,
            headers: {
              ...req.headers,
              host: targetUrl.host,
            },
          },
          (proxyRes) => {
            // Forward CORS-safe response
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
            proxyRes.pipe(res)
          }
        )

        proxyReq.on('error', (err) => {
          console.error(`[hive] Proxy error -> ${currentTarget}${path}:`, err.message)
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Proxy error: ${err.message}`, target: currentTarget }))
        })

        req.pipe(proxyReq)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), hiveDynamicProxy()],
  define: {
    __HIVE_DEFAULT_SERVER__: JSON.stringify(defaultTarget),
  },
  server: {
    port: 5173,
    // No static proxy config needed — the plugin handles /api/* dynamically
  },
})
