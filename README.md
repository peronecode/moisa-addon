<p>
  <img src="assets/moisa-addon-icon-180.png" alt="Moisa addon logo" width="180" />
</p>

## Moisa – Stremio addon

### Local usage (npm)

- **Install dependencies**:

```bash
npm install
```

- **Run locally**:

```bash
npm start
```

- **Stremio manifest URL** (from the same machine):

```text
http://127.0.0.1:8080/manifest.json
```

Make sure you have a reachable TorrServer when using the addon locally.

### Docker + docker-compose

- **Start Moisa and TorrServer together**:

```bash
docker-compose up -d
```

- **Local manifest URL from the host**:

```text
http://127.0.0.1:8080/manifest.json
```

TorrServer will be available on port `8090` on the host at the same time.

### Hosted addon on Vercel

- **Public addon host**: `https://moisa-addon.vercel.app/`
- **Manifest URL for Stremio**:

```text
https://moisa-addon.vercel.app/manifest.json
```

### Configure page

The configure page is available at `https://moisa-addon.vercel.app/` (or `/configure`).

- **TorrServer URL**: enter your TorrServer base URL (for example `http://192.168.x.x:8090`).
- **Torrentio quality filter**: optionally set a custom `qualityfilter=...` string.
- Click **Generate addon URL** and use the output as the **Install addon** URL in Stremio, or click **Install in Stremio** to open it directly.

### Flows

#### Flow 1 – Direct Torrentio usage in Stremio

```mermaid
sequenceDiagram
    participant U as Usuário
    participant S as Stremio
    participant T as Torrentio Addon(API)

    %% Discovery / Catalog
    U->>S: Abre aba de catálogos
    S->>T: GET /catalog/{type}/{id}?extra=...
    T-->>S: Lista de itens (filmes/séries, IDs, posters, etc.)
    S-->>U: Mostra catálogo na UI

    %% Streams / Magnets
    U->>S: Clica em "Assistir" em um item
    S->>T: GET /stream/{type}/{id}.json
    T-->>S: Lista de streams (magnet URLs, infoHash, fileIdx, etc.)
    S->>S: Escolhe um stream/magnet
    S->>S: Passa magnet para o player/engine de torrent interno
    S-->>U: Reproduz vídeo via engine de torrent
```

#### Flow 2 – Proxy-based stream redirection to local TorrServer

```mermaid
sequenceDiagram
    participant U as Usuário
    participant S as Stremio
    participant P as Serviço Proxy (addon)
    participant T as Torrentio Addon(API)
    participant R as TorrServer Local

    %% Catalog (from Torrentio or other addons)
    U->>S: Navega no catálogo
    S->>T: GET /catalog/{type}/{id}?extra=...
    T-->>S: Lista de itens
    S-->>U: Mostra catálogo

    %% Streams via proxy
    U->>S: Clica em "Assistir"
    S->>P: GET /stream/{type}/{id}.json
    P->>T: GET /stream/{type}/{id}.json
    T-->>P: Lista de candidatos (infoHash, fileIdx, etc.)
    P-->>S: Lista de streams com URLs /play?infoHash=...

    %% Redirecting to TorrServer
    U->>S: Dá play em um dos streams
    S->>P: GET /play?infoHash=...&fileIndex=...
    P->>R: (opcional) prepara/valida, monta /stream?link=infoHash&index=...
    P-->>S: HTTP 302 Location: http://torrserver/stream?link=...&index=...
    S->>R: Faz requisição direta à URL de streaming
    R-->>S: Fluxo de vídeo
    S-->>U: Reproduz vídeo vindo do TorrServer local
```
