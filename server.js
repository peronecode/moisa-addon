const http = require('http');
const handler = require('./src/http/moisaHandler');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  handler(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(
    `Moisa addon running on http://${HOST}:${PORT}/manifest.json`
  );
});
