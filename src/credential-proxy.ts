/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Proxy injects Authorization: Bearer <token> on every request.
 *             For SDK containers that send x-api-key: placeholder, the proxy
 *             strips the placeholder and adds the Bearer token instead.
 *             For CLI containers that send their own Authorization header,
 *             the proxy replaces it with the real OAuth token.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Read upstream URL once at startup (doesn't change at runtime)
  const initSecrets = readEnvFile(['ANTHROPIC_BASE_URL']);
  const upstreamUrl = new URL(
    initSecrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Detect initial auth mode for startup log
  const initAuthMode = readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY
    ? 'api-key'
    : 'oauth';

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Re-read credentials on each request — picks up refreshed OAuth
        // tokens without requiring a proxy restart. The .env file is <1KB;
        // this read is negligible compared to the HTTPS proxy overhead.
        const secrets = readEnvFile([
          'ANTHROPIC_API_KEY',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'ANTHROPIC_AUTH_TOKEN',
        ]);
        const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
          ? 'api-key'
          : 'oauth';
        const oauthToken =
          secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: inject Authorization: Bearer on every request.
          // 1) CLI containers send Authorization: Bearer placeholder →
          //    replace with real OAuth token.
          // 2) SDK containers send x-api-key: placeholder (no Authorization) →
          //    strip placeholder x-api-key, add real Bearer token.
          // 3) Post-exchange requests carry a real x-api-key (temp key from
          //    CLI exchange) → pass through as-is.
          if (headers['x-api-key'] === 'placeholder') {
            delete headers['x-api-key'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          } else if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode: initAuthMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
