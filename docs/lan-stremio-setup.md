# LAN Setup Guide — Moisa addon + Stremio desktop over HTTPS

Stremio desktop loads its UI from `https://app.strem.io`. Because the page is
served over HTTPS, the browser blocks `fetch()` to plain-HTTP addon URLs
(**mixed content**). Any self-hosted addon on a LAN therefore needs a valid TLS
certificate that the embedded Chromium trusts.

This guide shows how to set up a local HTTPS reverse proxy so Stremio can
install and query Moisa on your LAN.

---

## Architecture

```
Stremio desktop (QtWebEngine on https://app.strem.io)
        │
        │  install + stream: fetch https://<LAN_IP>:8443/<config>/manifest.json
        ▼
nginx TLS sidecar  :8443  ──proxy──►  moisa-addon :8091 (plain HTTP, Docker)
        │                                   │
        │  /play → 302                      │  /stream → fetch Torrentio
        ▼                                   ▼
TorrServer http://<LAN_IP>:8090        https://torrentio.strem.fun
        │
        ▼
video bytes → Stremio player (mpv)
```

| Service        | URL                                    | Notes                                     |
|----------------|----------------------------------------|-------------------------------------------|
| Moisa (HTTP)   | `http://<LAN_IP>:8091`                 | Docker container `moisa-addon`            |
| Moisa (HTTPS)  | `https://<LAN_IP>:8443`               | nginx container `moisa-https` — **use this** |
| TorrServer     | `http://<LAN_IP>:8090`                | your own instance                         |
| Configure page | `https://<LAN_IP>:8443/configure`     | start here when installing in Stremio     |

Replace `<LAN_IP>` with your server's LAN address (e.g. `192.168.1.100`).

---

## Prerequisites

- Docker and Docker Compose
- Moisa addon running in Docker (see main README)
- TorrServer running on the same or another LAN host
- [mkcert](https://github.com/FiloSottile/mkcert) (single binary, no sudo
  needed for certificate generation)

---

## Step 1 — Generate a local CA and certificate

```bash
# Install mkcert (one-time)
# See https://github.com/FiloSottile/mkcert#installation

# Generate certificate for your LAN IP
mkdir -p ~/.moisa-certs
mkcert -cert-file ~/.moisa-certs/cert.pem \
       -key-file  ~/.moisa-certs/key.pem \
       <LAN_IP> localhost 127.0.0.1
```

## Step 2 — Trust the CA

Stremio desktop uses QtWebEngine (Chromium). On Linux it reads the NSS
certificate database:

```bash
# Trust for QtWebEngine / Chromium (required)
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," \
         -n "mkcert root CA" \
         -i "$(mkcert -CAROOT)/rootCA.pem"

# Trust system-wide — also covers curl, mpv, Firefox (requires sudo)
mkcert -install
```

> **Note:** If you skip the system-wide trust (`mkcert -install`), playback
> URLs should use plain HTTP (see "Why `/play` stays HTTP" below), because
> mpv/ffmpeg verify certificates against the system store.

## Step 3 — Add the nginx TLS sidecar

Add this service to your `docker-compose.yml`:

```yaml
  moisa-https:
    image: nginx:1.27-alpine
    container_name: moisa-https
    depends_on: [moisa]
    ports: ["8443:8443"]
    volumes:
      - ./nginx-https.conf:/etc/nginx/conf.d/default.conf:ro
      - ~/.moisa-certs:/certs:ro
    restart: unless-stopped
```

The [`nginx-https.conf`](../nginx-https.conf) in this repository terminates TLS
on `:8443` and proxies to the addon container on `:8080`.

```bash
docker compose up -d
```

## Step 4 — Install the addon

1. Open **`https://<LAN_IP>:8443/configure`** in a browser
2. Enter your TorrServer URL: `http://<LAN_IP>:8090`
3. Click **Generate addon URL**
4. Verify the URL looks like: `https://<LAN_IP>:8443/<base64>/manifest.json`
5. Click **Install in Stremio** → confirm in the Stremio dialog

---

## Why `/play` stays plain HTTP

Set `SELF_BASE_URL=http://<LAN_IP>:8091` in the moisa container so that
`/play` URLs use plain HTTP:

- **Installation** needs HTTPS (Chromium mixed-content rules)
- **Playback** is performed by Stremio's local player (mpv/libmpv) and the
  streaming server, which do not run under mixed-content rules and would
  otherwise have to trust the mkcert CA

So: install over `:8443`, playback over `:8091` → `302` → TorrServer `:8090`.

---

## Verification

```bash
# TLS manifest (should return 200 and the manifest JSON)
curl --cacert "$(mkcert -CAROOT)/rootCA.pem" \
     https://<LAN_IP>:8443/manifest.json

# Streams with config
CFG=$(printf '%s' '{"torrserver":"http://<LAN_IP>:8090"}' | base64 -w0)
curl --cacert "$(mkcert -CAROOT)/rootCA.pem" \
     "https://<LAN_IP>:8443/${CFG}/stream/movie/tt0133093.json"

# nginx access log — should show /stream requests from Stremio
docker logs moisa-https
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `net_error -107` / `ERR_SSL_PROTOCOL_ERROR` on install | addon URL is plain `http://` | Use `https://<LAN_IP>:8443/configure` |
| `ERR_CERT_AUTHORITY_INVALID` | mkcert CA not trusted by QtWebEngine | Run `certutil` command from Step 2 |
| Addon installed but no streams appear | transportUrl has `?config=` query string | Reinstall — configure page now generates path-based URLs |
| Playback fails with cert error | mpv doesn't trust mkcert CA | Set `SELF_BASE_URL=http://...` (plain HTTP) for `/play` |
| Streams list empty | Torrentio unreachable or wrong TorrServer URL | Check `docker logs moisa-addon` |

---

## Certificate renewal

mkcert certificates are valid for ~2 years. To renew:

```bash
mkcert -cert-file ~/.moisa-certs/cert.pem \
       -key-file  ~/.moisa-certs/key.pem \
       <LAN_IP> localhost 127.0.0.1
docker restart moisa-https
```
