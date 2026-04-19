/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    At startup, proxy exchanges the OAuth token for a temp API key
 *             via /api/oauth/claude_cli/create_api_key.  Subsequent requests
 *             from SDK containers (x-api-key: placeholder) get the temp key
 *             injected.  CLI containers that send Authorization headers get
 *             the real OAuth token injected for their own exchange flow.
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

/**
 * Exchange an OAuth token for a temporary API key via the Anthropic
 * /api/oauth/claude_cli/create_api_key endpoint.
 */
function exchangeOAuthForApiKey(
  upstreamUrl: URL,
  oauthToken: string,
): Promise<string | null> {
  const isHttps = upstreamUrl.protocol === 'https:';
  const doRequest = isHttps ? httpsRequest : httpRequest;
  const body = JSON.stringify({ name: 'credential-proxy' });

  return new Promise((resolve) => {
    const req = doRequest(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: '/api/oauth/claude_cli/create_api_key',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${oauthToken}`,
          'content-length': Buffer.byteLength(body),
        },
      } as RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.api_key) {
              resolve(data.api_key);
            } else {
              logger.warn(
                { status: res.statusCode, data },
                'OAuth exchange: unexpected response',
              );
              resolve(null);
            }
          } catch {
            logger.warn(
              { status: res.statusCode },
              'OAuth exchange: failed to parse response',
            );
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth exchange: request failed');
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Cached temp API key obtained from OAuth exchange (OAuth mode only)
  let cachedApiKey: string | null = null;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
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
          // OAuth mode — two cases:
          // 1) CLI containers send Authorization header for their own exchange;
          //    replace placeholder with real OAuth token.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
          // 2) SDK containers (Python kata) send x-api-key: placeholder;
          //    replace with the temp API key obtained at startup.
          if (headers['x-api-key'] === 'placeholder' && cachedApiKey) {
            headers['x-api-key'] = cachedApiKey;
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
      logger.info({ port, host, authMode }, 'Credential proxy started');

      // In OAuth mode, exchange for a temp API key so SDK containers work
      if (authMode === 'oauth' && oauthToken) {
        exchangeOAuthForApiKey(upstreamUrl, oauthToken).then((key) => {
          if (key) {
            cachedApiKey = key;
            logger.info('OAuth exchange: obtained temp API key');
          } else {
            logger.warn(
              'OAuth exchange: failed — SDK containers will run in degraded mode',
            );
          }
        });
      }

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
