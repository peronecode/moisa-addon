# HTTPS with Caddy and Cloudflare (LAN / VPN only)

Stremio Web and some other clients refuse to install addons over plain HTTP
(mixed content), and the native apps do not trust self-signed or private CAs
without root. The simplest fix is a **real certificate from Let's Encrypt** on
a domain you control, served by a reverse proxy in front of the addon.

This guide uses [Caddy](https://caddyserver.com/) and the Cloudflare DNS-01
challenge. The services stay reachable **only from your LAN (or VPN)**: no
port forwarding is needed, because DNS-01 proves domain ownership through a
TXT record instead of an inbound HTTP request.

Replace `example.com` with your domain. Examples assume the addon is published
on port `8091` and TorrServer on `8090`; adjust to your setup.

## How it works

1. Caddy asks Let's Encrypt for a wildcard certificate (`*.example.com`).
2. Let's Encrypt asks for a TXT record `_acme-challenge.example.com`.
3. Caddy creates it through the Cloudflare API, the certificate is issued,
   and the record is removed. Renewal is automatic.
4. A single DNS record `*.example.com -> <LAN IP of the proxy host>` makes
   every subdomain resolve to the proxy. Only clients inside your network (or
   connected through your VPN) can actually reach that private address.

## Requirements

- A domain whose DNS is managed by Cloudflare.
- Docker and Docker Compose on the host that runs the addon.
- Ports 80 and 443 free on that host (stop Apache/nginx if they use them,
  or move them to another port and proxy to them).

## 1. Cloudflare

**API token:** My Profile -> API Tokens -> Create Token -> template
**Edit zone DNS**. Permissions: `Zone:DNS:Edit` (and `Zone:Zone:Read`).
Restrict it to the single zone you use. Do not use the Global API Key.

Check it:

```bash
curl -H "Authorization: Bearer <TOKEN>" \
  https://api.cloudflare.com/client/v4/user/tokens/verify
# expect "status":"active"
```

**DNS record:** add `*` type `A` pointing to the LAN IP of the host running
Caddy (for example `192.168.1.10`), proxy status **DNS only** (grey cloud).
Existing explicit records (public servers, VPN endpoint, etc.) keep working:
an explicit record always wins over the wildcard.

## 2. Files

```text
caddy/
  Dockerfile
  docker-compose.yml
  Caddyfile
  .env
```

`Dockerfile` (the official image does not include the Cloudflare plugin):

```dockerfile
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

`.env` (never commit it; `chmod 600 .env`):

```env
CF_API_TOKEN=<TOKEN>
```

`docker-compose.yml`:

```yaml
services:
  caddy:
    build: .
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    env_file: .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data:/data
      - ./config:/config
```

`extra_hosts` lets the container reach services published on the host.
If the addon runs in the same Compose network as Caddy, use its service name
instead of `host.docker.internal`.

`Caddyfile`:

```caddyfile
*.example.com {
    tls {
        dns cloudflare {env.CF_API_TOKEN}
        resolvers 1.1.1.1
    }

    @addon host addon.example.com
    handle @addon {
        reverse_proxy host.docker.internal:8091
    }

    @torr host torr.example.com
    handle @torr {
        reverse_proxy host.docker.internal:8090 {
            flush_interval -1
        }
    }

    handle {
        abort
    }
}
```

- `resolvers 1.1.1.1` makes Caddy verify the TXT record through a public
  resolver, so a local DNS server (router, Pi-hole) cannot break the check.
- `flush_interval -1` disables buffering for the TorrServer stream.
- The last `handle` drops requests for every hostname that is not listed.

## 3. Start

```bash
docker compose up -d --build
docker compose logs -f caddy
```

Wait for `certificate obtained successfully` (the first issuance can take
up to a minute).

## 4. Verify

From a machine on the LAN or connected via VPN:

```bash
curl -s https://addon.example.com/manifest.json
curl -s https://torr.example.com/echo      # prints the TorrServer version
```

Use a normal `GET` (not `curl -I`): TorrServer answers `HEAD /echo` with 404.

Then install the addon in Stremio with
`https://addon.example.com/manifest.json`, and set the TorrServer URL used
by the addon to `https://torr.example.com`. Do not mix an HTTPS addon with an
HTTP TorrServer URL; browsers block it as mixed content.

## Adding more services

Add a block and reload. No new DNS record or certificate is needed, the
wildcard already covers it:

```caddyfile
    @grafana host grafana.example.com
    handle @grafana {
        reverse_proxy host.docker.internal:3000
    }
```

```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Certificate is not issued | Check the token permissions and zone, keep `resolvers 1.1.1.1`, remove stale `_acme-challenge` TXT records |
| Hostname does not resolve on the client | DNS rebinding protection on the router or Pi-hole blocks public names that point to private IPs; add an exception for your domain |
| `502 Bad Gateway` | The container cannot reach the backend: check the port, that the service listens on `0.0.0.0` (not only `127.0.0.1`), and that the firewall allows the Docker subnet (`172.16.0.0/12`) |
| Backend itself speaks HTTPS | Use `reverse_proxy https://host:port` and, for self-signed backends, `transport http { tls_insecure_skip_verify }` |
| Edits to `Caddyfile` are ignored | Edit the file in place; tools that replace it (new inode) break the single-file bind mount. Recreate the container if that happens |

## Security notes

- Keep the Cloudflare token scoped to one zone and out of version control.
- `data/` holds the private keys; keep it private and back it up.
- The wildcard record is public DNS: it exposes the existence of the
  subdomains and your LAN IP, but not access to them. Do not forward ports 80
  or 443 from the internet unless you add authentication.
- TorrServer has no authentication by default. Keep it LAN/VPN-only.
